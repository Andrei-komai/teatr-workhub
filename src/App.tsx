import { FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { CalendarScreen, ScheduleScreen } from './CalendarScreen'
import type { CalendarAttachment, CalendarEvent, CalendarEventInput, ScheduleEntry, ScheduleEntryInput } from './CalendarScreen'
import { PERSONAL_SESSION_KEY, supabase } from './supabase'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

type Screen = 'hub' | 'auth' | 'collection' | 'form' | 'trash' | 'settings' | 'calendar' | 'schedule' | 'custom'
type Role = 'developer' | 'leader' | 'teacher' | 'admin' | 'participant'

type Attachment = { id: string; name: string; size: number; type: string; path?: string; file?: File }
type MaterialComment = { id: string; author: string; text: string; createdAt: number }
type Material = {
  id: string; source: string; sourceFiles: Attachment[]; category: string; categoryFiles: Attachment[]
  description: string; descriptionFiles: Attachment[]; authorId: string | null; createdAt: number
  pinned: boolean; reactions: Record<string, number>; comments: MaterialComment[]; deletedAt: number | null
}
type Participant = {
  id: string; userId: string | null; name: string; email: string; role: Role
  sections: string[]; status: 'active' | 'invited'; avatarPath: string | null; avatarUrl: string | null
}
type WorkspaceSection = {
  id: string; title: string; description: string; accessRoles: Role[]; enabled: boolean; sortOrder: number
}
type NotificationPreferences = {
  eventsEnabled: boolean
  classesEnabled: boolean
  messagesEnabled: boolean
  reminderMinutes: number
  deviceCount: number
}

const LEGACY_SESSION_KEY = 'tam-workhub-open'
const HUB_SESSION_KEY = 'tam-hub-session'
const REACTIONS = ['❤️', '👍', '🔥', '👏', '😁', '👎']
const DAY = 24 * 60 * 60 * 1000
const COLLECTION_SECTION = 'collection'
const CALENDAR_SECTION = 'calendar'
const SCHEDULE_SECTION = 'schedule'
const DEVELOPER_ID = '00000000-0000-0000-0000-000000000001'
const PUBLIC_APP_URL = 'https://andrei-komai.github.io/teatr-workhub/'
const VAPID_PUBLIC_KEY = 'BENd3hUj0b-6-mRiIH81DsxOoA8ALkqT_c9RVU6CJHmmf3jblkTeRvFNEyri15fbAjBFhDrtSP8Ngis38_ddfPc'
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
const STANDARD_UPLOAD_LIMIT = 6 * 1024 * 1024
const MAX_FILE_SIZE = 50 * 1024 * 1024
const CONTENT_MANAGER_ROLES: Role[] = ['developer', 'leader', 'teacher', 'admin']
const ROLE_LABELS: Record<Role, string> = { developer: 'Разраб', leader: 'Руководитель', teacher: 'Педагог', admin: 'Админ', participant: 'Участник' }
const ROLE_DESCRIPTIONS: Record<Role, string> = {
  developer: 'Техническое сопровождение и полный доступ ко всем настройкам.',
  leader: 'Полный доступ ко всем разделам, участникам, ролям и настройкам.',
  teacher: 'Работа с материалами, календарём и доступными по роли разделами.',
  admin: 'Работа с материалами, календарём и доступными по роли разделами.',
  participant: 'Работа в доступных разделах без удаления материалов.',
}

function mapNotificationPreferences(value: Record<string, unknown>): NotificationPreferences {
  return {
    eventsEnabled: value.events_enabled !== false,
    classesEnabled: value.classes_enabled !== false,
    messagesEnabled: value.messages_enabled !== false,
    reminderMinutes: Number(value.reminder_minutes ?? 120),
    deviceCount: Number(value.device_count ?? 0),
  }
}

function urlBase64ToUint8Array(value: string) {
  const padding = '='.repeat((4 - value.length % 4) % 4)
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  return Uint8Array.from(Array.from(raw, (character) => character.charCodeAt(0)))
}

function normalize(value: string) { return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru-RU') }
function titleCase(value: string) { const normalized = normalize(value); return normalized ? normalized[0].toLocaleUpperCase('ru-RU') + normalized.slice(1) : '' }
function formatSize(bytes: number) { if (!bytes) return ''; return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} КБ` : `${(bytes / 1024 / 1024).toFixed(1)} МБ` }
function fileListToAttachments(files: FileList | null): Attachment[] {
  return Array.from(files ?? []).map((file) => ({ id: crypto.randomUUID(), name: file.name, size: file.size, type: file.type || 'file', file }))
}

async function uploadStorageFile(bucket: string, path: string, file: File) {
  if (file.size > MAX_FILE_SIZE) throw new Error(`Файл «${file.name}» больше 50 МБ. На бесплатном тарифе такой файл загрузить нельзя.`)
  if (file.size <= STANDARD_UPLOAD_LIMIT) {
    const { error } = await supabase.storage.from(bucket).upload(path, file)
    if (error) throw error
    return
  }

  const personalToken = localStorage.getItem(PERSONAL_SESSION_KEY)
  const tus = await import('tus-js-client')
  await new Promise<void>((resolve, reject) => {
    const upload = new tus.Upload(file, {
      endpoint: `${SUPABASE_URL}/storage/v1/upload/resumable`,
      retryDelays: [0, 1000, 3000, 5000, 10000],
      chunkSize: STANDARD_UPLOAD_LIMIT,
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
        ...(personalToken ? { 'x-tam-session': personalToken } : {}),
      },
      metadata: {
        bucketName: bucket,
        objectName: path,
        contentType: file.type || 'application/octet-stream',
        cacheControl: '3600',
      },
      onError: reject,
      onSuccess: () => resolve(),
    })
    upload.start()
  })
}
function mapParticipant(row: Record<string, unknown>): Participant {
  return { id: String(row.id), userId: row.user_id ? String(row.user_id) : null, name: String(row.name), email: String(row.email), role: row.role as Role, sections: (row.sections as string[]) ?? [], status: row.status as 'active' | 'invited', avatarPath: row.avatar_path ? String(row.avatar_path) : null, avatarUrl: null }
}
async function withAvatarUrls(participants: Participant[]) {
  return Promise.all(participants.map(async (participant) => {
    if (!participant.avatarPath) return participant
    const { data, error } = await supabase.storage.from('avatars').createSignedUrl(participant.avatarPath, 60 * 60)
    return { ...participant, avatarUrl: error ? null : data.signedUrl }
  }))
}
function mapSection(row: Record<string, unknown>): WorkspaceSection {
  return { id: String(row.id), title: String(row.title), description: String(row.description ?? ''), accessRoles: (row.access_roles as Role[]) ?? [], enabled: Boolean(row.enabled), sortOrder: Number(row.sort_order ?? 0) }
}
function mapMaterial(row: Record<string, unknown>): Material {
  return {
    id: String(row.id), source: String(row.source), sourceFiles: (row.source_files as Attachment[]) ?? [], category: String(row.category),
    categoryFiles: (row.category_files as Attachment[]) ?? [], description: String(row.description), descriptionFiles: (row.description_files as Attachment[]) ?? [],
    authorId: row.author_id ? String(row.author_id) : null, createdAt: new Date(String(row.created_at)).getTime(), pinned: Boolean(row.pinned),
    reactions: (row.reactions as Record<string, number>) ?? {}, comments: (row.comments as MaterialComment[]) ?? [], deletedAt: row.deleted_at ? new Date(String(row.deleted_at)).getTime() : null,
  }
}
function mapCalendarEvent(row: Record<string, unknown>): CalendarEvent {
  return {
    id: String(row.id), title: String(row.title), eventType: String(row.event_type) as CalendarEvent['eventType'], eventDate: String(row.event_date),
    startTime: String(row.start_time), endTime: row.end_time ? String(row.end_time) : null, description: String(row.description ?? ''),
    attachments: (row.attachments as CalendarAttachment[]) ?? [], authorId: row.author_id ? String(row.author_id) : null, createdAt: new Date(String(row.created_at)).getTime(),
  }
}
function mapScheduleEntry(row: Record<string, unknown>): ScheduleEntry {
  return {
    id: String(row.id), eventDate: String(row.event_date), startTime: String(row.start_time), teacher: String(row.teacher),
    className: String(row.class_name), topic: String(row.topic ?? ''), absence: String(row.absence ?? ''),
    authorId: row.author_id ? String(row.author_id) : null, createdAt: new Date(String(row.created_at)).getTime(),
  }
}
function profileHasSectionAccess(targetProfile: Participant | null, sectionId: string, availableSections: WorkspaceSection[]) {
  if (!targetProfile) return false
  if (targetProfile.role === 'developer' || targetProfile.role === 'leader') return true
  const section = availableSections.find((item) => item.id === sectionId)
  return targetProfile.sections.includes(sectionId) || Boolean(section?.accessRoles.includes(targetProfile.role))
}

async function openAttachment(file: Attachment) {
  if (!file.path) return
  const { data, error } = await supabase.storage.from('materials').createSignedUrl(file.path, 60)
  if (!error && data?.signedUrl) window.open(data.signedUrl, '_blank', 'noopener,noreferrer')
}

function LinkifyText({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s]+)/gi)
  return <>{parts.map((part, index) => /^https?:\/\//i.test(part)
    ? <a className="inline-link" href={part} target="_blank" rel="noopener noreferrer" key={`${part}-${index}`}>{part}</a>
    : <span key={`${part}-${index}`}>{part}</span>)}</>
}

function AttachmentList({ files }: { files: Attachment[] }) {
  if (!files.length) return null
  return <div className="attachment-list">{files.map((file) => (
    <button className="attachment" type="button" key={file.id} onClick={() => openAttachment(file)} disabled={!file.path && !file.file}>
      <span aria-hidden="true">▣</span><span>{file.name}</span>{file.size > 0 && <small>{formatSize(file.size)}</small>}
    </button>
  ))}</div>
}

function ModuleIcon({ name }: { name: 'collection' | 'calendar' | 'settings' | 'schedule' | 'draft' | 'add' }) {
  const paths = {
    collection: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M8 3v18M16 3v18M3 8h18M3 16h18" /></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M7 3v4M17 3v4M3 10h18M7 14h2M11 14h2M15 14h2M7 18h2M11 18h2" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" /></>,
    schedule: <><circle cx="12" cy="13" r="8" /><path d="M12 9v5l3 2M8 3h8M9 21h6" /></>,
    draft: <><path d="M3 6h7l2 2h9v11H3z" /><path d="M3 10h18" /></>,
    add: <path d="M12 4v16M4 12h16" />,
  }
  return <span className="module-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg></span>
}

function ParticipantAvatar({ participant, editable, uploading, onSelect }: { participant: Participant; editable?: boolean; uploading?: boolean; onSelect?: (file: File) => void }) {
  const content = participant.avatarUrl ? <img src={participant.avatarUrl} alt="" /> : <span>{participant.name.slice(0, 1).toLocaleUpperCase('ru-RU')}</span>
  if (!editable) return <div className="participant-avatar">{content}</div>
  return <label className={`profile-avatar-picker${uploading ? ' uploading' : ''}`} title="Изменить личное фото">
    {content}<span className="profile-avatar-hint">{uploading ? '…' : 'Фото'}</span>
    <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" disabled={uploading} onChange={(event) => { const file = event.target.files?.[0]; if (file) onSelect?.(file); event.currentTarget.value = '' }} />
  </label>
}

function materialFilePaths(item: Material) {
  return Array.from(new Set([
    ...item.sourceFiles,
    ...item.categoryFiles,
    ...item.descriptionFiles,
  ].flatMap((file) => file.path ? [file.path] : [])))
}

function materialTitle(item: Material) {
  return item.source.trim() || item.sourceFiles[0]?.name || item.description.trim() || item.descriptionFiles[0]?.name || 'Материал'
}

function App() {
  const [hubAccess, setHubAccess] = useState<'checking' | 'locked' | 'unlocked'>('checking')
  const [passwordError, setPasswordError] = useState(false)
  const [session, setSession] = useState<Session | null>(null)
  const [personalSession, setPersonalSession] = useState(() => localStorage.getItem(PERSONAL_SESSION_KEY))
  const [profile, setProfile] = useState<Participant | null>(null)
  const [participants, setParticipants] = useState<Participant[]>([])
  const [materials, setMaterials] = useState<Material[]>([])
  const [sections, setSections] = useState<WorkspaceSection[]>([])
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([])
  const [scheduleEntries, setScheduleEntries] = useState<ScheduleEntry[]>([])
  const [screen, setScreen] = useState<Screen>('hub')
  const [returnScreen, setReturnScreen] = useState<Screen>('hub')
  const [query, setQuery] = useState('')
  const [activeFilters, setActiveFilters] = useState<string[]>([])
  const [reactionMenu, setReactionMenu] = useState<string | null>(null)
  const [openComments, setOpenComments] = useState<string | null>(null)
  const [editingMaterial, setEditingMaterial] = useState<Material | null>(null)
  const [authMessage, setAuthMessage] = useState('')
  const [appError, setAppError] = useState('')
  const [appNotice, setAppNotice] = useState('')
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [showInstallHelp, setShowInstallHelp] = useState(false)
  const [uploadingAvatar, setUploadingAvatar] = useState(false)
  const [activeSection, setActiveSection] = useState<WorkspaceSection | null>(null)
  const [showNotificationSettings, setShowNotificationSettings] = useState(false)
  const [notificationPreferences, setNotificationPreferences] = useState<NotificationPreferences | null>(null)
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>(() => 'Notification' in window ? Notification.permission : 'default')
  const [savingNotifications, setSavingNotifications] = useState(false)
  const [isInstalled, setIsInstalled] = useState(() => window.matchMedia('(display-mode: standalone)').matches || ('standalone' in navigator && Boolean((navigator as Navigator & { standalone?: boolean }).standalone)))

  useEffect(() => {
    if (!appError) return
    const timer = window.setTimeout(() => setAppError(''), 7000)
    return () => window.clearTimeout(timer)
  }, [appError])

  useEffect(() => {
    if (!appNotice) return
    const timer = window.setTimeout(() => setAppNotice(''), 4500)
    return () => window.clearTimeout(timer)
  }, [appNotice])

  const currentRole: Role = profile?.role ?? 'participant'
  const canManageMembers = currentRole === 'developer' || currentRole === 'leader'
  const canInvite = CONTENT_MANAGER_ROLES.includes(currentRole)
  const canDelete = CONTENT_MANAGER_ROLES.includes(currentRole)
  const canCreateSections = canManageMembers
  const scheduleSection = sections.find((section) => section.id === SCHEDULE_SECTION) ?? sections.find((section) => section.id !== COLLECTION_SECTION && section.id !== CALENDAR_SECTION && /расписан/i.test(section.title))
  const canOpenCollection = profileHasSectionAccess(profile, COLLECTION_SECTION, sections)
  const canOpenCalendar = profileHasSectionAccess(profile, CALENDAR_SECTION, sections)
  const canOpenSchedule = Boolean(scheduleSection && profileHasSectionAccess(profile, scheduleSection.id, sections))

  async function loadData(activeSession: Session | null = session, activePersonalSession: string | null = personalSession) {
    if (!activeSession?.user && !activePersonalSession) { setProfile(null); setParticipants([]); setMaterials([]); setSections([]); setCalendarEvents([]); setScheduleEntries([]); return }
    const { data: ownProfile, error: profileError } = await supabase.rpc('get_current_profile')
    if (profileError) { setAppError(profileError.message); return }
    setAppError('')
    const rawProfile = ownProfile ? mapParticipant(ownProfile as Record<string, unknown>) : null
    const mappedProfile = rawProfile ? (await withAvatarUrls([rawProfile]))[0] : null
    setProfile(mappedProfile)
    if (!mappedProfile) { setParticipants([]); setMaterials([]); setSections([]); setCalendarEvents([]); setScheduleEntries([]); return }
    const { data: sectionRows, error: sectionError } = await supabase.from('sections').select('*').order('sort_order')
    if (sectionError) setAppError(sectionError.message)
    else setSections((sectionRows ?? []).map(mapSection))
    const { data: eventRows, error: eventError } = await supabase.from('calendar_events').select('*').order('event_date').order('start_time')
    if (eventError && eventError.code !== 'PGRST205') setAppError(eventError.message)
    else setCalendarEvents((eventRows ?? []).map(mapCalendarEvent))
    const { data: scheduleRows, error: scheduleError } = await supabase.from('schedule_entries').select('*').order('event_date').order('start_time')
    if (scheduleError && scheduleError.code !== 'PGRST205') setAppError(scheduleError.message)
    else setScheduleEntries((scheduleRows ?? []).map(mapScheduleEntry))
    if (['developer', 'leader', 'teacher', 'admin'].includes(mappedProfile.role)) {
      const { data } = await supabase.from('profiles').select('*').order('created_at')
      setParticipants(await withAvatarUrls((data ?? []).map(mapParticipant)))
    } else setParticipants([mappedProfile])
    if (mappedProfile.role === 'developer' || mappedProfile.role === 'leader' || mappedProfile.sections.includes(COLLECTION_SECTION)) {
      const { data, error } = await supabase.from('materials').select('*').order('created_at')
      if (error) setAppError(error.message)
      else {
        const loadedMaterials = (data ?? []).map(mapMaterial)
        const canPurgeExpired = CONTENT_MANAGER_ROLES.includes(mappedProfile.role)
        const expiredMaterials = canPurgeExpired
          ? loadedMaterials.filter((item) => item.deletedAt && Date.now() - item.deletedAt >= 30 * DAY)
          : []
        const purgedIds = new Set<string>()

        for (const item of expiredMaterials) {
          const paths = materialFilePaths(item)
          if (paths.length) {
            const { error: storageError } = await supabase.storage.from('materials').remove(paths)
            if (storageError) continue
          }
          const { error: deleteError } = await supabase.rpc('delete_material_forever', { material_id: item.id })
          if (!deleteError) purgedIds.add(item.id)
        }

        setMaterials(loadedMaterials.filter((item) => !purgedIds.has(item.id)))
      }
    }
  }

  useEffect(() => {
    localStorage.removeItem(LEGACY_SESSION_KEY)
    sessionStorage.removeItem(LEGACY_SESSION_KEY)
    const token = localStorage.getItem(HUB_SESSION_KEY)
    if (!token) { setHubAccess('locked'); return }

    let cancelled = false
    supabase.rpc('validate_hub_session', { session_token: token }).then(({ data, error }) => {
      if (cancelled) return
      if (!error && data === true) setHubAccess('unlocked')
      else { localStorage.removeItem(HUB_SESSION_KEY); setHubAccess('locked') }
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); loadData(data.session, personalSession) })
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
      window.setTimeout(() => loadData(nextSession, personalSession), 0)
      if (nextSession && screen === 'auth') setScreen(returnScreen)
    })
    return () => listener.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    const captureInstallPrompt = (event: Event) => {
      event.preventDefault()
      setInstallPrompt(event as BeforeInstallPromptEvent)
    }
    const markInstalled = () => { setIsInstalled(true); setInstallPrompt(null); setShowInstallHelp(false) }
    window.addEventListener('beforeinstallprompt', captureInstallPrompt)
    window.addEventListener('appinstalled', markInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', captureInstallPrompt)
      window.removeEventListener('appinstalled', markInstalled)
    }
  }, [])

  useEffect(() => {
    if (!session && personalSession) {
      const timer = window.setInterval(() => loadData(null, personalSession), 30000)
      return () => window.clearInterval(timer)
    }
    if (!session) return
    const refreshTimer = window.setInterval(() => loadData(), 60 * 60 * 1000)
    const channel = supabase.channel('workhub-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'materials' }, () => loadData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, () => loadData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sections' }, () => loadData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'calendar_events' }, () => loadData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'schedule_entries' }, () => loadData())
      .subscribe()
    return () => { window.clearInterval(refreshTimer); supabase.removeChannel(channel) }
  }, [session?.user.id, personalSession, profile?.role])

  const activeMaterials = useMemo(() => materials.filter((item) => !item.deletedAt), [materials])
  const trashMaterials = useMemo(() => materials.filter((item) => item.deletedAt), [materials])
  const categories = useMemo(() => Array.from(new Map(activeMaterials.filter((item) => item.category.trim()).map((item) => [normalize(item.category), item.category])).values()).sort((a, b) => a.localeCompare(b, 'ru')), [activeMaterials])
  const filteredMaterials = useMemo(() => {
    const needle = normalize(query)
    return activeMaterials
      .filter((item) => !activeFilters.length || activeFilters.some((filter) => normalize(filter) === normalize(item.category)))
      .filter((item) => !needle || normalize([item.source, item.category, item.description, ...item.sourceFiles.map((f) => f.name), ...item.categoryFiles.map((f) => f.name), ...item.descriptionFiles.map((f) => f.name), ...item.comments.map((c) => c.text)].join(' ')).includes(needle))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.createdAt - b.createdAt)
  }, [activeMaterials, activeFilters, query])

  async function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPasswordError(false)
    const attempt = String(new FormData(event.currentTarget).get('password'))
    const { data, error } = await supabase.rpc('login_with_hub_password', { attempt })
    const response = data as { status?: string; token?: string } | null
    if (!error && response?.status === 'ok' && response.token) {
      localStorage.setItem(HUB_SESSION_KEY, response.token)
      setHubAccess('unlocked')
    } else setPasswordError(true)
  }
  async function signInWithPersonalPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setAuthMessage('')
    const form = event.currentTarget; const data = new FormData(form); const email = String(data.get('email')).trim(); const password = String(data.get('personalPassword'))
    const { data: result, error } = await supabase.rpc('login_with_personal_password', { login_email: email, attempt: password })
    if (error) { setAuthMessage('Не удалось проверить данные. Попробуйте ещё раз.'); return }
    const response = result as { status?: string; token?: string } | null
    if (response?.status === 'email_not_found') { setAuthMessage('Такой почты нет в организации. Обратитесь за доступом к администрации театра.'); return }
    if (response?.status === 'password_not_set') { setAuthMessage('Для этой почты ещё не задан личный пароль. Обратитесь к администрации театра.'); return }
    if (response?.status === 'wrong_password') { setAuthMessage('Неверный личный пароль.'); return }
    if (response?.status === 'locked') { setAuthMessage('Слишком много попыток. Повторите вход через 15 минут.'); return }
    if (response?.status !== 'ok' || !response.token) { setAuthMessage('Не удалось войти. Попробуйте ещё раз.'); return }
    localStorage.setItem(PERSONAL_SESSION_KEY, response.token); setPersonalSession(response.token); form.reset(); await loadData(session, response.token); setScreen(returnScreen)
  }
  async function logout() {
    if (personalSession) await supabase.rpc('logout_personal_session')
    localStorage.removeItem(PERSONAL_SESSION_KEY); setPersonalSession(null)
    if (session) await supabase.auth.signOut()
    setProfile(null); setParticipants([]); setMaterials([]); setSections([]); setCalendarEvents([]); setScheduleEntries([]); setScreen('hub')
  }
  function requireAccess(target: Screen) {
    if (!profile) { setReturnScreen(target); setScreen('auth'); return }
    if (target === 'collection' && !canOpenCollection) { setAppError('Для вашей роли пока нет доступа к копилке.'); return }
    if (target === 'calendar' && !canOpenCalendar) { setAppError('Для вашей роли нет доступа к календарю.'); return }
    if (target === 'schedule' && !canOpenSchedule) { setAppError('Для вашей роли нет доступа к расписанию.'); return }
    if (target === 'settings' && !canInvite) { setAppError('Для вашей роли нет доступа к настройкам участников.'); return }
    setScreen(target)
  }
  function openCustomSection(section: WorkspaceSection) {
    if (!profile) {
      setReturnScreen('hub')
      setAuthMessage('Войдите в личный профиль, чтобы открыть раздел.')
      setScreen('auth')
      return
    }
    if (!profileHasSectionAccess(profile, section.id, sections)) {
      setAppError('Для вашего профиля этот раздел недоступен.')
      return
    }
    setActiveSection(section)
    setScreen('custom')
  }
  async function uploadFiles(files: Attachment[], materialId: string, field: string) {
    const result: Attachment[] = []
    for (const attachment of files) {
      if (!attachment.file) { const { file: _file, ...stored } = attachment; result.push(stored); continue }
      const cleanName = attachment.name.replace(/[^a-zA-Zа-яА-ЯёЁ0-9._-]+/g, '-').slice(-100)
      const path = `${materialId}/${field}/${crypto.randomUUID()}-${cleanName}`
      await uploadStorageFile('materials', path, attachment.file)
      result.push({ id: attachment.id, name: attachment.name, size: attachment.size, type: attachment.type, path })
    }
    return result
  }
  async function saveMaterial(input: MaterialInput) {
    if (!profile) return
    try {
      const id = crypto.randomUUID(); const existing = categories.find((category) => normalize(category) === normalize(input.category)); const category = existing ?? titleCase(input.category)
      const [sourceFiles, categoryFiles, descriptionFiles] = await Promise.all([uploadFiles(input.sourceFiles, id, 'source'), uploadFiles(input.categoryFiles, id, 'category'), uploadFiles(input.descriptionFiles, id, 'description')])
      const { error } = await supabase.from('materials').insert({ id, source: input.source, source_files: sourceFiles, category, category_files: categoryFiles, description: input.description, description_files: descriptionFiles, author_id: profile.id })
      if (error) throw error; await loadData(); setScreen('collection')
    } catch (error) { setAppError(error instanceof Error ? error.message : 'Не удалось сохранить материал') }
  }
  async function updateMaterial(input: MaterialInput) {
    if (!editingMaterial) return
    try {
      const existing = categories.find((category) => normalize(category) === normalize(input.category)); const category = existing ?? titleCase(input.category)
      const [sourceFiles, categoryFiles, descriptionFiles] = await Promise.all([uploadFiles(input.sourceFiles, editingMaterial.id, 'source'), uploadFiles(input.categoryFiles, editingMaterial.id, 'category'), uploadFiles(input.descriptionFiles, editingMaterial.id, 'description')])
      const { error } = await supabase.from('materials').update({ source: input.source, source_files: sourceFiles, category, category_files: categoryFiles, description: input.description, description_files: descriptionFiles }).eq('id', editingMaterial.id)
      if (error) throw error; setEditingMaterial(null); await loadData(); setScreen('collection')
    } catch (error) { setAppError(error instanceof Error ? error.message : 'Не удалось обновить материал') }
  }
  async function togglePinned(id: string) { const item = materials.find((m) => m.id === id); if (!item) return; await supabase.from('materials').update({ pinned: !item.pinned }).eq('id', id); await loadData() }
  async function moveToTrash(id: string) {
    const item = materials.find((material) => material.id === id)
    if (!item || !window.confirm(`Переместить материал «${materialTitle(item)}» в корзину? Его можно будет восстановить в течение 30 дней.`)) return
    const { error } = await supabase.rpc('trash_material', { material_id: id })
    if (error) setAppError(error.message); else await loadData()
  }
  async function restore(id: string) { await supabase.rpc('restore_material', { material_id: id }); await loadData() }
  async function removeForever(id: string) {
    const item = materials.find((material) => material.id === id)
    if (!item || !window.confirm(`Удалить материал «${materialTitle(item)}» навсегда? Восстановить запись и прикреплённые файлы будет невозможно.`)) return
    const paths = materialFilePaths(item)
    if (paths.length) {
      const { error: storageError } = await supabase.storage.from('materials').remove(paths)
      if (storageError) { setAppError('Не удалось удалить прикреплённые файлы. Материал сохранён в корзине.'); return }
    }
    const { error } = await supabase.rpc('delete_material_forever', { material_id: id })
    if (error) setAppError(error.message); else await loadData()
  }
  async function react(id: string, emoji: string) {
    const { error } = await supabase.rpc('add_material_reaction', { material_id: id, reaction_emoji: emoji })
    if (error) setAppError(error.message); else { setReactionMenu(null); await loadData() }
  }
  async function addComment(id: string, commentText: string) {
    if (!commentText.trim()) return
    const { error } = await supabase.rpc('add_material_comment', { material_id: id, comment_text: commentText.trim() })
    if (error) setAppError(error.message); else await loadData()
  }
  async function inviteParticipant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!canInvite) return
    const form = event.currentTarget; const data = new FormData(form); const requestedRole = String(data.get('role')) as Role; const role: Role = canManageMembers ? requestedRole : 'participant'
    const { error } = await supabase.rpc('create_participant_with_password', {
      participant_name: String(data.get('name')).trim(), participant_email: String(data.get('email')).trim(), participant_role: role,
      participant_sections: [COLLECTION_SECTION], initial_password: String(data.get('personalPassword')),
    })
    if (error) {
      setAppError(error.message.includes('email_already_exists') ? 'Участник с такой почтой уже существует.' : error.message.includes('password_too_short') ? 'Личный пароль должен содержать не меньше 6 символов.' : 'Не удалось добавить участника.')
      return
    }
    setAppNotice('Участник добавлен. Сообщите ему почту и личный пароль.')
    form.reset(); await loadData()
  }
  async function setParticipantPassword(id: string, event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const password = String(new FormData(form).get('participantPassword'))
    const { error } = await supabase.rpc('set_participant_password', { target_profile_id: id, new_password: password })
    if (error) { setAppError(error.message.includes('password_too_short') ? 'Личный пароль должен содержать не меньше 6 символов.' : 'Не удалось изменить личный пароль.'); return }
    form.reset()
    if (id === profile?.id && personalSession) {
      localStorage.removeItem(PERSONAL_SESSION_KEY); setPersonalSession(null); setProfile(null); setScreen('auth'); setAuthMessage('Личный пароль изменён. Войдите с новым паролем.')
      return
    }
    setAppNotice(id === profile?.id ? 'Ваш личный пароль установлен.' : 'Личный пароль участника изменён. Старые входы закрыты.')
  }
  async function updateParticipant(id: string, changes: Partial<Participant>) {
    if (!canManageMembers || id === DEVELOPER_ID) return
    const payload: Record<string, unknown> = {}; if (changes.role) payload.role = changes.role; if (changes.sections) payload.sections = changes.sections
    const { error } = await supabase.from('profiles').update(payload).eq('id', id); if (error) setAppError(error.message); else await loadData()
  }
  async function removeParticipant(id: string) {
    if (!canManageMembers || id === DEVELOPER_ID) return
    const participant = participants.find((item) => item.id === id)
    if (!participant || !window.confirm(`Удалить участника «${participant.name}»? Его личный вход будет закрыт. Это действие нельзя отменить.`)) return
    const { error } = await supabase.from('profiles').delete().eq('id', id)
    if (error) setAppError(error.message); else await loadData()
  }
  async function copyInvitation(email?: string) { await navigator.clipboard.writeText(`Воркхаб Камерного театра-лаборатории Т.А.М.\n${PUBLIC_APP_URL}${email ? `\nВаша почта для входа: ${email}` : ''}\nВведите общий пароль, затем почту и личный пароль, который вам сообщит администрация театра.`) }
  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const value = String(new FormData(form).get('newPassword')).trim()
    const { data, error } = await supabase.rpc('change_hub_password', { new_password: value })
    const response = data as { status?: string; token?: string } | null
    if (error || response?.status !== 'ok' || !response.token) { setAppError(error?.message ?? 'Не удалось изменить общий пароль.'); return }
    localStorage.setItem(HUB_SESSION_KEY, response.token)
    form.reset(); setAppNotice('Общий пароль изменён. Все ранее открытые входы закрыты.')
  }

  async function installApp() {
    if (installPrompt) {
      await installPrompt.prompt()
      const choice = await installPrompt.userChoice
      if (choice.outcome === 'accepted') setInstallPrompt(null)
      return
    }
    setShowInstallHelp(true)
  }

  async function uploadOwnAvatar(file: File) {
    if (!profile || uploadingAvatar) return
    if (!file.type.startsWith('image/')) { setAppError('Можно выбрать только изображение.'); return }
    if (file.size > 5 * 1024 * 1024) { setAppError('Размер фотографии не должен превышать 5 МБ.'); return }
    setUploadingAvatar(true)
    const extension = file.name.split('.').pop()?.toLocaleLowerCase() || file.type.split('/')[1] || 'jpg'
    const path = `${profile.id}/avatar-${crypto.randomUUID()}.${extension.replace(/[^a-z0-9]/g, '')}`
    const { error: uploadError } = await supabase.storage.from('avatars').upload(path, file, { contentType: file.type, upsert: false })
    if (uploadError) { setAppError(uploadError.message); setUploadingAvatar(false); return }
    const { error: profileError } = await supabase.rpc('set_own_avatar', { new_avatar_path: path })
    if (profileError) { await supabase.storage.from('avatars').remove([path]); setAppError(profileError.message); setUploadingAvatar(false); return }
    if (profile.avatarPath) await supabase.storage.from('avatars').remove([profile.avatarPath])
    setAppNotice('Личная фотография обновлена')
    await loadData()
    setUploadingAvatar(false)
  }

  async function openNotificationSettings() {
    if (!profile) return
    setShowNotificationSettings(true)
    const { data, error } = await supabase.rpc('get_own_notification_settings')
    if (error) { setAppError(error.message); return }
    setNotificationPreferences(mapNotificationPreferences(data as Record<string, unknown>))
    if ('Notification' in window) setNotificationPermission(Notification.permission)
  }

  async function saveNotificationPreferences(next: NotificationPreferences) {
    if (!profile || savingNotifications) return
    setSavingNotifications(true)
    const { data, error } = await supabase.rpc('set_own_notification_preferences', {
      enable_events: next.eventsEnabled,
      enable_classes: next.classesEnabled,
      enable_messages: next.messagesEnabled,
    })
    setSavingNotifications(false)
    if (error) { setAppError(error.message); return }
    setNotificationPreferences(mapNotificationPreferences(data as Record<string, unknown>))
    setAppNotice('Настройки уведомлений сохранены')
  }

  async function enablePushNotifications() {
    if (!profile || savingNotifications) return
    if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
      setAppError('На этом устройстве системные уведомления не поддерживаются. На iPhone установите воркхаб на экран «Домой» и откройте его с иконки.')
      return
    }
    setSavingNotifications(true)
    try {
      const permission = await Notification.requestPermission()
      setNotificationPermission(permission)
      if (permission !== 'granted') {
        setAppError('Уведомления не разрешены. Их можно включить в настройках телефона.')
        return
      }
      const registration = await navigator.serviceWorker.ready
      const existing = await registration.pushManager.getSubscription()
      const subscription = existing ?? await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      })
      const json = subscription.toJSON()
      if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error('Не удалось получить данные устройства.')
      const { error } = await supabase.rpc('save_own_push_subscription', {
        subscription_endpoint: json.endpoint,
        subscription_p256dh: json.keys.p256dh,
        subscription_auth: json.keys.auth,
        subscription_user_agent: navigator.userAgent,
      })
      if (error) throw error
      const { data } = await supabase.rpc('get_own_notification_settings')
      if (data) setNotificationPreferences(mapNotificationPreferences(data as Record<string, unknown>))
      setAppNotice('Системные уведомления включены на этом устройстве')
    } catch (error) {
      setAppError(error instanceof Error ? error.message : 'Не удалось включить уведомления.')
    } finally {
      setSavingNotifications(false)
    }
  }

  async function disablePushNotifications() {
    if (!profile || savingNotifications || !('serviceWorker' in navigator)) return
    setSavingNotifications(true)
    try {
      const registration = await navigator.serviceWorker.ready
      const subscription = await registration.pushManager.getSubscription()
      if (subscription) {
        await supabase.rpc('remove_own_push_subscription', { subscription_endpoint: subscription.endpoint })
        await subscription.unsubscribe()
      }
      const { data } = await supabase.rpc('get_own_notification_settings')
      if (data) setNotificationPreferences(mapNotificationPreferences(data as Record<string, unknown>))
      setNotificationPermission('default')
      setAppNotice('Уведомления на этом устройстве отключены')
    } catch (error) {
      setAppError(error instanceof Error ? error.message : 'Не удалось отключить уведомления.')
    } finally {
      setSavingNotifications(false)
    }
  }

  async function createSection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canCreateSections) return false
    const form = new FormData(event.currentTarget)
    const title = String(form.get('sectionTitle') ?? '').trim().replace(/\s+/g, ' ')
    const description = String(form.get('sectionDescription') ?? '').trim().replace(/\s+/g, ' ')
    if (title.length < 2) { setAppError('Введите название раздела'); return false }
    if (sections.some((section) => normalize(section.title) === normalize(title))) { setAppError('Раздел с таким названием уже есть'); return false }

    const nextSortOrder = Math.max(0, ...sections.map((section) => section.sortOrder)) + 1
    const { error } = await supabase.from('sections').insert({
      id: `draft-${crypto.randomUUID()}`,
      title,
      description: description || 'Раздел в подготовке',
      access_roles: ['developer', 'leader'],
      enabled: false,
      sort_order: nextSortOrder,
    })
    if (error) { setAppError(error.message); return false }
    setAppError('')
    setAppNotice(`Раздел «${title}» добавлен как заготовка`)
    await loadData()
    return true
  }

  async function updateSection(id: string, event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canManageMembers) return false
    const data = new FormData(event.currentTarget)
    const title = String(data.get('sectionTitle') ?? '').trim().replace(/\s+/g, ' ')
    const description = String(data.get('sectionDescription') ?? '').trim().replace(/\s+/g, ' ')
    if (title.length < 2) { setAppError('Введите название раздела'); return false }
    if (sections.some((section) => section.id !== id && normalize(section.title) === normalize(title))) { setAppError('Раздел с таким названием уже есть'); return false }
    const { error } = await supabase.from('sections').update({ title, description }).eq('id', id)
    if (error) { setAppError(error.message); return false }
    setAppNotice(`Раздел «${title}» обновлён`)
    await loadData()
    return true
  }

  async function deleteSection(section: WorkspaceSection) {
    if (!canManageMembers) return
    if (!window.confirm(`Удалить раздел «${section.title}»? Карточка раздела исчезнет у всех участников. Записи и файлы внутри базы не удалятся, но сам раздел потребуется создавать заново.`)) return
    const { error } = await supabase.from('sections').delete().eq('id', section.id)
    if (error) { setAppError(error.message); return }
    setAppNotice(`Раздел «${section.title}» удалён`)
    await loadData()
  }

  async function uploadCalendarFiles(files: CalendarAttachment[], eventId: string) {
    const result: CalendarAttachment[] = []
    for (const attachment of files) {
      if (!attachment.file) { const { file: _file, ...stored } = attachment; result.push(stored); continue }
      const cleanName = attachment.name.replace(/[^a-zA-Zа-яА-ЯёЁ0-9._-]+/g, '-').slice(-100)
      const path = `${eventId}/${crypto.randomUUID()}-${cleanName}`
      await uploadStorageFile('calendar', path, attachment.file)
      result.push({ id: attachment.id, name: attachment.name, size: attachment.size, type: attachment.type, path })
    }
    return result
  }

  async function saveCalendarEvent(input: CalendarEventInput, initial: CalendarEvent | null) {
    if (!profile || !CONTENT_MANAGER_ROLES.includes(profile.role)) return false
    const eventId = initial?.id ?? crypto.randomUUID()
    try {
      const attachments = await uploadCalendarFiles(input.attachments, eventId)
      const payload = { title: input.title, event_type: input.eventType, event_date: input.eventDate, start_time: input.startTime, end_time: input.endTime || null, description: input.description, attachments }
      const { error } = initial
        ? await supabase.from('calendar_events').update(payload).eq('id', eventId)
        : await supabase.from('calendar_events').insert({ id: eventId, ...payload, author_id: profile.id })
      if (error) throw error
      const keptPaths = new Set(attachments.flatMap((file) => file.path ? [file.path] : []))
      const removedPaths = (initial?.attachments ?? []).flatMap((file) => file.path && !keptPaths.has(file.path) ? [file.path] : [])
      if (removedPaths.length) await supabase.storage.from('calendar').remove(removedPaths)
      setAppNotice(initial ? 'Событие обновлено' : 'Событие добавлено')
      await loadData()
      return true
    } catch (error) {
      setAppError(error instanceof Error ? error.message : 'Не удалось сохранить событие')
      return false
    }
  }

  async function deleteCalendarEvent(item: CalendarEvent) {
    if (!CONTENT_MANAGER_ROLES.includes(currentRole) || !window.confirm(`Удалить событие «${item.title}» ${item.eventDate}? Оно исчезнет из календаря и синхронизированного расписания. Это действие нельзя отменить.`)) return
    const { error } = await supabase.from('calendar_events').delete().eq('id', item.id)
    if (error) { setAppError(error.message); return }
    const paths = item.attachments.flatMap((file) => file.path ? [file.path] : [])
    if (paths.length) await supabase.storage.from('calendar').remove(paths)
    setAppNotice('Событие удалено')
    await loadData()
  }

  async function saveScheduleEntry(input: ScheduleEntryInput, initial: ScheduleEntry | null) {
    if (!profile || !CONTENT_MANAGER_ROLES.includes(profile.role)) return false
    const payload = { event_date: input.eventDate, start_time: input.startTime, teacher: input.teacher, class_name: input.className, topic: input.topic, absence: input.absence }
    const { error } = initial
      ? await supabase.from('schedule_entries').update(payload).eq('id', initial.id)
      : await supabase.from('schedule_entries').insert({ ...payload, author_id: profile.id })
    if (error) { setAppError(error.message); return false }
    setAppNotice(initial ? 'Запись расписания обновлена' : 'Запись добавлена в расписание')
    await loadData()
    return true
  }

  async function deleteScheduleEntry(item: ScheduleEntry) {
    if (!CONTENT_MANAGER_ROLES.includes(currentRole) || !window.confirm(`Удалить запись «${item.className}» ${item.eventDate}? Это действие нельзя отменить.`)) return
    const { error } = await supabase.from('schedule_entries').delete().eq('id', item.id)
    if (error) { setAppError(error.message); return }
    setAppNotice('Запись расписания удалена')
    await loadData()
  }

  const installButton = !isInstalled && <button className="text-button install-button" type="button" onClick={installApp}>⇩ Установить</button>
  const installHelp = showInstallHelp && <InstallHelp onClose={() => setShowInstallHelp(false)} />
  const visibleAppError = /failed to fetch/i.test(appError) ? 'Нет связи с сервером. Проверьте интернет.' : appError

  if (hubAccess !== 'unlocked') return <main className="gate-shell"><section className="gate-panel"><div className="logo-mark">Т·А·М</div><p className="eyebrow">Камерный театр-лаборатория</p><h1>Рабочий воркхаб</h1>{hubAccess === 'checking' ? <p>Проверяем доступ…</p> : <form onSubmit={unlock}><label htmlFor="hub-password">Общий пароль</label><input id="hub-password" name="password" type="password" autoComplete="current-password" autoFocus />{passwordError && <p className="form-error">Неверный пароль</p>}<button className="button button-solid" type="submit">Войти</button></form>}{installButton}</section>{installHelp}</main>

  return <div className="app-shell">
    <header className="app-header"><button className="brand" type="button" onClick={() => setScreen('hub')}><span className="logo-mark small">Т·А·М</span><span><b>Камерный театр-лаборатория Т.А.М.</b><small>Рабочий воркхаб</small></span></button><div className="account-area">{installButton}<div className="user-chip">{profile && <button className="profile-notification-button" type="button" aria-label="Настройки уведомлений" onClick={openNotificationSettings}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></svg></button>}{profile ? <ParticipantAvatar participant={profile} editable uploading={uploadingAvatar} onSelect={uploadOwnAvatar} /> : <span className="header-avatar-fallback">О</span>}<span><b>{profile?.name ?? 'Общий вход'}</b><small>{profile ? ROLE_LABELS[profile.role] : 'Без личного входа'}</small></span></div>{profile ? <button className="text-button header-logout" type="button" onClick={logout}>Выйти</button> : <button className="text-button header-logout" type="button" onClick={() => { setReturnScreen('hub'); setScreen('auth') }}>Личный вход</button>}</div></header>
    {installHelp}
    {showNotificationSettings && profile && <NotificationSettings preferences={notificationPreferences} permission={notificationPermission} saving={savingNotifications} onChange={setNotificationPreferences} onSave={saveNotificationPreferences} onEnable={enablePushNotifications} onDisable={disablePushNotifications} onClose={() => setShowNotificationSettings(false)} />}
    {(appError || appNotice) && <div className="app-toast-stack" aria-live="polite">
      {appError && <div className="app-alert" role="alert"><span>{visibleAppError}</span><button type="button" aria-label="Закрыть уведомление" onClick={() => setAppError('')}>×</button></div>}
      {appNotice && <div className="app-alert success" role="status"><span>{appNotice}</span><button type="button" aria-label="Закрыть уведомление" onClick={() => setAppNotice('')}>×</button></div>}
    </div>}
    {screen === 'hub' && <Hub profile={profile} sections={sections} canOpenCollection={canOpenCollection} canOpenCalendar={canOpenCalendar} canOpenSchedule={canOpenSchedule} canInvite={canInvite} canCreateSections={canCreateSections} onCollection={() => requireAccess('collection')} onCalendar={() => requireAccess('calendar')} onSchedule={() => requireAccess('schedule')} onSettings={() => requireAccess('settings')} onSection={openCustomSection} onCreateSection={createSection} />}
    {screen === 'auth' && <AuthScreen message={authMessage} onSubmit={signInWithPersonalPassword} onBack={() => setScreen('hub')} />}
    {screen === 'collection' && <CollectionScreen title={sections.find((section) => section.id === COLLECTION_SECTION)?.title ?? 'Копилка материалов'} description={sections.find((section) => section.id === COLLECTION_SECTION)?.description ?? 'Общие материалы театра'} materials={filteredMaterials} categories={categories} activeFilters={activeFilters} query={query} trashCount={trashMaterials.length} canDelete={canDelete} reactionMenu={reactionMenu} openComments={openComments} onBack={() => setScreen('hub')} onAdd={() => { setEditingMaterial(null); setScreen('form') }} onQuery={setQuery} onClear={() => { setQuery(''); setActiveFilters([]) }} onTrashScreen={() => setScreen('trash')} onFilter={(category) => setActiveFilters((current) => current.includes(category) ? current.filter((item) => item !== category) : [...current, category])} onPin={togglePinned} onEdit={(item) => { setEditingMaterial(item); setScreen('form') }} onTrash={moveToTrash} onReactionMenu={setReactionMenu} onReact={react} onComments={setOpenComments} onAddComment={addComment} />}
    {screen === 'form' && <MaterialForm categories={categories} initial={editingMaterial} onCancel={() => { setEditingMaterial(null); setScreen('collection') }} onSave={editingMaterial ? updateMaterial : saveMaterial} />}
    {screen === 'trash' && <TrashScreen materials={trashMaterials} onBack={() => setScreen('collection')} onRestore={restore} onRemove={removeForever} />}
    {screen === 'settings' && <SettingsScreen participants={participants} sections={sections} canInvite={canInvite} canManageMembers={canManageMembers} onBack={() => setScreen('hub')} onShare={copyInvitation} onInvite={inviteParticipant} onUpdate={updateParticipant} onRemove={removeParticipant} onParticipantPassword={setParticipantPassword} onPassword={changePassword} onUpdateSection={updateSection} onDeleteSection={deleteSection} />}
    {screen === 'calendar' && <CalendarScreen title={sections.find((section) => section.id === CALENDAR_SECTION)?.title ?? 'Календарь репертуара'} description={sections.find((section) => section.id === CALENDAR_SECTION)?.description ?? 'Показы, репетиции и события театра'} events={calendarEvents} canManage={CONTENT_MANAGER_ROLES.includes(currentRole)} onBack={() => setScreen('hub')} onSave={saveCalendarEvent} onDelete={deleteCalendarEvent} />}
    {screen === 'schedule' && <ScheduleScreen title={scheduleSection?.title ?? 'Расписание занятий'} description={scheduleSection?.description ?? 'Дата, время, педагог, класс и отсутствие'} events={calendarEvents} entries={scheduleEntries} canManage={CONTENT_MANAGER_ROLES.includes(currentRole)} onBack={() => setScreen('hub')} onSaveEvent={saveCalendarEvent} onDeleteEvent={deleteCalendarEvent} onSaveEntry={saveScheduleEntry} onDeleteEntry={deleteScheduleEntry} />}
    {screen === 'custom' && activeSection && <CustomSectionScreen section={activeSection} onBack={() => setScreen('hub')} />}
  </div>
}

function InstallHelp({ onClose }: { onClose: () => void }) {
  const isApple = /iPad|iPhone|iPod/.test(navigator.userAgent)
  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}><section className="install-modal" role="dialog" aria-modal="true" aria-labelledby="install-title" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" type="button" aria-label="Закрыть" onClick={onClose}>×</button><span className="logo-mark small">Т·А·М</span><p className="eyebrow">Установка на телефон</p><h2 id="install-title">Добавить иконку приложения</h2>{isApple ? <ol><li>Откройте меню браузера.</li><li>Выберите <b>Добавить на экран «Домой»</b> или <b>Установить приложение</b>.</li><li>Подтвердите добавление иконки.</li><li>Если ваш браузер не показывает этот пункт, откройте ссылку в другом браузере.</li></ol> : <ol><li>Откройте меню браузера <b>⋮</b>.</li><li>Нажмите <b>Добавить на главный экран</b>.</li><li>Выберите <b>Установить</b> и подтвердите.</li></ol>}<p className="install-note">После этого появится отдельная иконка «Т.А.М.», а приложение будет открываться без адресной строки.</p><button className="button button-solid" type="button" onClick={onClose}>Понятно</button></section></div>
}

function NotificationSettings({ preferences, permission, saving, onChange, onSave, onEnable, onDisable, onClose }: { preferences: NotificationPreferences | null; permission: NotificationPermission; saving: boolean; onChange: (value: NotificationPreferences) => void; onSave: (value: NotificationPreferences) => void; onEnable: () => void; onDisable: () => void; onClose: () => void }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}><section className="notification-modal" role="dialog" aria-modal="true" aria-labelledby="notification-title" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" type="button" aria-label="Закрыть" onClick={onClose}>×</button><p className="eyebrow">Личные настройки</p><h2 id="notification-title">Уведомления</h2><p className="notification-intro">Напоминания о календаре и классах приходят за 2 часа. Каждый пользователь настраивает их только для себя.</p>{preferences ? <><div className="notification-device"><div><b>{permission === 'granted' ? 'Уведомления разрешены' : permission === 'denied' ? 'Уведомления запрещены телефоном' : 'Уведомления на устройстве не включены'}</b><small>Подключённых устройств: {preferences.deviceCount}</small></div>{permission === 'granted' ? <button className="button" type="button" disabled={saving} onClick={onDisable}>Отключить на этом устройстве</button> : <button className="button button-solid" type="button" disabled={saving || permission === 'denied'} onClick={onEnable}>Включить на этом устройстве</button>}</div><div className="notification-options"><label><span><b>События, показы и репетиции</b><small>Всё, что добавлено в календарь репертуара</small></span><input type="checkbox" checked={preferences.eventsEnabled} onChange={(event) => onChange({ ...preferences, eventsEnabled: event.target.checked })} /></label><label><span><b>Классы</b><small>Записи из расписания классов и репетиций</small></span><input type="checkbox" checked={preferences.classesEnabled} onChange={(event) => onChange({ ...preferences, classesEnabled: event.target.checked })} /></label><label><span><b>Сообщения в беседах</b><small>Будет использоваться мессенджером</small></span><input type="checkbox" checked={preferences.messagesEnabled} onChange={(event) => onChange({ ...preferences, messagesEnabled: event.target.checked })} /></label></div><button className="button button-solid notification-save" type="button" disabled={saving} onClick={() => onSave(preferences)}>{saving ? 'Сохраняем…' : 'Сохранить настройки'}</button><p className="notification-help">На iPhone уведомления работают у воркхаба, установленного на экран «Домой». Разрешение запрашивается только после нажатия кнопки выше.</p></> : <p>Загружаем настройки…</p>}</section></div>
}

function Hub({ profile, sections, canOpenCollection, canOpenCalendar, canOpenSchedule, canInvite, canCreateSections, onCollection, onCalendar, onSchedule, onSettings, onSection, onCreateSection }: { profile: Participant | null; sections: WorkspaceSection[]; canOpenCollection: boolean; canOpenCalendar: boolean; canOpenSchedule: boolean; canInvite: boolean; canCreateSections: boolean; onCollection: () => void; onCalendar: () => void; onSchedule: () => void; onSettings: () => void; onSection: (section: WorkspaceSection) => void; onCreateSection: (event: FormEvent<HTMLFormElement>) => Promise<boolean> }) {
  const [creatingSection, setCreatingSection] = useState(false)
  const collectionSection = sections.find((section) => section.id === COLLECTION_SECTION)
  const calendarSection = sections.find((section) => section.id === CALENDAR_SECTION)
  const scheduleSection = sections.find((section) => section.id === SCHEDULE_SECTION) ?? sections.find((section) => section.id !== COLLECTION_SECTION && section.id !== CALENDAR_SECTION && /расписан/i.test(section.title))
  const customSections = sections.filter((section) => section.id !== COLLECTION_SECTION && section.id !== CALENDAR_SECTION && section.id !== scheduleSection?.id)
  const accessLabel = (allowed: boolean) => !profile ? 'Личный вход' : !allowed ? 'Нет доступа' : profile.role === 'participant' ? 'Только просмотр' : 'Есть доступ'
  const unavailableClass = (allowed: boolean) => `module-card${profile && !allowed ? ' unavailable' : ''}`
  return <main><section className="work-header hub-hero"><div><p className="eyebrow inverse">Рабочая зона</p><h1>Разделы театра</h1></div><div className="workhub-media" aria-hidden="true"><img className="workhub-poster" src={`${import.meta.env.BASE_URL}workhub-hero.webp`} alt="" /><video className="workhub-video" autoPlay muted loop playsInline preload="metadata" poster={`${import.meta.env.BASE_URL}workhub-hero.webp`}><source src={`${import.meta.env.BASE_URL}workhub-hero.mp4`} type="video/mp4" /></video></div></section><section className="module-grid" aria-label="Разделы театра">
    {collectionSection && <button className={unavailableClass(canOpenCollection)} type="button" disabled={Boolean(profile) && !canOpenCollection} onClick={onCollection}><ModuleIcon name="collection" /><span className="module-copy"><b>{collectionSection.title}</b><small>{collectionSection.description || 'Ссылки, файлы, идеи и комментарии'}</small></span><span className="access-chip">{accessLabel(canOpenCollection)}</span><span>→</span></button>}
    {calendarSection && <button className={unavailableClass(canOpenCalendar)} type="button" disabled={Boolean(profile) && !canOpenCalendar} onClick={onCalendar}><ModuleIcon name="calendar" /><span className="module-copy"><b>{calendarSection.title}</b><small>{calendarSection.description || 'Показы, репетиции и события'}</small></span><span className="access-chip">{accessLabel(canOpenCalendar)}</span><span>→</span></button>}
    <button className={unavailableClass(canInvite)} type="button" disabled={Boolean(profile) && !canInvite} onClick={onSettings}><ModuleIcon name="settings" /><span className="module-copy"><b>Участники и настройки</b><small>Роли, доступы, личные пароли и общий пароль</small></span><span className="access-chip">{accessLabel(canInvite)}</span><span>→</span></button>
    {scheduleSection && <button className={unavailableClass(canOpenSchedule)} type="button" disabled={Boolean(profile) && !canOpenSchedule} onClick={onSchedule}><ModuleIcon name="schedule" /><span className="module-copy"><b>{scheduleSection.title}</b><small>{scheduleSection.description || 'Дата, время, педагог, класс и отсутствие'}</small></span><span className="access-chip">{accessLabel(canOpenSchedule)}</span><span>→</span></button>}
    {customSections.map((section) => { const allowed = profileHasSectionAccess(profile, section.id, sections); return <button className={unavailableClass(allowed)} type="button" disabled={Boolean(profile) && !allowed} key={section.id} onClick={() => onSection(section)}><ModuleIcon name="draft" /><span className="module-copy"><b>{section.title}</b><small>{section.description || 'Раздел театра'}</small></span><span className="access-chip">{accessLabel(allowed)}</span><span>→</span></button> })}
    {canCreateSections && !creatingSection && <button className="module-card" type="button" onClick={() => setCreatingSection(true)}><ModuleIcon name="add" /><span className="module-copy"><b>Новый раздел</b><small>Добавить название будущего раздела</small></span><span className="access-chip">Добавить</span><span>→</span></button>}
    {canCreateSections && creatingSection && <form className="module-card section-create-form" onSubmit={async (event) => { if (await onCreateSection(event)) setCreatingSection(false) }}><ModuleIcon name="add" /><div className="section-create-fields"><b>Новый раздел</b><input name="sectionTitle" placeholder="Название раздела" minLength={2} maxLength={80} autoFocus required /><input name="sectionDescription" placeholder="Краткое описание (необязательно)" maxLength={140} /></div><div className="section-create-actions"><button className="button" type="button" onClick={() => setCreatingSection(false)}>Отмена</button><button className="button button-solid" type="submit">Создать</button></div></form>}
  </section></main>
}

function CustomSectionScreen({ section, onBack }: { section: WorkspaceSection; onBack: () => void }) {
  return <main><section className="work-header compact"><button className="icon-button inverse" type="button" aria-label="Назад" onClick={onBack}>←</button><div><h1>{section.title}</h1><p>{section.description}</p></div></section></main>
}

function SectionManagement({ sections, onUpdateSection, onDeleteSection }: { sections: WorkspaceSection[]; onUpdateSection: (id: string, event: FormEvent<HTMLFormElement>) => Promise<boolean>; onDeleteSection: (section: WorkspaceSection) => void }) {
  const [editingSection, setEditingSection] = useState<string | null>(null)
  return <section className="section-management settings-section-management" role="tabpanel"><p className="section-management-note">Здесь можно менять названия и описания разделов. Любой раздел удаляется только после подтверждения.</p>{sections.map((section) => <article className="section-management-row" key={section.id}>{editingSection === section.id ? <form onSubmit={async (event) => { if (await onUpdateSection(section.id, event)) setEditingSection(null) }}><label><span>Название</span><input name="sectionTitle" defaultValue={section.title} minLength={2} maxLength={80} required autoFocus /></label><label><span>Описание</span><input name="sectionDescription" defaultValue={section.description} maxLength={140} /></label><div><button className="button" type="button" onClick={() => setEditingSection(null)}>Отмена</button><button className="button button-solid" type="submit">Сохранить</button></div></form> : <><div><b>{section.title}</b><p>{section.description || 'Без описания'}</p></div><div className="section-management-actions"><button className="icon-button" type="button" aria-label={`Редактировать раздел ${section.title}`} onClick={() => setEditingSection(section.id)}>✎</button><button className="icon-button danger" type="button" aria-label={`Удалить раздел ${section.title}`} onClick={() => onDeleteSection(section)}>×</button></div></>}</article>)}</section>
}

function AuthScreen({ message, onSubmit, onBack }: { message: string; onSubmit: (event: FormEvent<HTMLFormElement>) => void; onBack: () => void }) {
  return <main><section className="work-header compact"><button className="icon-button inverse" type="button" aria-label="Назад" onClick={onBack}>←</button><div><h1>Личный вход</h1><p>Почта и постоянный личный пароль</p></div></section><form className="auth-form" autoComplete="off" onSubmit={onSubmit}><label>Почта участника<input name="email" type="email" placeholder="name@example.com" autoComplete="off" required autoFocus /></label><label>Личный пароль<input name="personalPassword" type="password" minLength={6} autoComplete="off" required /></label><button className="button button-solid" type="submit">Войти</button>{message && <p className="auth-message" role="status">{message}</p>}</form></main>
}

type CollectionProps = { title: string; description: string; materials: Material[]; categories: string[]; activeFilters: string[]; query: string; trashCount: number; canDelete: boolean; reactionMenu: string | null; openComments: string | null; onBack: () => void; onAdd: () => void; onQuery: (value: string) => void; onClear: () => void; onTrashScreen: () => void; onFilter: (category: string) => void; onPin: (id: string) => void; onEdit: (item: Material) => void; onTrash: (id: string) => void; onReactionMenu: (id: string | null) => void; onReact: (id: string, emoji: string) => void; onComments: (id: string | null) => void; onAddComment: (id: string, text: string) => void }
function CollectionScreen(props: CollectionProps) {
  return <main><section className="work-header compact"><button className="icon-button inverse" type="button" aria-label="Назад" onClick={props.onBack}>←</button><div><h1>{props.title}</h1><p>{props.description}</p></div><button className="button inverse-button" type="button" onClick={props.onAdd}>＋ Добавить</button></section>
    <section className="collection-tools"><label className="search-box"><span>⌕</span><input value={props.query} onChange={(event) => props.onQuery(event.target.value)} placeholder="Поиск по всем полям" /></label><button className="button" type="button" onClick={props.onClear}>Очистить</button>{props.canDelete && <button className="button" type="button" onClick={props.onTrashScreen}>Корзина{props.trashCount ? ` · ${props.trashCount}` : ''}</button>}</section>
    <section className="filters" aria-label="Фильтры"><span>Фильтр:</span>{props.categories.map((category) => <button className={props.activeFilters.includes(category) ? 'filter active' : 'filter'} type="button" key={category} onClick={() => props.onFilter(category)}>{category}</button>)}</section>
    <section className="materials" aria-live="polite"><div className="desktop-table"><div className="material-row table-head"><span>Важно</span><span>Источник</span><span>Для чего</span><span>Что внутри</span><span>Реакции</span><span></span></div>{props.materials.map((item) => <MaterialRow key={item.id} item={item} mobile={false} {...props} commentsOpen={props.openComments} />)}</div><div className="mobile-cards">{props.materials.map((item) => <MaterialRow key={item.id} item={item} mobile {...props} commentsOpen={props.openComments} />)}</div>{!props.materials.length && <div className="empty-state">Здесь пока нет материалов</div>}</section>
  </main>
}

type RowProps = { item: Material; mobile: boolean; canDelete: boolean; reactionMenu: string | null; commentsOpen: string | null; onPin: (id: string) => void; onEdit: (item: Material) => void; onTrash: (id: string) => void; onReactionMenu: (id: string | null) => void; onReact: (id: string, emoji: string) => void; onComments: (id: string | null) => void; onAddComment: (id: string, text: string) => void }
function MaterialRow({ item, mobile, canDelete, reactionMenu, commentsOpen, onPin, onEdit, onTrash, onReactionMenu, onReact, onComments, onAddComment }: RowProps) {
  const [comment, setComment] = useState(''); const longPressTimer = useRef<number | null>(null); const longPressTriggered = useRef(false)
  const style = { '--row-color': `var(--category-${Math.abs(Array.from(normalize(item.category)).reduce((sum, letter) => sum + letter.codePointAt(0)!, 0)) % 6 + 1})` } as React.CSSProperties
  const reactionCount = Object.values(item.reactions).reduce((sum, count) => sum + count, 0)
  const reactions = <div className="reaction-area"><button className="text-button" type="button" onPointerDown={() => { longPressTriggered.current = false; longPressTimer.current = window.setTimeout(() => { longPressTriggered.current = true; onReactionMenu(item.id) }, 450) }} onPointerUp={() => { if (longPressTimer.current) window.clearTimeout(longPressTimer.current) }} onPointerLeave={() => { if (longPressTimer.current) window.clearTimeout(longPressTimer.current) }} onClick={() => { if (longPressTriggered.current) { longPressTriggered.current = false; return }; onReactionMenu(reactionMenu === item.id ? null : item.id) }}>{reactionCount ? Object.entries(item.reactions).filter(([, count]) => count).map(([emoji, count]) => `${emoji}${count}`).join(' ') : '＋ реакция'}</button>{reactionMenu === item.id && <div className="reaction-menu">{REACTIONS.map((emoji) => <button type="button" key={emoji} onClick={() => onReact(item.id, emoji)}>{emoji}</button>)}</div>}</div>
  const comments = commentsOpen === item.id && <div className="comments-panel">{item.comments.map((entry) => <p key={entry.id}><b>{entry.author}:</b> <LinkifyText text={entry.text} /></p>)}<form onSubmit={(event) => { event.preventDefault(); onAddComment(item.id, comment); setComment('') }}><input value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Написать комментарий" /><button className="button" type="submit">Добавить</button></form></div>
  if (mobile) return <article className="material-card" style={style}><header><span className="category-chip">{item.category || 'Без категории'}</span><button className={item.pinned ? 'icon-button pinned' : 'icon-button'} type="button" aria-label={item.pinned ? 'Снять приоритет' : 'Поднять наверх'} onClick={() => onPin(item.id)}>◆</button></header><section><b><LinkifyText text={item.source} /></b><AttachmentList files={item.sourceFiles} /></section>{item.categoryFiles.length > 0 && <section><small>Для чего</small><AttachmentList files={item.categoryFiles} /></section>}<section><p><LinkifyText text={item.description} /></p><AttachmentList files={item.descriptionFiles} /></section><footer>{reactions}<button className="text-button" type="button" onClick={() => onComments(commentsOpen === item.id ? null : item.id)}>Комментарии {item.comments.length}</button><span className="row-actions"><button className="icon-button" type="button" aria-label="Редактировать" onClick={() => onEdit(item)}>✎</button>{canDelete && <button className="icon-button danger" type="button" aria-label="Переместить в корзину" onClick={() => onTrash(item.id)}>×</button>}</span></footer>{comments}</article>
  return <article className="material-row" style={style}><span><button className={item.pinned ? 'icon-button pinned' : 'icon-button'} type="button" aria-label={item.pinned ? 'Снять приоритет' : 'Поднять наверх'} onClick={() => onPin(item.id)}>◆</button></span><span><b><LinkifyText text={item.source} /></b><AttachmentList files={item.sourceFiles} /></span><span><span className="category-chip">{item.category || 'Без категории'}</span><AttachmentList files={item.categoryFiles} /></span><span><LinkifyText text={item.description} /><AttachmentList files={item.descriptionFiles} /></span><span>{reactions}<button className="text-button" type="button" onClick={() => onComments(commentsOpen === item.id ? null : item.id)}>Комментарии {item.comments.length}</button></span><span className="row-actions"><button className="icon-button" type="button" aria-label="Редактировать" onClick={() => onEdit(item)}>✎</button>{canDelete && <button className="icon-button danger" type="button" aria-label="Переместить в корзину" onClick={() => onTrash(item.id)}>×</button>}</span>{comments && <div className="row-comments">{comments}</div>}</article>
}

type MaterialInput = Pick<Material, 'source' | 'sourceFiles' | 'category' | 'categoryFiles' | 'description' | 'descriptionFiles'>
function MaterialForm({ categories, initial, onCancel, onSave }: { categories: string[]; initial: Material | null; onCancel: () => void; onSave: (material: MaterialInput) => Promise<void> }) {
  const [sourceFiles, setSourceFiles] = useState<Attachment[]>(initial?.sourceFiles ?? []); const [categoryFiles, setCategoryFiles] = useState<Attachment[]>(initial?.categoryFiles ?? []); const [descriptionFiles, setDescriptionFiles] = useState<Attachment[]>(initial?.descriptionFiles ?? []); const [saving, setSaving] = useState(false); const [validationError, setValidationError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const source = String(data.get('source')).trim(); const category = String(data.get('category')).trim(); const description = String(data.get('description')).trim()
    const hasFile = sourceFiles.length + categoryFiles.length + descriptionFiles.length > 0
    if (!source && !category && !description && !hasFile) { setValidationError('Добавьте хотя бы ссылку, текст или один файл.'); return }
    setValidationError(''); setSaving(true)
    await onSave({ source, sourceFiles, category, categoryFiles, description, descriptionFiles })
    setSaving(false)
  }
  return <main><section className="work-header compact"><button className="icon-button inverse" type="button" aria-label="Назад" onClick={onCancel}>←</button><div><h1>{initial ? 'Редактирование материала' : 'Новый материал'}</h1><p>Достаточно ссылки, текста или одного файла</p></div></section><form className="material-form" onSubmit={submit}><div className="form-grid">
    <section className="form-field"><h2>1. Источник</h2><textarea name="source" rows={5} defaultValue={initial?.source} placeholder="Ссылка, название или текст — необязательно, если есть файл" /><label className="file-control">Прикрепить файлы<input type="file" multiple onChange={(event) => setSourceFiles((current) => [...current, ...fileListToAttachments(event.target.files)])} /></label><AttachmentList files={sourceFiles} /></section>
    <section className="form-field"><h2>2. Для чего</h2><input name="category" list="category-list" defaultValue={initial?.category} placeholder="Например: спектакль — необязательно, если есть файл" /><datalist id="category-list">{categories.map((category) => <option value={category} key={category} />)}</datalist><small>Одна категория. Регистр букв не учитывается.</small><label className="file-control">Прикрепить файлы<input type="file" multiple onChange={(event) => setCategoryFiles((current) => [...current, ...fileListToAttachments(event.target.files)])} /></label><AttachmentList files={categoryFiles} /></section>
    <section className="form-field"><h2>3. Что внутри</h2><textarea name="description" rows={5} defaultValue={initial?.description} placeholder="Описание или комментарий — необязательно, если есть файл" /><label className="file-control">Прикрепить файлы<input type="file" multiple onChange={(event) => setDescriptionFiles((current) => [...current, ...fileListToAttachments(event.target.files)])} /></label><AttachmentList files={descriptionFiles} /></section>
  </div>{validationError && <p className="form-error material-form-error" role="alert">{validationError}</p>}<div className="form-footer"><div><button className="button" type="button" onClick={onCancel}>Отмена</button><button className="button button-solid" type="submit" disabled={saving}>{saving ? 'Сохраняю…' : initial ? 'Сохранить изменения' : 'Сохранить'}</button></div></div></form></main>
}

function TrashScreen({ materials, onBack, onRestore, onRemove }: { materials: Material[]; onBack: () => void; onRestore: (id: string) => void; onRemove: (id: string) => void }) {
  return <main><section className="work-header compact"><button className="icon-button inverse" type="button" aria-label="Назад" onClick={onBack}>←</button><div><h1>Корзина</h1><p>Материалы удаляются навсегда через 30 дней</p></div></section><section className="trash-list">{materials.map((item) => { const daysLeft = Math.max(1, 30 - Math.floor((Date.now() - (item.deletedAt ?? Date.now())) / DAY)); return <article className="trash-row" key={item.id}><div><b>{materialTitle(item)}</b><small>{item.category || 'Без категории'} · осталось {daysLeft} дн.</small></div><div><button className="button" onClick={() => onRestore(item.id)}>Восстановить</button><button className="button danger" onClick={() => onRemove(item.id)}>Удалить навсегда</button></div></article> })}{!materials.length && <div className="empty-state">Корзина пуста</div>}</section></main>
}

function SettingsScreen({ participants, sections, canInvite, canManageMembers, onBack, onShare, onInvite, onUpdate, onRemove, onParticipantPassword, onPassword, onUpdateSection, onDeleteSection }: { participants: Participant[]; sections: WorkspaceSection[]; canInvite: boolean; canManageMembers: boolean; onBack: () => void; onShare: (email?: string) => void; onInvite: (event: FormEvent<HTMLFormElement>) => void; onUpdate: (id: string, changes: Partial<Participant>) => void; onRemove: (id: string) => void; onParticipantPassword: (id: string, event: FormEvent<HTMLFormElement>) => void; onPassword: (event: FormEvent<HTMLFormElement>) => void; onUpdateSection: (id: string, event: FormEvent<HTMLFormElement>) => Promise<boolean>; onDeleteSection: (section: WorkspaceSection) => void }) {
  const [activeTab, setActiveTab] = useState<'participants' | 'sections'>('participants')
  return <main><section className="work-header compact"><button className="icon-button inverse" type="button" aria-label="Назад" onClick={onBack}>←</button><div><h1>Участники и настройки</h1><p>Роли, доступы и личные пароли</p></div>{canInvite && <button className="button inverse-button" type="button" onClick={() => onShare()}>Поделиться приложением</button>}</section><section className="settings-grid"><div className="settings-main"><div className="settings-heading settings-tabs-heading"><div><p className="eyebrow">Настройки интерфейса</p><div className="settings-tabs" role="tablist" aria-label="Настройки интерфейса"><button type="button" role="tab" aria-selected={activeTab === 'participants'} className={activeTab === 'participants' ? 'active' : ''} onClick={() => setActiveTab('participants')}>Участники</button>{canManageMembers && <button type="button" role="tab" aria-selected={activeTab === 'sections'} className={activeTab === 'sections' ? 'active' : ''} onClick={() => setActiveTab('sections')}>Управление разделами</button>}</div></div>{activeTab === 'participants' && <span>{participants.length}</span>}</div>
    {activeTab === 'participants' && <div className="settings-tab-panel" role="tabpanel">{participants.map((participant) => { const canSetThisPassword = canManageMembers || participant.role === 'participant'; return <article className="participant-row" key={participant.id}><ParticipantAvatar participant={participant} /><div className="participant-identity"><b>{participant.name}</b><a href={`mailto:${participant.email}`}>{participant.email}</a><small>{participant.status === 'active' ? 'Активен' : 'Ожидает первого входа'}</small></div><label><span>Роль</span><select value={participant.role} disabled={!canManageMembers || participant.id === DEVELOPER_ID} onChange={(event) => onUpdate(participant.id, { role: event.target.value as Role })}>{(Object.keys(ROLE_LABELS) as Role[]).map((role) => <option value={role} key={role}>{ROLE_LABELS[role]}</option>)}</select></label><div className="participant-section-access"><span>Доступные разделы</span><div className="participant-section-list">{sections.map((section) => { const roleGrantsAccess = participant.role === 'developer' || participant.role === 'leader' || section.accessRoles.includes(participant.role); const checked = roleGrantsAccess || participant.sections.includes(section.id); return <label key={section.id}><input type="checkbox" checked={checked} disabled={!canManageMembers || participant.id === DEVELOPER_ID || roleGrantsAccess} onChange={(event) => { const nextSections = new Set(participant.sections); if (event.target.checked) nextSections.add(section.id); else nextSections.delete(section.id); onUpdate(participant.id, { sections: Array.from(nextSections) }) }} /><span>{section.title}</span></label> })}</div></div><div className="participant-actions"><button className="icon-button" type="button" aria-label={`Скопировать данные входа для ${participant.name}`} onClick={() => onShare(participant.email)}>↗</button>{canManageMembers && participant.id !== DEVELOPER_ID && <button className="icon-button danger" type="button" aria-label={`Удалить ${participant.name}`} onClick={() => onRemove(participant.id)}>×</button>}</div>{canSetThisPassword && <form className="participant-password" onSubmit={(event) => onParticipantPassword(participant.id, event)}><label><span>Новый личный пароль</span><input name="participantPassword" type="password" minLength={6} autoComplete="new-password" placeholder="Не меньше 6 символов" required /></label><button className="button" type="submit">Установить пароль</button></form>}</article> })}
    {canInvite && <form className="invite-form" onSubmit={onInvite}><div><p className="eyebrow">Новый участник</p><h2>Добавить участника</h2></div><label>Имя<input name="name" placeholder="Имя и фамилия" required /></label><label>Почта<input name="email" type="email" placeholder="name@example.com" required /></label><label>Личный пароль<input name="personalPassword" type="password" minLength={6} autoComplete="new-password" placeholder="Не меньше 6 символов" required /></label>{canManageMembers ? <label>Роль<select name="role" defaultValue="participant">{(Object.keys(ROLE_LABELS) as Role[]).filter((role) => role !== 'developer').map((role) => <option value={role} key={role}>{ROLE_LABELS[role]}</option>)}</select></label> : <input name="role" type="hidden" value="participant" />}<button className="button button-solid" type="submit">Добавить участника</button></form>}</div>}
    {activeTab === 'sections' && canManageMembers && <SectionManagement sections={sections} onUpdateSection={onUpdateSection} onDeleteSection={onDeleteSection} />}
  </div><aside className="settings-side"><section className="settings-panel"><p className="eyebrow">Права доступа</p><h2>Роли</h2>{(Object.keys(ROLE_LABELS) as Role[]).map((role) => <div className="role-note" key={role}><b>{ROLE_LABELS[role]}</b><p>{ROLE_DESCRIPTIONS[role]}</p></div>)}</section>{canManageMembers && <section className="settings-panel"><p className="eyebrow">Безопасность</p><h2>Общий пароль</h2><form className="password-form" onSubmit={onPassword}><label>Новый пароль<input name="newPassword" type="password" minLength={4} required /></label><button className="button" type="submit">Изменить пароль</button></form></section>}<section className="settings-panel developer-card"><span className="access-chip">Разраб</span><h2>Андрей Комов</h2><a href="mailto:a.s.komow@gmail.com">a.s.komow@gmail.com</a><p>Техническое сопровождение воркхаба.</p></section></aside></section></main>
}

export default App
