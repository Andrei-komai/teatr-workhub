import { FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { CalendarScreen, ScheduleScreen } from './CalendarScreen'
import type { CalendarAttachment, CalendarEvent, CalendarEventInput, ScheduleAbsence, ScheduleEntry, ScheduleEntryInput, ScheduleRegularAbsence } from './CalendarScreen'
import { ContentPlanScreen } from './ContentPlanScreen'
import type { ContentPlanAttachment, ContentPlanInput, ContentPlanItem } from './ContentPlanScreen'
import { WardrobeScreen } from './WardrobeScreen'
import type { WardrobeItem, WardrobeItemInput } from './WardrobeScreen'
import { ParticipationPolicyScreen, PolicySignaturesList } from './ParticipationPolicyScreen'
import type { ParticipationPolicySignature } from './ParticipationPolicyScreen'
import { YandexStorageScreen } from './YandexStorageScreen'
import { PERSONAL_SESSION_KEY, supabase } from './supabase'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

type Screen = 'hub' | 'auth' | 'collection' | 'form' | 'trash' | 'settings' | 'calendar' | 'schedule' | 'contentPlan' | 'wardrobe' | 'policy' | 'custom'
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
const CONTENT_PLAN_SECTION = 'content-plan'
const WARDROBE_SECTION = 'wardrobe'
const POLICY_SECTION = 'participation-policy'
const POLICY_VERSION = '1.1'
const DEVELOPER_ID = '00000000-0000-0000-0000-000000000001'
const PUBLIC_APP_URL = 'https://andrei-komai.github.io/teatr-workhub/'
const VAPID_PUBLIC_KEY = 'BENd3hUj0b-6-mRiIH81DsxOoA8ALkqT_c9RVU6CJHmmf3jblkTeRvFNEyri15fbAjBFhDrtSP8Ngis38_ddfPc'
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
const STANDARD_UPLOAD_LIMIT = 6 * 1024 * 1024
const MAX_FILE_SIZE = 50 * 1024 * 1024
const FULL_ACCESS_ROLES: Role[] = ['developer', 'leader', 'teacher']
const CONTENT_PLAN_MANAGER_ROLES: Role[] = [...FULL_ACCESS_ROLES, 'admin']
const ROLE_LABELS: Record<Role, string> = { developer: 'Разраб', leader: 'Руководитель', teacher: 'Педагог', admin: 'Админ', participant: 'Участник' }
const ROLE_DESCRIPTIONS: Record<Role, string> = {
  developer: 'Техническое сопровождение и полный доступ ко всем настройкам.',
  leader: 'Полный доступ ко всем разделам, участникам, ролям и настройкам.',
  teacher: 'Полный доступ ко всем разделам, участникам, ролям и настройкам.',
  admin: 'Просмотр всех разделов. Редактирование только контент-плана и собственных отсутствий.',
  participant: 'Календарь занятий, календарь репертуара, хранилище и положение. В расписании управляет только своими отсутствиями.',
}

const STARTUP_REQUEST_TIMEOUT = 8000
const BACKGROUND_REQUEST_TIMEOUT = 12000

async function withTimeout<T>(request: PromiseLike<T>, timeoutMs: number): Promise<T> {
  let timeoutId = 0
  try {
    return await Promise.race([
      Promise.resolve(request),
      new Promise<T>((_, reject) => {
        timeoutId = window.setTimeout(() => reject(new Error('REQUEST_TIMEOUT')), timeoutMs)
      }),
    ])
  } finally {
    window.clearTimeout(timeoutId)
  }
}

function mapNotificationPreferences(value: Record<string, unknown>): NotificationPreferences {
  return {
    eventsEnabled: value.events_enabled !== false,
    classesEnabled: value.classes_enabled !== false,
    messagesEnabled: value.messages_enabled !== false,
    reminderMinutes: Number(value.reminder_minutes ?? 60),
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
    try {
      const { data, error } = await withTimeout(supabase.storage.from('avatars').createSignedUrl(participant.avatarPath, 24 * 60 * 60), 5000)
      return { ...participant, avatarUrl: error ? null : data.signedUrl }
    } catch {
      return participant
    }
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
    endTime: row.end_time ? String(row.end_time) : null, className: String(row.class_name), topic: String(row.topic ?? ''), absence: String(row.absence ?? ''),
    seriesId: row.series_id ? String(row.series_id) : null,
    authorId: row.author_id ? String(row.author_id) : null, createdAt: new Date(String(row.created_at)).getTime(),
  }
}
function mapScheduleRegularAbsence(row: Record<string, unknown>): ScheduleRegularAbsence {
  return { seriesId: String(row.series_id), profileId: String(row.profile_id), reason: String(row.reason ?? '') }
}
function mapScheduleAbsence(row: Record<string, unknown>): ScheduleAbsence {
  return { entryId: String(row.entry_id), profileId: String(row.profile_id), reason: String(row.reason ?? '') }
}
function mapContentPlanItem(row: Record<string, unknown>): ContentPlanItem {
  return {
    id: String(row.id), kind: String(row.kind) as ContentPlanItem['kind'], contentDate: String(row.content_date),
    description: String(row.description ?? ''), format: String(row.format ?? ''), responsible: String(row.responsible ?? ''), link: String(row.link ?? ''),
    attachments: (row.attachments as ContentPlanAttachment[]) ?? [], authorId: row.author_id ? String(row.author_id) : null, createdAt: new Date(String(row.created_at)).getTime(),
  }
}
function mapWardrobeItem(row: Record<string, unknown>): WardrobeItem {
  return {
    id: String(row.id), performance: String(row.performance), itemQuantity: String(row.item_quantity),
    updatedByName: String(row.updated_by_name ?? ''), updatedAt: new Date(String(row.updated_at)).getTime(),
  }
}
function roleHasPermanentSectionAccess(role: Role, section: WorkspaceSection) {
  if (FULL_ACCESS_ROLES.includes(role) || role === 'admin') return true
  return section.id === CALENDAR_SECTION || section.id === SCHEDULE_SECTION || section.id === POLICY_SECTION || /хранилищ/i.test(section.title)
}
function profileHasSectionAccess(targetProfile: Participant | null, sectionId: string, availableSections: WorkspaceSection[]) {
  if (!targetProfile) return false
  const section = availableSections.find((item) => item.id === sectionId)
  if (!section) return false
  return roleHasPermanentSectionAccess(targetProfile.role, section) || targetProfile.sections.includes(sectionId)
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

function ModuleIcon({ name }: { name: 'collection' | 'calendar' | 'settings' | 'schedule' | 'contentPlan' | 'wardrobe' | 'policy' | 'draft' | 'add' }) {
  const paths = {
    collection: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M8 3v18M16 3v18M3 8h18M3 16h18" /></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M7 3v4M17 3v4M3 10h18M7 14h2M11 14h2M15 14h2M7 18h2M11 18h2" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" /></>,
    schedule: <><circle cx="12" cy="13" r="8" /><path d="M12 9v5l3 2M8 3h8M9 21h6" /></>,
    contentPlan: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8h8M8 12h8M8 16h5M7 8h.01M7 12h.01M7 16h.01" /></>,
    wardrobe: <><path d="M12 4a2.5 2.5 0 1 1-2.5 2.5" /><path d="m12 9-8 7h16zM4 16v3h16v-3" /></>,
    policy: <><path d="M6 3h9l3 3v15H6z" /><path d="M15 3v4h4M9 11h6M9 15h6M9 18h4" /></>,
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

function WorkhubMedia() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [isPlaying, setIsPlaying] = useState(false)

  useEffect(() => {
    const video = videoRef.current
    if (!video || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    video.muted = true
    video.play().catch(() => setIsPlaying(false))
  }, [])

  return <div className={`workhub-media${isPlaying ? ' is-playing' : ''}`} aria-hidden="true">
    <img className="workhub-poster" src={`${import.meta.env.BASE_URL}workhub-hero.webp`} alt="" />
    <video ref={videoRef} className={`workhub-video${isPlaying ? ' is-playing' : ''}`} autoPlay muted loop playsInline preload="metadata" poster={`${import.meta.env.BASE_URL}workhub-hero.webp`} onPlaying={() => setIsPlaying(true)} onPause={() => setIsPlaying(false)} onError={() => setIsPlaying(false)}>
      <source src={`${import.meta.env.BASE_URL}workhub-hero.mp4`} type="video/mp4" />
    </video>
  </div>
}

function StartupScreen({ error }: { error?: string }) {
  return <main className="gate-shell"><section className="gate-panel startup-panel"><div className="logo-mark">Т·А·М</div><p className="eyebrow">Камерный театр-лаборатория</p><h1>Рабочий воркхаб</h1>{error ? <><p>{error}</p><button className="button button-solid" type="button" onClick={() => window.location.reload()}>Повторить</button></> : <p>Открываем воркхаб…</p>}</section></main>
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
  const [initialDataLoading, setInitialDataLoading] = useState(true)
  const [initialDataError, setInitialDataError] = useState('')
  const [passwordError, setPasswordError] = useState(false)
  const [hubLoginError, setHubLoginError] = useState('')
  const [session, setSession] = useState<Session | null>(null)
  const [personalSession, setPersonalSession] = useState(() => localStorage.getItem(PERSONAL_SESSION_KEY))
  const [profile, setProfile] = useState<Participant | null>(null)
  const [participants, setParticipants] = useState<Participant[]>([])
  const [materials, setMaterials] = useState<Material[]>([])
  const [sections, setSections] = useState<WorkspaceSection[]>([])
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([])
  const [scheduleEntries, setScheduleEntries] = useState<ScheduleEntry[]>([])
  const [scheduleAbsences, setScheduleAbsences] = useState<ScheduleAbsence[]>([])
  const [scheduleRegularAbsences, setScheduleRegularAbsences] = useState<ScheduleRegularAbsence[]>([])
  const [scheduleParticipantNames, setScheduleParticipantNames] = useState<Record<string, string>>({})
  const [contentPlanItems, setContentPlanItems] = useState<ContentPlanItem[]>([])
  const [wardrobeItems, setWardrobeItems] = useState<WardrobeItem[]>([])
  const [wardrobeLoading, setWardrobeLoading] = useState(false)
  const [policySignatures, setPolicySignatures] = useState<ParticipationPolicySignature[]>([])
  const [policySignaturesLoading, setPolicySignaturesLoading] = useState(false)
  const [policySigning, setPolicySigning] = useState(false)
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
  const canManageMembers = FULL_ACCESS_ROLES.includes(currentRole)
  const canInvite = canManageMembers
  const canDelete = canManageMembers
  const canCreateSections = canManageMembers
  const scheduleSection = sections.find((section) => section.id === SCHEDULE_SECTION) ?? sections.find((section) => section.id !== COLLECTION_SECTION && section.id !== CALENDAR_SECTION && /расписан/i.test(section.title))
  const contentPlanSection = sections.find((section) => section.id === CONTENT_PLAN_SECTION) ?? sections.find((section) => /контент[- ]план/i.test(section.title))
  const wardrobeSection = sections.find((section) => section.id === WARDROBE_SECTION) ?? sections.find((section) => /костюмер/i.test(section.title))
  const policySection = sections.find((section) => section.id === POLICY_SECTION) ?? sections.find((section) => /положен.*участи|пользовательск.*соглаш/i.test(section.title))
  const canOpenCollection = profileHasSectionAccess(profile, COLLECTION_SECTION, sections)
  const canOpenCalendar = profileHasSectionAccess(profile, CALENDAR_SECTION, sections)
  const canOpenSchedule = Boolean(scheduleSection && profileHasSectionAccess(profile, scheduleSection.id, sections))
  const canOpenContentPlan = Boolean(contentPlanSection && profileHasSectionAccess(profile, contentPlanSection.id, sections))
  const canOpenWardrobe = Boolean(wardrobeSection && profileHasSectionAccess(profile, wardrobeSection.id, sections))
  const canOpenPolicy = Boolean(policySection && profileHasSectionAccess(profile, policySection.id, sections))

  async function loadData(activeSession: Session | null = session, activePersonalSession: string | null = personalSession, onReady?: () => void) {
    if (!activeSession?.user && !activePersonalSession) { setProfile(null); setParticipants([]); setMaterials([]); setSections([]); setCalendarEvents([]); setScheduleEntries([]); setScheduleAbsences([]); setContentPlanItems([]); setWardrobeItems([]); return true }
    const sectionRequest = supabase.from('sections').select('*').order('sort_order')
    let ownProfileResult
    try {
      ownProfileResult = await withTimeout(supabase.rpc('get_current_profile'), STARTUP_REQUEST_TIMEOUT)
    } catch {
      setAppError('Сервер не ответил вовремя. Проверьте соединение и попробуйте ещё раз.')
      return false
    }
    const { data: ownProfile, error: profileError } = ownProfileResult
    if (profileError) { setAppError(profileError.message); return false }
    setAppError('')
    const rawProfile = ownProfile ? mapParticipant(ownProfile as Record<string, unknown>) : null
    if (!rawProfile) { setProfile(null); setParticipants([]); setMaterials([]); setSections([]); setCalendarEvents([]); setScheduleEntries([]); setScheduleAbsences([]); setScheduleRegularAbsences([]); setScheduleParticipantNames({}); setContentPlanItems([]); setWardrobeItems([]); return true }

    setProfile(rawProfile)
    let sectionResult
    try {
      sectionResult = await withTimeout(sectionRequest, STARTUP_REQUEST_TIMEOUT)
    } catch {
      setAppError('Не удалось быстро загрузить разделы. Проверьте соединение и попробуйте ещё раз.')
      return false
    }
    const { data: sectionRows, error: sectionError } = sectionResult
    if (sectionError) { setAppError(sectionError.message); return false }
    setSections((sectionRows ?? []).map(mapSection))
    onReady?.()

    void withAvatarUrls([rawProfile]).then(([profileWithAvatar]) => {
      if (!profileWithAvatar) return
      setProfile((current) => current?.id === profileWithAvatar.id ? profileWithAvatar : current)
    })

    const canLoadParticipants = FULL_ACCESS_ROLES.includes(rawProfile.role)
    const canLoadMaterials = FULL_ACCESS_ROLES.includes(rawProfile.role) || rawProfile.role === 'admin' || rawProfile.sections.includes(COLLECTION_SECTION)
    const participantsPromise = canLoadParticipants
      ? supabase.from('profiles').select('*').order('created_at')
      : Promise.resolve({ data: [] as Participant[], error: null })
    const materialsPromise = canLoadMaterials
      ? supabase.from('materials').select('*').order('created_at')
      : Promise.resolve({ data: [], error: null })
    const eventPromise = supabase.from('calendar_events').select('*').order('event_date').order('start_time')
    const schedulePromise = supabase.from('schedule_entries').select('*').order('event_date').order('start_time')
    const datedAbsencePromise = supabase.from('schedule_absences').select('*')
    const absencePromise = supabase.from('schedule_regular_absences').select('*')
    const scheduleNamesPromise = supabase.rpc('get_schedule_participant_names')
    const contentPlanPromise = supabase.from('content_plan_items').select('*').order('content_date').order('created_at')

    let backgroundResults
    try {
      backgroundResults = await withTimeout(Promise.all([
        eventPromise,
        schedulePromise,
        datedAbsencePromise,
        absencePromise,
        scheduleNamesPromise,
        contentPlanPromise,
        participantsPromise,
        materialsPromise,
      ]), BACKGROUND_REQUEST_TIMEOUT)
    } catch {
      setAppError('Часть данных загружается дольше обычного. Главный экран уже доступен — попробуйте открыть раздел ещё раз.')
      return true
    }
    const [eventResult, scheduleResult, datedAbsenceResult, absenceResult, scheduleNamesResult, contentPlanResult, participantsResult, materialsResult] = backgroundResults
    const { data: eventRows, error: eventError } = eventResult
    if (eventError && eventError.code !== 'PGRST205') setAppError(eventError.message)
    else setCalendarEvents((eventRows ?? []).map(mapCalendarEvent))
    const { data: scheduleRows, error: scheduleError } = scheduleResult
    if (scheduleError && scheduleError.code !== 'PGRST205') setAppError(scheduleError.message)
    else setScheduleEntries((scheduleRows ?? []).map(mapScheduleEntry))
    const { data: datedAbsenceRows, error: datedAbsenceError } = datedAbsenceResult
    if (datedAbsenceError && datedAbsenceError.code !== 'PGRST205') setAppError(datedAbsenceError.message)
    else setScheduleAbsences((datedAbsenceRows ?? []).map(mapScheduleAbsence))
    const { data: absenceRows, error: absenceError } = absenceResult
    if (absenceError && absenceError.code !== 'PGRST205') setAppError(absenceError.message)
    else setScheduleRegularAbsences((absenceRows ?? []).map(mapScheduleRegularAbsence))
    const { data: scheduleNames, error: scheduleNamesError } = scheduleNamesResult
    if (!scheduleNamesError) setScheduleParticipantNames(Object.fromEntries(((scheduleNames ?? []) as Record<string, unknown>[]).map((item) => [String(item.profile_id), String(item.profile_name)])))
    const { data: contentPlanRows, error: contentPlanError } = contentPlanResult
    if (contentPlanError && contentPlanError.code !== 'PGRST205') setAppError(contentPlanError.message)
    else setContentPlanItems((contentPlanRows ?? []).map(mapContentPlanItem))
    if (canLoadParticipants) {
      if (participantsResult.error) setAppError(participantsResult.error.message)
      else {
        const loadedParticipants = (participantsResult.data ?? []).map(mapParticipant)
        setParticipants(loadedParticipants)
        void withAvatarUrls(loadedParticipants).then(setParticipants)
      }
    } else setParticipants([rawProfile])
    if (canLoadMaterials) {
      if (materialsResult.error) setAppError(materialsResult.error.message)
      else {
        const loadedMaterials = (materialsResult.data ?? []).map(mapMaterial)
        setMaterials(loadedMaterials)
        const canPurgeExpired = FULL_ACCESS_ROLES.includes(rawProfile.role)
        const expiredMaterials = canPurgeExpired
          ? loadedMaterials.filter((item) => item.deletedAt && Date.now() - item.deletedAt >= 30 * DAY)
          : []
        if (expiredMaterials.length) void (async () => {
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
          if (purgedIds.size) setMaterials((current) => current.filter((item) => !purgedIds.has(item.id)))
        })()
      }
    } else setMaterials([])
    return true
  }

  async function loadWardrobeItems(showLoading = true) {
    if (showLoading) setWardrobeLoading(true)
    try {
      const { data, error } = await withTimeout(
        supabase.from('wardrobe_items').select('*').order('performance').order('updated_at', { ascending: false }),
        BACKGROUND_REQUEST_TIMEOUT,
      )
      if (error) throw error
      setWardrobeItems((data ?? []).map(mapWardrobeItem))
    } catch (error) {
      setAppError(error instanceof Error ? error.message : 'Не удалось загрузить костюмерную')
    } finally {
      if (showLoading) setWardrobeLoading(false)
    }
  }

  async function loadPolicySignatures(showLoading = true) {
    if (showLoading) setPolicySignaturesLoading(true)
    try {
      const { data, error } = await withTimeout(
        supabase.from('participation_policy_signatures').select('profile_id, signer_name, policy_version, signed_at').order('signed_at', { ascending: false }),
        BACKGROUND_REQUEST_TIMEOUT,
      )
      if (error) throw error
      setPolicySignatures((data ?? []).map((row) => ({
        profileId: row.profile_id,
        signerName: row.signer_name,
        policyVersion: row.policy_version,
        signedAt: row.signed_at,
      })))
    } catch (error) {
      setAppError(error instanceof Error ? error.message : 'Не удалось загрузить подписи положения')
    } finally {
      if (showLoading) setPolicySignaturesLoading(false)
    }
  }

  useEffect(() => {
    localStorage.removeItem(LEGACY_SESSION_KEY)
    sessionStorage.removeItem(LEGACY_SESSION_KEY)
    const token = localStorage.getItem(HUB_SESSION_KEY)
    if (!token) { setHubAccess('locked'); return }

    let cancelled = false
    setHubAccess('unlocked')
    withTimeout(supabase.rpc('validate_hub_session', { session_token: token }), STARTUP_REQUEST_TIMEOUT).then(({ data, error }) => {
      if (cancelled) return
      if (!error && data === false) {
        localStorage.removeItem(HUB_SESSION_KEY)
        setHubAccess('locked')
      }
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    const startupWatchdog = window.setTimeout(() => {
      if (cancelled) return
      setInitialDataError('Сервер отвечает слишком долго. Нажмите «Повторить» — бесконечной загрузки больше не будет.')
      setInitialDataLoading(false)
    }, STARTUP_REQUEST_TIMEOUT + 2000)

    const revealInitialData = async (activeSession: Session | null, activePersonalSession: string | null) => {
      let revealed = false
      const loaded = await loadData(activeSession, activePersonalSession, () => {
        revealed = true
        if (cancelled) return
        window.clearTimeout(startupWatchdog)
        setInitialDataError('')
        setInitialDataLoading(false)
      })
      if (cancelled) return
      if (!revealed) {
        window.clearTimeout(startupWatchdog)
        setInitialDataError(loaded ? '' : 'Не удалось загрузить ваш профиль. Проверьте соединение и попробуйте ещё раз.')
        setInitialDataLoading(false)
      }
    }

    if (personalSession) {
      void revealInitialData(null, personalSession)
      void withTimeout(supabase.auth.getSession(), STARTUP_REQUEST_TIMEOUT).then(({ data }) => {
        if (!cancelled) setSession(data.session)
      }).catch(() => undefined)
    } else {
      withTimeout(supabase.auth.getSession(), STARTUP_REQUEST_TIMEOUT).then(({ data }) => {
        if (cancelled) return
        setSession(data.session)
        return revealInitialData(data.session, null)
      }).catch(() => {
        if (cancelled) return
        window.clearTimeout(startupWatchdog)
        setInitialDataError('Не удалось загрузить ваш профиль. Проверьте соединение и попробуйте ещё раз.')
        setInitialDataLoading(false)
      })
    }

    const { data: listener } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (cancelled) return
      if (event === 'INITIAL_SESSION') return
      setSession(nextSession)
      window.setTimeout(() => loadData(nextSession, personalSession), 0)
      if (nextSession && screen === 'auth') setScreen(returnScreen)
    })
    return () => { cancelled = true; window.clearTimeout(startupWatchdog); listener.subscription.unsubscribe() }
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
      .on('postgres_changes', { event: '*', schema: 'public', table: 'schedule_absences' }, () => loadData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'schedule_regular_absences' }, () => loadData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'content_plan_items' }, () => loadData())
      .subscribe()
    return () => { window.clearInterval(refreshTimer); supabase.removeChannel(channel) }
  }, [session?.user.id, personalSession, profile?.role])

  useEffect(() => {
    if (screen !== 'wardrobe' || !profile) return
    void loadWardrobeItems()
    const timer = window.setInterval(() => loadWardrobeItems(false), 30000)
    return () => window.clearInterval(timer)
  }, [screen, profile?.id])

  useEffect(() => {
    if ((screen !== 'policy' && screen !== 'settings') || !profile) return
    void loadPolicySignatures()
  }, [screen, profile?.id])

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
    event.preventDefault(); setPasswordError(false); setHubLoginError('')
    const attempt = String(new FormData(event.currentTarget).get('password'))
    let result
    try {
      result = await withTimeout(supabase.rpc('login_with_hub_password', { attempt }), 15000)
    } catch {
      await new Promise((resolve) => window.setTimeout(resolve, 600))
      try {
        result = await withTimeout(supabase.rpc('login_with_hub_password', { attempt }), 15000)
      } catch {
        setHubLoginError('Не удалось связаться с сервером. Проверьте интернет и нажмите «Войти» ещё раз.')
        return
      }
    }
    const { data, error } = result
    const response = data as { status?: string; token?: string } | null
    if (!error && response?.status === 'ok' && response.token) {
      localStorage.setItem(HUB_SESSION_KEY, response.token)
      setHubAccess('unlocked')
    } else if (!error && response?.status === 'wrong_password') setPasswordError(true)
    else setHubLoginError('Сервер не смог проверить пароль. Нажмите «Войти» ещё раз.')
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
    setProfile(null); setParticipants([]); setMaterials([]); setSections([]); setCalendarEvents([]); setScheduleEntries([]); setContentPlanItems([]); setWardrobeItems([]); setPolicySignatures([]); setScreen('hub')
  }
  function requireAccess(target: Screen) {
    if (!profile) { setReturnScreen(target); setScreen('auth'); return }
    if (target === 'collection' && !canOpenCollection) { setAppError('Для вашей роли пока нет доступа к копилке.'); return }
    if (target === 'calendar' && !canOpenCalendar) { setAppError('Для вашей роли нет доступа к календарю.'); return }
    if (target === 'schedule' && !canOpenSchedule) { setAppError('Для вашей роли нет доступа к расписанию.'); return }
    if (target === 'contentPlan' && !canOpenContentPlan) { setAppError('Для вашей роли нет доступа к контент-плану.'); return }
    if (target === 'wardrobe' && !canOpenWardrobe) { setAppError('Для вашей роли нет доступа к костюмерной.'); return }
    if (target === 'policy' && !canOpenPolicy) { setAppError('Для вашего профиля нет доступа к положению об участии.'); return }
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
      participant_sections: [], initial_password: String(data.get('personalPassword')),
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

  async function reorderSections(nextSections: WorkspaceSection[]) {
    if (!canManageMembers) return false
    const previousSections = sections
    const orderedSections = nextSections.map((section, index) => ({ ...section, sortOrder: (index + 1) * 10 }))
    setSections(orderedSections)
    const results = await Promise.all(orderedSections.map((section) => supabase.from('sections').update({ sort_order: section.sortOrder }).eq('id', section.id)))
    if (results.some(({ error }) => error)) {
      await Promise.all(previousSections.map((section) => supabase.from('sections').update({ sort_order: section.sortOrder }).eq('id', section.id)))
      setSections(previousSections)
      setAppError('Не удалось сохранить порядок разделов. Попробуйте ещё раз.')
      return false
    }
    setAppNotice('Порядок разделов сохранён для всех участников')
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
    if (!profile || !FULL_ACCESS_ROLES.includes(profile.role)) return false
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
    if (!FULL_ACCESS_ROLES.includes(currentRole) || !window.confirm(`Удалить событие «${item.title}» ${item.eventDate}? Оно исчезнет из календаря и синхронизированного расписания. Это действие нельзя отменить.`)) return
    const { error } = await supabase.from('calendar_events').delete().eq('id', item.id)
    if (error) { setAppError(error.message); return }
    const paths = item.attachments.flatMap((file) => file.path ? [file.path] : [])
    if (paths.length) await supabase.storage.from('calendar').remove(paths)
    setAppNotice('Событие удалено')
    await loadData()
  }

  async function saveScheduleEntry(input: ScheduleEntryInput, initial: ScheduleEntry | null) {
    if (!profile || !FULL_ACCESS_ROLES.includes(profile.role)) return false
    if (input.endTime && input.endTime <= input.startTime) { setAppError('Время окончания должно быть позже времени начала.'); return false }
    if (initial?.seriesId) {
      const { error: seriesError } = await supabase.rpc('update_schedule_series', {
        target_series_id: initial.seriesId,
        series_start_time: input.startTime,
        series_end_time: input.endTime,
        series_teacher: input.teacher,
        series_class_name: input.className,
        series_topic: input.topic,
      })
      if (seriesError) { setAppError(seriesError.message); return false }
      const { error: absenceError } = await supabase.from('schedule_entries').update({ absence: input.absence }).eq('id', initial.id)
      if (absenceError) { setAppError(absenceError.message); return false }
      setAppNotice('Регулярное занятие обновлено во всей серии')
      await loadData()
      return true
    }
    if (!initial && input.makeRecurring && input.repeatUntil) {
      const { data, error } = await supabase.rpc('create_schedule_series', {
        series_start_date: input.eventDate,
        series_end_date: input.repeatUntil,
        series_start_time: input.startTime,
        series_end_time: input.endTime,
        series_teacher: input.teacher,
        series_class_name: input.className,
        series_topic: input.topic,
      })
      if (error) { setAppError(error.message); return false }
      const result = data as { created_count?: number; skipped_holidays?: number } | null
      const skipped = Number(result?.skipped_holidays ?? 0)
      setAppNotice(`Создано регулярных занятий: ${Number(result?.created_count ?? 0)}${skipped ? `. Праздничных дат пропущено: ${skipped}` : ''}`)
      await loadData()
      return true
    }
    const payload = { event_date: input.eventDate, start_time: input.startTime, end_time: input.endTime, teacher: input.teacher, class_name: input.className, topic: input.topic, absence: input.absence }
    const { error } = initial ? await supabase.from('schedule_entries').update(payload).eq('id', initial.id) : await supabase.from('schedule_entries').insert({ ...payload, author_id: profile.id })
    if (error) { setAppError(error.message); return false }
    setAppNotice(initial ? 'Запись расписания обновлена' : 'Запись добавлена в расписание')
    await loadData()
    return true
  }

  async function deleteScheduleEntry(item: ScheduleEntry) {
    const title = item.className || 'Занятие'
    const prompt = item.seriesId ? `Удалить регулярное занятие «${title}» и все даты этой серии? Это действие нельзя отменить.` : `Удалить запись «${title}» ${item.eventDate}? Это действие нельзя отменить.`
    if (!FULL_ACCESS_ROLES.includes(currentRole) || !window.confirm(prompt)) return
    const { error } = item.seriesId ? await supabase.rpc('delete_schedule_series', { target_series_id: item.seriesId }) : await supabase.from('schedule_entries').delete().eq('id', item.id)
    if (error) { setAppError(error.message); return }
    setAppNotice(item.seriesId ? 'Регулярное занятие и вся серия удалены' : 'Запись расписания удалена')
    await loadData()
  }

  async function saveOwnRegularAbsence(seriesId: string, reason: string) {
    if (!profile) return false
    const { error } = await supabase.rpc('set_own_regular_absence', { target_series_id: seriesId, absence_reason: reason })
    if (error) { setAppError(error.message); return false }
    setAppNotice(reason ? 'Регулярное отсутствие сохранено во всей серии' : 'Регулярное отсутствие убрано из всей серии')
    await loadData()
    return true
  }

  async function saveOwnAbsence(entryId: string, reason: string) {
    if (!profile) return false
    const { error } = await supabase.rpc('set_own_schedule_absence', { target_entry_id: entryId, absence_reason: reason })
    if (error) { setAppError(error.message); return false }
    setAppNotice(reason ? 'Отсутствие на эту дату сохранено' : 'Отсутствие на эту дату убрано')
    await loadData()
    return true
  }

  async function uploadContentPlanFiles(files: ContentPlanAttachment[], itemId: string) {
    const result: ContentPlanAttachment[] = []
    for (const attachment of files) {
      if (!attachment.file) { const { file: _file, ...stored } = attachment; result.push(stored); continue }
      const cleanName = attachment.name.replace(/[^a-zA-Zа-яА-ЯёЁ0-9._-]+/g, '-').slice(-100)
      const path = `${itemId}/${crypto.randomUUID()}-${cleanName}`
      await uploadStorageFile('content-plan', path, attachment.file)
      result.push({ id: attachment.id, name: attachment.name, size: attachment.size, type: attachment.type, path })
    }
    return result
  }

  async function saveContentPlanItem(input: ContentPlanInput, initial: ContentPlanItem | null) {
    if (!profile || !CONTENT_PLAN_MANAGER_ROLES.includes(profile.role)) return false
    const itemId = initial?.id ?? crypto.randomUUID()
    try {
      const attachments = await uploadContentPlanFiles(input.attachments, itemId)
      const payload = { kind: input.kind, content_date: input.contentDate, description: input.description, format: input.format, responsible: input.responsible, link: input.link, attachments, updated_at: new Date().toISOString() }
      const { error } = initial
        ? await supabase.from('content_plan_items').update(payload).eq('id', itemId)
        : await supabase.from('content_plan_items').insert({ id: itemId, ...payload, author_id: profile.id })
      if (error) throw error
      const keptPaths = new Set(attachments.flatMap((file) => file.path ? [file.path] : []))
      const removedPaths = (initial?.attachments ?? []).flatMap((file) => file.path && !keptPaths.has(file.path) ? [file.path] : [])
      if (removedPaths.length) await supabase.storage.from('content-plan').remove(removedPaths)
      setAppNotice(initial ? 'Строка контент-плана обновлена' : 'Строка добавлена в контент-план')
      await loadData()
      return true
    } catch (error) {
      setAppError(error instanceof Error ? error.message : 'Не удалось сохранить строку контент-плана')
      return false
    }
  }

  async function deleteContentPlanItem(item: ContentPlanItem) {
    if (!CONTENT_PLAN_MANAGER_ROLES.includes(currentRole) || !window.confirm(`Удалить строку контент-плана за ${item.contentDate}? Это действие нельзя отменить.`)) return
    const paths = item.attachments.flatMap((file) => file.path ? [file.path] : [])
    if (paths.length) {
      const { error: storageError } = await supabase.storage.from('content-plan').remove(paths)
      if (storageError) { setAppError('Не удалось удалить прикреплённые файлы. Строка сохранена.'); return }
    }
    const { error } = await supabase.from('content_plan_items').delete().eq('id', item.id)
    if (error) { setAppError(error.message); return }
    setAppNotice('Строка контент-плана удалена')
    await loadData()
  }

  async function saveWardrobeItem(input: WardrobeItemInput, initial: WardrobeItem | null) {
    if (!profile || !FULL_ACCESS_ROLES.includes(profile.role)) return false
    const payload = { performance: input.performance, item_quantity: input.itemQuantity }
    const { error } = initial
      ? await supabase.from('wardrobe_items').update(payload).eq('id', initial.id)
      : await supabase.from('wardrobe_items').insert(payload)
    if (error) { setAppError(error.message); return false }
    setAppNotice(initial ? 'Строка костюмерной обновлена' : 'Строка добавлена в костюмерную')
    await loadWardrobeItems(false)
    return true
  }

  async function deleteWardrobeItem(item: WardrobeItem) {
    if (!FULL_ACCESS_ROLES.includes(currentRole) || !window.confirm(`Удалить строку «${item.performance} — ${item.itemQuantity}»? Это действие нельзя отменить.`)) return
    const { error } = await supabase.from('wardrobe_items').delete().eq('id', item.id)
    if (error) { setAppError(error.message); return }
    setAppNotice('Строка костюмерной удалена')
    await loadWardrobeItems(false)
  }

  async function signParticipationPolicy() {
    if (!profile || !canOpenPolicy || policySignatures.some((item) => item.profileId === profile.id && item.policyVersion === POLICY_VERSION)) return
    if (!window.confirm('Подтверждаете, что прочитали положение версии 1.1 полностью и согласны с каждым его пунктом? Подпись будет зафиксирована с вашим ФИО и текущей датой.')) return
    setPolicySigning(true)
    const { error } = await supabase.from('participation_policy_signatures').insert({
      profile_id: profile.id,
      signer_name: profile.name,
      policy_version: POLICY_VERSION,
    })
    if (error && error.code !== '23505') setAppError(error.message)
    else {
      setAppNotice(error?.code === '23505' ? 'Положение уже было подписано' : 'Положение подписано')
      await loadPolicySignatures(false)
    }
    setPolicySigning(false)
  }

  const installButton = !isInstalled && <button className="text-button install-button" type="button" onClick={installApp}>⇩ Установить</button>
  const installHelp = showInstallHelp && <InstallHelp onClose={() => setShowInstallHelp(false)} />
  const visibleAppError = /failed to fetch/i.test(appError) ? 'Нет связи с сервером. Проверьте интернет.' : appError

  if (hubAccess === 'checking' || (hubAccess === 'unlocked' && initialDataLoading)) return <StartupScreen error={initialDataError} />
  if (hubAccess === 'unlocked' && initialDataError) return <StartupScreen error={initialDataError} />
  if (hubAccess === 'locked') return <main className="gate-shell"><section className="gate-panel"><div className="logo-mark">Т·А·М</div><p className="eyebrow">Камерный театр-лаборатория</p><h1>Рабочий воркхаб</h1><form onSubmit={unlock}><label htmlFor="hub-password">Общий пароль</label><input id="hub-password" name="password" type="password" autoComplete="current-password" autoFocus />{passwordError && <p className="form-error">Неверный пароль</p>}{hubLoginError && <p className="form-error">{hubLoginError}</p>}<button className="button button-solid" type="submit">Войти</button></form>{installButton}</section>{installHelp}</main>

  return <div className="app-shell">
    <header className="app-header"><button className="brand" type="button" onClick={() => setScreen('hub')}><span className="logo-mark small">Т·А·М</span><span><b>Камерный театр-лаборатория Т.А.М.</b><small>Рабочий воркхаб</small></span></button><div className="account-area">{installButton}<div className="user-chip">{profile && <button className="profile-notification-button" type="button" aria-label="Настройки уведомлений" onClick={openNotificationSettings}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></svg></button>}{profile ? <ParticipantAvatar participant={profile} editable uploading={uploadingAvatar} onSelect={uploadOwnAvatar} /> : <span className="header-avatar-fallback">О</span>}<span><b>{profile?.name ?? 'Общий вход'}</b><small>{profile ? ROLE_LABELS[profile.role] : 'Без личного входа'}</small></span></div>{profile ? <button className="text-button header-logout" type="button" onClick={logout}>Выйти</button> : <button className="text-button header-logout" type="button" onClick={() => { setReturnScreen('hub'); setScreen('auth') }}>Личный вход</button>}</div></header>
    {installHelp}
    {showNotificationSettings && profile && <NotificationSettings preferences={notificationPreferences} permission={notificationPermission} saving={savingNotifications} onChange={setNotificationPreferences} onSave={saveNotificationPreferences} onEnable={enablePushNotifications} onDisable={disablePushNotifications} onClose={() => setShowNotificationSettings(false)} />}
    {(appError || appNotice) && <div className="app-toast-stack" aria-live="polite">
      {appError && <div className="app-alert" role="alert"><span>{visibleAppError}</span><button type="button" aria-label="Закрыть уведомление" onClick={() => setAppError('')}>×</button></div>}
      {appNotice && <div className="app-alert success" role="status"><span>{appNotice}</span><button type="button" aria-label="Закрыть уведомление" onClick={() => setAppNotice('')}>×</button></div>}
    </div>}
    <div className={`screen-stage screen-stage-${screen}`} key={screen}>
      {screen === 'hub' && <Hub profile={profile} sections={sections} canOpenCollection={canOpenCollection} canOpenCalendar={canOpenCalendar} canOpenSchedule={canOpenSchedule} canOpenContentPlan={canOpenContentPlan} canOpenWardrobe={canOpenWardrobe} canOpenPolicy={canOpenPolicy} canInvite={canInvite} canCreateSections={canCreateSections} onCollection={() => requireAccess('collection')} onCalendar={() => requireAccess('calendar')} onSchedule={() => requireAccess('schedule')} onContentPlan={() => requireAccess('contentPlan')} onWardrobe={() => requireAccess('wardrobe')} onPolicy={() => requireAccess('policy')} onSettings={() => requireAccess('settings')} onSection={openCustomSection} onCreateSection={createSection} />}
      {screen === 'auth' && <AuthScreen message={authMessage} onSubmit={signInWithPersonalPassword} onBack={() => setScreen('hub')} />}
      {screen === 'collection' && <CollectionScreen title={sections.find((section) => section.id === COLLECTION_SECTION)?.title ?? 'Копилка материалов'} description={sections.find((section) => section.id === COLLECTION_SECTION)?.description ?? 'Общие материалы театра'} materials={filteredMaterials} categories={categories} activeFilters={activeFilters} query={query} trashCount={trashMaterials.length} canManage={FULL_ACCESS_ROLES.includes(currentRole)} canDelete={canDelete} reactionMenu={reactionMenu} openComments={openComments} onBack={() => setScreen('hub')} onAdd={() => { setEditingMaterial(null); setScreen('form') }} onQuery={setQuery} onClear={() => { setQuery(''); setActiveFilters([]) }} onTrashScreen={() => setScreen('trash')} onFilter={(category) => setActiveFilters((current) => current.includes(category) ? current.filter((item) => item !== category) : [...current, category])} onPin={togglePinned} onEdit={(item) => { setEditingMaterial(item); setScreen('form') }} onTrash={moveToTrash} onReactionMenu={setReactionMenu} onReact={react} onComments={setOpenComments} onAddComment={addComment} />}
      {screen === 'form' && <MaterialForm categories={categories} initial={editingMaterial} onCancel={() => { setEditingMaterial(null); setScreen('collection') }} onSave={editingMaterial ? updateMaterial : saveMaterial} />}
      {screen === 'trash' && <TrashScreen materials={trashMaterials} onBack={() => setScreen('collection')} onRestore={restore} onRemove={removeForever} />}
      {screen === 'settings' && <SettingsScreen participants={participants} sections={sections} signatures={policySignatures} signaturesLoading={policySignaturesLoading} canInvite={canInvite} canManageMembers={canManageMembers} onBack={() => setScreen('hub')} onShare={copyInvitation} onInvite={inviteParticipant} onUpdate={updateParticipant} onRemove={removeParticipant} onParticipantPassword={setParticipantPassword} onPassword={changePassword} onUpdateSection={updateSection} onReorderSections={reorderSections} onDeleteSection={deleteSection} />}
      {screen === 'calendar' && <CalendarScreen title={sections.find((section) => section.id === CALENDAR_SECTION)?.title ?? 'Календарь репертуара'} description={sections.find((section) => section.id === CALENDAR_SECTION)?.description ?? 'Показы, репетиции и события театра'} events={calendarEvents} canManage={FULL_ACCESS_ROLES.includes(currentRole)} onBack={() => setScreen('hub')} onSave={saveCalendarEvent} onDelete={deleteCalendarEvent} />}
      {screen === 'schedule' && <ScheduleScreen title={scheduleSection?.title ?? 'Расписание занятий'} description={scheduleSection?.description ?? 'Дата, время, педагог, класс и отсутствие'} events={calendarEvents} entries={scheduleEntries} absences={scheduleAbsences} regularAbsences={scheduleRegularAbsences} participantNames={scheduleParticipantNames} currentProfileId={profile?.id ?? null} canManage={FULL_ACCESS_ROLES.includes(currentRole)} onBack={() => setScreen('hub')} onSaveEvent={saveCalendarEvent} onDeleteEvent={deleteCalendarEvent} onSaveEntry={saveScheduleEntry} onDeleteEntry={deleteScheduleEntry} onSaveAbsence={saveOwnAbsence} onSaveRegularAbsence={saveOwnRegularAbsence} />}
      {screen === 'contentPlan' && contentPlanSection && <ContentPlanScreen title={contentPlanSection.title} description={contentPlanSection.description || 'Публикации, съёмки и разработка контента'} entries={contentPlanItems} canManage={CONTENT_PLAN_MANAGER_ROLES.includes(currentRole)} onBack={() => setScreen('hub')} onSave={saveContentPlanItem} onDelete={deleteContentPlanItem} />}
      {screen === 'wardrobe' && wardrobeSection && <WardrobeScreen title={wardrobeSection.title} description={wardrobeSection.description || 'Костюмы, реквизит и всё необходимое для спектаклей'} items={wardrobeItems} loading={wardrobeLoading} canManage={FULL_ACCESS_ROLES.includes(currentRole)} onBack={() => setScreen('hub')} onSave={saveWardrobeItem} onDelete={deleteWardrobeItem} />}
      {screen === 'policy' && policySection && <ParticipationPolicyScreen title={policySection.title} description={policySection.description || 'Правила участия и обязанности в театре Т.А.М.'} signature={policySignatures.find((item) => item.profileId === profile?.id && item.policyVersion === POLICY_VERSION) ?? null} signing={policySigning} onBack={() => setScreen('hub')} onSign={signParticipationPolicy} />}
      {screen === 'custom' && activeSection && <CustomSectionScreen section={activeSection} onBack={() => setScreen('hub')} />}
    </div>
  </div>
}

function InstallHelp({ onClose }: { onClose: () => void }) {
  const isApple = /iPad|iPhone|iPod/.test(navigator.userAgent)
  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}><section className="install-modal" role="dialog" aria-modal="true" aria-labelledby="install-title" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" type="button" aria-label="Закрыть" onClick={onClose}>×</button><span className="logo-mark small">Т·А·М</span><p className="eyebrow">Установка на телефон</p><h2 id="install-title">Добавить иконку приложения</h2>{isApple ? <ol><li>Откройте меню браузера.</li><li>Выберите <b>Добавить на экран «Домой»</b> или <b>Установить приложение</b>.</li><li>Подтвердите добавление иконки.</li><li>Если ваш браузер не показывает этот пункт, откройте ссылку в другом браузере.</li></ol> : <ol><li>Откройте меню браузера <b>⋮</b>.</li><li>Нажмите <b>Добавить на главный экран</b>.</li><li>Выберите <b>Установить</b> и подтвердите.</li></ol>}<p className="install-note">После этого появится отдельная иконка «Т.А.М.», а приложение будет открываться без адресной строки.</p><button className="button button-solid" type="button" onClick={onClose}>Понятно</button></section></div>
}

function NotificationSettings({ preferences, permission, saving, onChange, onSave, onEnable, onDisable, onClose }: { preferences: NotificationPreferences | null; permission: NotificationPermission; saving: boolean; onChange: (value: NotificationPreferences) => void; onSave: (value: NotificationPreferences) => void; onEnable: () => void; onDisable: () => void; onClose: () => void }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}><section className="notification-modal" role="dialog" aria-modal="true" aria-labelledby="notification-title" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" type="button" aria-label="Закрыть" onClick={onClose}>×</button><p className="eyebrow">Личные настройки</p><h2 id="notification-title">Уведомления</h2><p className="notification-intro">Напоминания о календаре и классах приходят за 1 час по времени Екатеринбурга. Каждый пользователь настраивает их только для себя.</p>{preferences ? <><div className="notification-device"><div><b>{permission === 'granted' ? 'Уведомления разрешены' : permission === 'denied' ? 'Уведомления запрещены телефоном' : 'Уведомления на устройстве не включены'}</b><small>Подключённых устройств: {preferences.deviceCount}</small></div>{permission === 'granted' ? <button className="button" type="button" disabled={saving} onClick={onDisable}>Отключить на этом устройстве</button> : <button className="button button-solid" type="button" disabled={saving || permission === 'denied'} onClick={onEnable}>Включить на этом устройстве</button>}</div><div className="notification-options"><label><span><b>События, показы и репетиции</b><small>Всё, что добавлено в календарь репертуара</small></span><input type="checkbox" checked={preferences.eventsEnabled} onChange={(event) => onChange({ ...preferences, eventsEnabled: event.target.checked })} /></label><label><span><b>Классы</b><small>Записи из расписания классов и репетиций</small></span><input type="checkbox" checked={preferences.classesEnabled} onChange={(event) => onChange({ ...preferences, classesEnabled: event.target.checked })} /></label><label><span><b>Сообщения в беседах</b><small>Будет использоваться мессенджером</small></span><input type="checkbox" checked={preferences.messagesEnabled} onChange={(event) => onChange({ ...preferences, messagesEnabled: event.target.checked })} /></label></div><button className="button button-solid notification-save" type="button" disabled={saving} onClick={() => onSave(preferences)}>{saving ? 'Сохраняем…' : 'Сохранить настройки'}</button><p className="notification-help">На iPhone уведомления работают у воркхаба, установленного на экран «Домой». Разрешение запрашивается только после нажатия кнопки выше.</p></> : <p>Загружаем настройки…</p>}</section></div>
}

function Hub({ profile, sections, canOpenCollection, canOpenCalendar, canOpenSchedule, canOpenContentPlan, canOpenWardrobe, canOpenPolicy, canInvite, canCreateSections, onCollection, onCalendar, onSchedule, onContentPlan, onWardrobe, onPolicy, onSettings, onSection, onCreateSection }: { profile: Participant | null; sections: WorkspaceSection[]; canOpenCollection: boolean; canOpenCalendar: boolean; canOpenSchedule: boolean; canOpenContentPlan: boolean; canOpenWardrobe: boolean; canOpenPolicy: boolean; canInvite: boolean; canCreateSections: boolean; onCollection: () => void; onCalendar: () => void; onSchedule: () => void; onContentPlan: () => void; onWardrobe: () => void; onPolicy: () => void; onSettings: () => void; onSection: (section: WorkspaceSection) => void; onCreateSection: (event: FormEvent<HTMLFormElement>) => Promise<boolean> }) {
  const [creatingSection, setCreatingSection] = useState(false)
  const collectionSection = sections.find((section) => section.id === COLLECTION_SECTION)
  const calendarSection = sections.find((section) => section.id === CALENDAR_SECTION)
  const scheduleSection = sections.find((section) => section.id === SCHEDULE_SECTION) ?? sections.find((section) => section.id !== COLLECTION_SECTION && section.id !== CALENDAR_SECTION && /расписан/i.test(section.title))
  const contentPlanSection = sections.find((section) => section.id === CONTENT_PLAN_SECTION) ?? sections.find((section) => /контент[- ]план/i.test(section.title))
  const wardrobeSection = sections.find((section) => section.id === WARDROBE_SECTION) ?? sections.find((section) => /костюмер/i.test(section.title))
  const policySection = sections.find((section) => section.id === POLICY_SECTION) ?? sections.find((section) => /положен.*участи|пользовательск.*соглаш/i.test(section.title))
  const accessLabel = (allowed: boolean) => !profile ? 'Личный вход' : !allowed ? 'Нет доступа' : profile.role === 'participant' ? 'Только просмотр' : 'Есть доступ'
  const unavailableClass = (allowed: boolean) => `module-card${profile && !allowed ? ' unavailable' : ''}`

  function sectionCard(section: WorkspaceSection) {
    if (section.id === collectionSection?.id) return <button className={unavailableClass(canOpenCollection)} type="button" disabled={Boolean(profile) && !canOpenCollection} onClick={onCollection} key={section.id}><ModuleIcon name="collection" /><span className="module-copy"><b>{section.title}</b><small>{section.description || 'Ссылки, файлы, идеи и комментарии'}</small></span><span className="access-chip">{accessLabel(canOpenCollection)}</span><span>→</span></button>
    if (section.id === calendarSection?.id) return <button className={unavailableClass(canOpenCalendar)} type="button" disabled={Boolean(profile) && !canOpenCalendar} onClick={onCalendar} key={section.id}><ModuleIcon name="calendar" /><span className="module-copy"><b>{section.title}</b><small>{section.description || 'Показы, репетиции и события'}</small></span><span className="access-chip">{accessLabel(canOpenCalendar)}</span><span>→</span></button>
    if (section.id === scheduleSection?.id) return <button className={unavailableClass(canOpenSchedule)} type="button" disabled={Boolean(profile) && !canOpenSchedule} onClick={onSchedule} key={section.id}><ModuleIcon name="schedule" /><span className="module-copy"><b>{section.title}</b><small>{section.description || 'Дата, время, педагог, класс и отсутствие'}</small></span><span className="access-chip">{accessLabel(canOpenSchedule)}</span><span>→</span></button>
    if (section.id === contentPlanSection?.id) return <button className={unavailableClass(canOpenContentPlan)} type="button" disabled={Boolean(profile) && !canOpenContentPlan} onClick={onContentPlan} key={section.id}><ModuleIcon name="contentPlan" /><span className="module-copy"><b>{section.title}</b><small>{section.description || 'Публикации, съёмки и разработка контента'}</small></span><span className="access-chip">{accessLabel(canOpenContentPlan)}</span><span>→</span></button>
    if (section.id === wardrobeSection?.id) return <button className={unavailableClass(canOpenWardrobe)} type="button" disabled={Boolean(profile) && !canOpenWardrobe} onClick={onWardrobe} key={section.id}><ModuleIcon name="wardrobe" /><span className="module-copy"><b>{section.title}</b><small>{section.description || 'Костюмы, реквизит и всё необходимое для спектаклей'}</small></span><span className="access-chip">{!profile ? 'Личный вход' : !canOpenWardrobe ? 'Нет доступа' : FULL_ACCESS_ROLES.includes(profile.role) ? 'Редактирование' : 'Только просмотр'}</span><span>→</span></button>
    if (section.id === policySection?.id) return <button className={unavailableClass(canOpenPolicy)} type="button" disabled={Boolean(profile) && !canOpenPolicy} onClick={onPolicy} key={section.id}><ModuleIcon name="policy" /><span className="module-copy"><b>{section.title}</b><small>{section.description || 'Правила участия и обязанности в театре Т.А.М.'}</small></span><span className="access-chip">{!profile ? 'Личный вход' : !canOpenPolicy ? 'Нет доступа' : 'Прочитать и подписать'}</span><span>→</span></button>
    const allowed = profileHasSectionAccess(profile, section.id, sections)
    return <button className={unavailableClass(allowed)} type="button" disabled={Boolean(profile) && !allowed} key={section.id} onClick={() => onSection(section)}><ModuleIcon name="draft" /><span className="module-copy"><b>{section.title}</b><small>{section.description || 'Раздел театра'}</small></span><span className="access-chip">{accessLabel(allowed)}</span><span>→</span></button>
  }

  return <main><section className="work-header hub-hero"><div><p className="eyebrow inverse">Рабочая зона</p><h1>Разделы театра</h1></div><WorkhubMedia /></section><section className="module-grid" aria-label="Разделы театра">
    {sections.map(sectionCard)}
    <button className={unavailableClass(canInvite)} type="button" disabled={Boolean(profile) && !canInvite} onClick={onSettings}><ModuleIcon name="settings" /><span className="module-copy"><b>Участники и настройки</b><small>Роли, доступы, личные пароли и общий пароль</small></span><span className="access-chip">{accessLabel(canInvite)}</span><span>→</span></button>
    {canCreateSections && !creatingSection && <button className="module-card" type="button" onClick={() => setCreatingSection(true)}><ModuleIcon name="add" /><span className="module-copy"><b>Новый раздел</b><small>Добавить название будущего раздела</small></span><span className="access-chip">Добавить</span><span>→</span></button>}
    {canCreateSections && creatingSection && <form className="module-card section-create-form" onSubmit={async (event) => { if (await onCreateSection(event)) setCreatingSection(false) }}><ModuleIcon name="add" /><div className="section-create-fields"><b>Новый раздел</b><input name="sectionTitle" placeholder="Название раздела" minLength={2} maxLength={80} autoFocus required /><input name="sectionDescription" placeholder="Краткое описание (необязательно)" maxLength={140} /></div><div className="section-create-actions"><button className="button" type="button" onClick={() => setCreatingSection(false)}>Отмена</button><button className="button button-solid" type="submit">Создать</button></div></form>}
  </section></main>
}

function CustomSectionScreen({ section, onBack }: { section: WorkspaceSection; onBack: () => void }) {
  if (/хранилищ/i.test(section.title)) return <YandexStorageScreen title={section.title} description={section.description} onBack={onBack} />
  return <main><section className="work-header compact"><button className="icon-button inverse" type="button" aria-label="Назад" onClick={onBack}>←</button><div><h1>{section.title}</h1><p>{section.description}</p></div></section></main>
}

function SectionManagement({ sections, onUpdateSection, onReorderSections, onDeleteSection }: { sections: WorkspaceSection[]; onUpdateSection: (id: string, event: FormEvent<HTMLFormElement>) => Promise<boolean>; onReorderSections: (sections: WorkspaceSection[]) => Promise<boolean>; onDeleteSection: (section: WorkspaceSection) => void }) {
  const [editingSection, setEditingSection] = useState<string | null>(null)
  const [draggingSection, setDraggingSection] = useState<string | null>(null)
  const [savingOrder, setSavingOrder] = useState(false)

  async function saveOrder(nextSections: WorkspaceSection[]) {
    if (savingOrder || nextSections.every((section, index) => section.id === sections[index]?.id)) return
    setSavingOrder(true)
    await onReorderSections(nextSections)
    setSavingOrder(false)
  }

  function moveSection(sectionId: string, direction: -1 | 1) {
    const currentIndex = sections.findIndex((section) => section.id === sectionId)
    const nextIndex = currentIndex + direction
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= sections.length) return
    const nextSections = [...sections]
    const [moved] = nextSections.splice(currentIndex, 1)
    nextSections.splice(nextIndex, 0, moved)
    void saveOrder(nextSections)
  }

  function dropSection(targetId: string) {
    if (!draggingSection || draggingSection === targetId) return setDraggingSection(null)
    const nextSections = [...sections]
    const sourceIndex = nextSections.findIndex((section) => section.id === draggingSection)
    const targetIndex = nextSections.findIndex((section) => section.id === targetId)
    if (sourceIndex < 0 || targetIndex < 0) return setDraggingSection(null)
    const [moved] = nextSections.splice(sourceIndex, 1)
    nextSections.splice(targetIndex, 0, moved)
    setDraggingSection(null)
    void saveOrder(nextSections)
  }

  return <section className="section-management settings-section-management" role="tabpanel"><p className="section-management-note">Перетащите разделы за ручку или используйте стрелки. Этот порядок сразу станет главным экраном для всех участников.</p>{sections.map((section, index) => <article className={`section-management-row${draggingSection === section.id ? ' dragging' : ''}`} key={section.id} onDragOver={(event) => event.preventDefault()} onDrop={() => dropSection(section.id)}>{editingSection === section.id ? <form onSubmit={async (event) => { if (await onUpdateSection(section.id, event)) setEditingSection(null) }}><label><span>Название</span><input name="sectionTitle" defaultValue={section.title} minLength={2} maxLength={80} required autoFocus /></label><label><span>Описание</span><input name="sectionDescription" defaultValue={section.description} maxLength={140} /></label><div><button className="button" type="button" onClick={() => setEditingSection(null)}>Отмена</button><button className="button button-solid" type="submit">Сохранить</button></div></form> : <><button className="section-drag-handle" type="button" draggable={!savingOrder} disabled={savingOrder} aria-label={`Перетащить раздел ${section.title}`} title="Перетащить" onDragStart={() => setDraggingSection(section.id)} onDragEnd={() => setDraggingSection(null)}>⠿</button><div><b>{section.title}</b><p>{section.description || 'Без описания'}</p></div><div className="section-management-actions"><button className="icon-button" type="button" disabled={savingOrder || index === 0} aria-label={`Поднять раздел ${section.title}`} onClick={() => moveSection(section.id, -1)}>↑</button><button className="icon-button" type="button" disabled={savingOrder || index === sections.length - 1} aria-label={`Опустить раздел ${section.title}`} onClick={() => moveSection(section.id, 1)}>↓</button><button className="icon-button" type="button" aria-label={`Редактировать раздел ${section.title}`} onClick={() => setEditingSection(section.id)}>✎</button><button className="icon-button danger" type="button" aria-label={`Удалить раздел ${section.title}`} onClick={() => onDeleteSection(section)}>×</button></div></>}</article>)}</section>
}

function AuthScreen({ message, onSubmit, onBack }: { message: string; onSubmit: (event: FormEvent<HTMLFormElement>) => void; onBack: () => void }) {
  return <main><section className="work-header compact"><button className="icon-button inverse" type="button" aria-label="Назад" onClick={onBack}>←</button><div><h1>Личный вход</h1><p>Почта и постоянный личный пароль</p></div></section><form className="auth-form" autoComplete="off" onSubmit={onSubmit}><label>Почта участника<input name="email" type="email" placeholder="name@example.com" autoComplete="off" required autoFocus /></label><label>Личный пароль<input name="personalPassword" type="password" minLength={6} autoComplete="off" required /></label><button className="button button-solid" type="submit">Войти</button>{message && <p className="auth-message" role="status">{message}</p>}</form></main>
}

type CollectionProps = { title: string; description: string; materials: Material[]; categories: string[]; activeFilters: string[]; query: string; trashCount: number; canManage: boolean; canDelete: boolean; reactionMenu: string | null; openComments: string | null; onBack: () => void; onAdd: () => void; onQuery: (value: string) => void; onClear: () => void; onTrashScreen: () => void; onFilter: (category: string) => void; onPin: (id: string) => void; onEdit: (item: Material) => void; onTrash: (id: string) => void; onReactionMenu: (id: string | null) => void; onReact: (id: string, emoji: string) => void; onComments: (id: string | null) => void; onAddComment: (id: string, text: string) => void }
function CollectionScreen(props: CollectionProps) {
  return <main><section className="work-header compact"><button className="icon-button inverse" type="button" aria-label="Назад" onClick={props.onBack}>←</button><div><h1>{props.title}</h1><p>{props.description}</p></div>{props.canManage && <button className="button inverse-button" type="button" onClick={props.onAdd}>＋ Добавить</button>}</section>
    <section className="collection-tools"><label className="search-box"><span>⌕</span><input value={props.query} onChange={(event) => props.onQuery(event.target.value)} placeholder="Поиск по всем полям" /></label><button className="button" type="button" onClick={props.onClear}>Очистить</button>{props.canDelete && <button className="button" type="button" onClick={props.onTrashScreen}>Корзина{props.trashCount ? ` · ${props.trashCount}` : ''}</button>}</section>
    <section className="filters" aria-label="Фильтры"><span>Фильтр:</span>{props.categories.map((category) => <button className={props.activeFilters.includes(category) ? 'filter active' : 'filter'} type="button" key={category} onClick={() => props.onFilter(category)}>{category}</button>)}</section>
    <section className="materials" aria-live="polite"><div className="desktop-table"><div className="material-row table-head"><span>Важно</span><span>Источник</span><span>Для чего</span><span>Что внутри</span><span>Реакции</span><span></span></div>{props.materials.map((item) => <MaterialRow key={item.id} item={item} mobile={false} {...props} commentsOpen={props.openComments} />)}</div><div className="mobile-cards">{props.materials.map((item) => <MaterialRow key={item.id} item={item} mobile {...props} commentsOpen={props.openComments} />)}</div>{!props.materials.length && <div className="empty-state">Здесь пока нет материалов</div>}</section>
  </main>
}

type RowProps = { item: Material; mobile: boolean; canManage: boolean; canDelete: boolean; reactionMenu: string | null; commentsOpen: string | null; onPin: (id: string) => void; onEdit: (item: Material) => void; onTrash: (id: string) => void; onReactionMenu: (id: string | null) => void; onReact: (id: string, emoji: string) => void; onComments: (id: string | null) => void; onAddComment: (id: string, text: string) => void }
function MaterialRow({ item, mobile, canManage, canDelete, reactionMenu, commentsOpen, onPin, onEdit, onTrash, onReactionMenu, onReact, onComments, onAddComment }: RowProps) {
  const [comment, setComment] = useState(''); const longPressTimer = useRef<number | null>(null); const longPressTriggered = useRef(false)
  const style = { '--row-color': `var(--category-${Math.abs(Array.from(normalize(item.category)).reduce((sum, letter) => sum + letter.codePointAt(0)!, 0)) % 6 + 1})` } as React.CSSProperties
  const reactionCount = Object.values(item.reactions).reduce((sum, count) => sum + count, 0)
  const reactionSummary = reactionCount ? Object.entries(item.reactions).filter(([, count]) => count).map(([emoji, count]) => `${emoji}${count}`).join(' ') : 'Нет реакций'
  const reactions = <div className="reaction-area">{canManage ? <button className="text-button" type="button" onPointerDown={() => { longPressTriggered.current = false; longPressTimer.current = window.setTimeout(() => { longPressTriggered.current = true; onReactionMenu(item.id) }, 450) }} onPointerUp={() => { if (longPressTimer.current) window.clearTimeout(longPressTimer.current) }} onPointerLeave={() => { if (longPressTimer.current) window.clearTimeout(longPressTimer.current) }} onClick={() => { if (longPressTriggered.current) { longPressTriggered.current = false; return }; onReactionMenu(reactionMenu === item.id ? null : item.id) }}>{reactionCount ? reactionSummary : '＋ реакция'}</button> : <span>{reactionSummary}</span>}{canManage && reactionMenu === item.id && <div className="reaction-menu">{REACTIONS.map((emoji) => <button type="button" key={emoji} onClick={() => onReact(item.id, emoji)}>{emoji}</button>)}</div>}</div>
  const comments = commentsOpen === item.id && <div className="comments-panel">{item.comments.map((entry) => <p key={entry.id}><b>{entry.author}:</b> <LinkifyText text={entry.text} /></p>)}{canManage && <form onSubmit={(event) => { event.preventDefault(); onAddComment(item.id, comment); setComment('') }}><input value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Написать комментарий" /><button className="button" type="submit">Добавить</button></form>}</div>
  if (mobile) return <article className="material-card" style={style}><header><span className="category-chip">{item.category || 'Без категории'}</span>{canManage ? <button className={item.pinned ? 'icon-button pinned' : 'icon-button'} type="button" aria-label={item.pinned ? 'Снять приоритет' : 'Поднять наверх'} onClick={() => onPin(item.id)}>◆</button> : item.pinned && <span aria-label="Важный материал">◆</span>}</header><section><b><LinkifyText text={item.source} /></b><AttachmentList files={item.sourceFiles} /></section>{item.categoryFiles.length > 0 && <section><small>Для чего</small><AttachmentList files={item.categoryFiles} /></section>}<section><p><LinkifyText text={item.description} /></p><AttachmentList files={item.descriptionFiles} /></section><footer>{reactions}<button className="text-button" type="button" onClick={() => onComments(commentsOpen === item.id ? null : item.id)}>Комментарии {item.comments.length}</button>{canManage && <span className="row-actions"><button className="icon-button" type="button" aria-label="Редактировать" onClick={() => onEdit(item)}>✎</button>{canDelete && <button className="icon-button danger" type="button" aria-label="Переместить в корзину" onClick={() => onTrash(item.id)}>×</button>}</span>}</footer>{comments}</article>
  return <article className="material-row" style={style}><span>{canManage ? <button className={item.pinned ? 'icon-button pinned' : 'icon-button'} type="button" aria-label={item.pinned ? 'Снять приоритет' : 'Поднять наверх'} onClick={() => onPin(item.id)}>◆</button> : item.pinned && <span aria-label="Важный материал">◆</span>}</span><span><b><LinkifyText text={item.source} /></b><AttachmentList files={item.sourceFiles} /></span><span><span className="category-chip">{item.category || 'Без категории'}</span><AttachmentList files={item.categoryFiles} /></span><span><LinkifyText text={item.description} /><AttachmentList files={item.descriptionFiles} /></span><span>{reactions}<button className="text-button" type="button" onClick={() => onComments(commentsOpen === item.id ? null : item.id)}>Комментарии {item.comments.length}</button></span><span className="row-actions">{canManage && <><button className="icon-button" type="button" aria-label="Редактировать" onClick={() => onEdit(item)}>✎</button>{canDelete && <button className="icon-button danger" type="button" aria-label="Переместить в корзину" onClick={() => onTrash(item.id)}>×</button>}</>}</span>{comments && <div className="row-comments">{comments}</div>}</article>
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

function SettingsScreen({ participants, sections, signatures, signaturesLoading, canInvite, canManageMembers, onBack, onShare, onInvite, onUpdate, onRemove, onParticipantPassword, onPassword, onUpdateSection, onReorderSections, onDeleteSection }: { participants: Participant[]; sections: WorkspaceSection[]; signatures: ParticipationPolicySignature[]; signaturesLoading: boolean; canInvite: boolean; canManageMembers: boolean; onBack: () => void; onShare: (email?: string) => void; onInvite: (event: FormEvent<HTMLFormElement>) => void; onUpdate: (id: string, changes: Partial<Participant>) => void; onRemove: (id: string) => void; onParticipantPassword: (id: string, event: FormEvent<HTMLFormElement>) => void; onPassword: (event: FormEvent<HTMLFormElement>) => void; onUpdateSection: (id: string, event: FormEvent<HTMLFormElement>) => Promise<boolean>; onReorderSections: (sections: WorkspaceSection[]) => Promise<boolean>; onDeleteSection: (section: WorkspaceSection) => void }) {
  const [activeTab, setActiveTab] = useState<'participants' | 'sections' | 'signatures'>('participants')
  return <main><section className="work-header compact"><button className="icon-button inverse" type="button" aria-label="Назад" onClick={onBack}>←</button><div><h1>Участники и настройки</h1><p>Роли, доступы и личные пароли</p></div>{canInvite && <button className="button inverse-button" type="button" onClick={() => onShare()}>Поделиться приложением</button>}</section><section className="settings-grid"><div className="settings-main"><div className="settings-heading settings-tabs-heading"><div><p className="eyebrow">Настройки интерфейса</p><div className="settings-tabs" role="tablist" aria-label="Настройки интерфейса"><button type="button" role="tab" aria-selected={activeTab === 'participants'} className={activeTab === 'participants' ? 'active' : ''} onClick={() => setActiveTab('participants')}>Участники</button>{canManageMembers && <button type="button" role="tab" aria-selected={activeTab === 'sections'} className={activeTab === 'sections' ? 'active' : ''} onClick={() => setActiveTab('sections')}>Управление разделами</button>}<button type="button" role="tab" aria-selected={activeTab === 'signatures'} className={activeTab === 'signatures' ? 'active' : ''} onClick={() => setActiveTab('signatures')}>Подписали положение</button></div></div>{activeTab === 'participants' && <span>{participants.length}</span>}</div>
    {activeTab === 'participants' && <div className="settings-tab-panel" role="tabpanel">{participants.map((participant) => { const canSetThisPassword = canManageMembers; return <article className="participant-row" key={participant.id}><ParticipantAvatar participant={participant} /><div className="participant-identity"><b>{participant.name}</b><a href={`mailto:${participant.email}`}>{participant.email}</a><small>{participant.status === 'active' ? 'Активен' : 'Ожидает первого входа'}</small></div><label><span>Роль</span><select value={participant.role} disabled={!canManageMembers || participant.id === DEVELOPER_ID} onChange={(event) => onUpdate(participant.id, { role: event.target.value as Role })}>{(Object.keys(ROLE_LABELS) as Role[]).map((role) => <option value={role} key={role}>{ROLE_LABELS[role]}</option>)}</select></label><div className="participant-section-access"><span>Доступные разделы</span><div className="participant-section-list">{sections.map((section) => { const permanentAccess = roleHasPermanentSectionAccess(participant.role, section); const checked = permanentAccess || participant.sections.includes(section.id); return <label key={section.id}><input type="checkbox" checked={checked} disabled={!canManageMembers || permanentAccess} onChange={(event) => { const nextSections = new Set(participant.sections); if (event.target.checked) nextSections.add(section.id); else nextSections.delete(section.id); onUpdate(participant.id, { sections: Array.from(nextSections) }) }} /><span>{section.title}{permanentAccess ? ' · постоянно' : ''}</span></label> })}</div></div><div className="participant-actions"><button className="icon-button" type="button" aria-label={`Скопировать данные входа для ${participant.name}`} onClick={() => onShare(participant.email)}>↗</button>{canManageMembers && participant.id !== DEVELOPER_ID && <button className="icon-button danger" type="button" aria-label={`Удалить ${participant.name}`} onClick={() => onRemove(participant.id)}>×</button>}</div>{canSetThisPassword && <form className="participant-password" onSubmit={(event) => onParticipantPassword(participant.id, event)}><label><span>Новый личный пароль</span><input name="participantPassword" type="password" minLength={6} autoComplete="new-password" placeholder="Не меньше 6 символов" required /></label><button className="button" type="submit">Установить пароль</button></form>}</article> })}
    {canInvite && <form className="invite-form" onSubmit={onInvite}><div><p className="eyebrow">Новый участник</p><h2>Добавить участника</h2></div><label>Имя<input name="name" placeholder="Имя и фамилия" required /></label><label>Почта<input name="email" type="email" placeholder="name@example.com" required /></label><label>Личный пароль<input name="personalPassword" type="password" minLength={6} autoComplete="new-password" placeholder="Не меньше 6 символов" required /></label>{canManageMembers ? <label>Роль<select name="role" defaultValue="participant">{(Object.keys(ROLE_LABELS) as Role[]).filter((role) => role !== 'developer').map((role) => <option value={role} key={role}>{ROLE_LABELS[role]}</option>)}</select></label> : <input name="role" type="hidden" value="participant" />}<button className="button button-solid" type="submit">Добавить участника</button></form>}</div>}
    {activeTab === 'sections' && canManageMembers && <SectionManagement sections={sections} onUpdateSection={onUpdateSection} onReorderSections={onReorderSections} onDeleteSection={onDeleteSection} />}
    {activeTab === 'signatures' && <PolicySignaturesList signatures={signatures} loading={signaturesLoading} />}
  </div><aside className="settings-side"><section className="settings-panel"><p className="eyebrow">Права доступа</p><h2>Роли</h2>{(Object.keys(ROLE_LABELS) as Role[]).map((role) => <div className="role-note" key={role}><b>{ROLE_LABELS[role]}</b><p>{ROLE_DESCRIPTIONS[role]}</p></div>)}</section>{canManageMembers && <section className="settings-panel"><p className="eyebrow">Безопасность</p><h2>Общий пароль</h2><form className="password-form" onSubmit={onPassword}><label>Новый пароль<input name="newPassword" type="password" minLength={4} required /></label><button className="button" type="submit">Изменить пароль</button></form></section>}<section className="settings-panel developer-card"><span className="access-chip">Разраб</span><h2>Андрей Комов</h2><a href="mailto:a.s.komow@gmail.com">a.s.komow@gmail.com</a><p>Техническое сопровождение воркхаба.</p></section></aside></section></main>
}

export default App
