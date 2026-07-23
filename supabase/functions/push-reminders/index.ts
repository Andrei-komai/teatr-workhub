import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'
// @ts-ignore The npm package is compatible with the Edge Runtime.
import webpush from 'npm:web-push@3.6.7'

type CalendarRow = {
  id: string
  title: string
  event_type: 'rehearsal' | 'show' | 'other'
  event_date: string
  start_time: string
}

type ScheduleRow = {
  id: string
  event_date: string
  start_time: string
  teacher: string
  class_name: string
}

type PreferencesRow = {
  profile_id: string
  events_enabled: boolean
  classes_enabled: boolean
  messages_enabled: boolean
  reminder_minutes: number
}

type SubscriptionRow = {
  id: string
  profile_id: string
  endpoint: string
  p256dh: string
  auth: string
}

const APP_URL = 'https://andrei-komai.github.io/teatr-workhub/'
const MOSCOW_OFFSET = '+03:00'

function localDate(ms: number) {
  return new Date(ms + 3 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

function eventTimestamp(date: string, time: string) {
  return new Date(`${date}T${time.slice(0, 5)}:00${MOSCOW_OFFSET}`).getTime()
}

function eventMessage(item: CalendarRow) {
  const label = item.event_type === 'show' ? 'Показ' : item.event_type === 'rehearsal' ? 'Репетиция' : 'Событие'
  return {
    title: `Т.А.М. · ${label} через 2 часа`,
    body: `${label} «${item.title}» начнётся в ${item.start_time.slice(0, 5)}.`,
  }
}

function classMessage(item: ScheduleRow) {
  return {
    title: 'Т.А.М. · Класс через 2 часа',
    body: `Класс «${item.class_name}» начнётся в ${item.start_time.slice(0, 5)}${item.teacher ? `. Педагог: ${item.teacher}.` : '.'}`,
  }
}

export default {
async fetch(request: Request) {
  const cronSecret = Deno.env.get('CRON_SECRET')
  if (!cronSecret || request.headers.get('x-cron-secret') !== cronSecret) {
    return new Response('Unauthorized', { status: 401 })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const vapidPublicKey = Deno.env.get('VAPID_PUBLIC_KEY')
  const vapidPrivateKey = Deno.env.get('VAPID_PRIVATE_KEY')
  const vapidSubject = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:a.s.komow@gmail.com'

  if (!supabaseUrl || !serviceRoleKey || !vapidPublicKey || !vapidPrivateKey) {
    return Response.json({ error: 'Missing server configuration' }, { status: 500 })
  }

  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey)
  const db = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })
  const now = Date.now()
  const firstDate = localDate(now)
  const lastDate = localDate(now + 24 * 60 * 60 * 1000)

  const [eventsResult, classesResult, preferencesResult, subscriptionsResult] = await Promise.all([
    db.from('calendar_events').select('id,title,event_type,event_date,start_time').gte('event_date', firstDate).lte('event_date', lastDate),
    db.from('schedule_entries').select('id,event_date,start_time,teacher,class_name').gte('event_date', firstDate).lte('event_date', lastDate),
    db.from('notification_preferences').select('profile_id,events_enabled,classes_enabled,messages_enabled,reminder_minutes'),
    db.from('push_subscriptions').select('id,profile_id,endpoint,p256dh,auth'),
  ])

  const firstError = eventsResult.error || classesResult.error || preferencesResult.error || subscriptionsResult.error
  if (firstError) return Response.json({ error: firstError.message }, { status: 500 })

  const preferences = new Map((preferencesResult.data as PreferencesRow[]).map((item) => [item.profile_id, item]))
  const subscriptions = subscriptionsResult.data as SubscriptionRow[]
  const dueItems = [
    ...(eventsResult.data as CalendarRow[]).map((item) => ({
      sourceType: 'event' as const,
      sourceId: item.id,
      startsAt: eventTimestamp(item.event_date, item.start_time),
      message: eventMessage(item),
      enabled: (profileId: string) => preferences.get(profileId)?.events_enabled ?? true,
    })),
    ...(classesResult.data as ScheduleRow[]).map((item) => ({
      sourceType: 'class' as const,
      sourceId: item.id,
      startsAt: eventTimestamp(item.event_date, item.start_time),
      message: classMessage(item),
      enabled: (profileId: string) => preferences.get(profileId)?.classes_enabled ?? true,
    })),
  ].filter((item) => {
    const minutesUntil = (item.startsAt - now) / 60000
    return minutesUntil >= 118 && minutesUntil <= 122
  })

  let sent = 0
  let skipped = 0
  let failed = 0

  for (const item of dueItems) {
    for (const subscription of subscriptions) {
      if (!item.enabled(subscription.profile_id)) {
        skipped += 1
        continue
      }

      const scheduledFor = new Date(item.startsAt).toISOString()
      const { data: claim, error: claimError } = await db
        .from('notification_deliveries')
        .insert({
          profile_id: subscription.profile_id,
          subscription_id: subscription.id,
          source_type: item.sourceType,
          source_id: item.sourceId,
          scheduled_for: scheduledFor,
        })
        .select('id')
        .maybeSingle()

      if (claimError?.code === '23505') {
        skipped += 1
        continue
      }
      if (claimError || !claim) {
        failed += 1
        continue
      }

      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          JSON.stringify({
            title: item.message.title,
            body: item.message.body,
            url: APP_URL,
            tag: `${item.sourceType}-${item.sourceId}`,
          }),
          { TTL: 60 * 60 },
        )
        sent += 1
      } catch (error) {
        failed += 1
        const statusCode = Number((error as { statusCode?: number }).statusCode ?? 0)
        if (statusCode === 404 || statusCode === 410) {
          await db.from('push_subscriptions').delete().eq('id', subscription.id)
        }
        await db.from('notification_deliveries').delete().eq('id', claim.id)
      }
    }
  }

  return Response.json({ checked: dueItems.length, subscriptions: subscriptions.length, sent, skipped, failed })
},
}
