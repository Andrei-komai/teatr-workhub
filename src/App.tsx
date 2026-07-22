import { FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

type Screen = 'hub' | 'auth' | 'collection' | 'form' | 'trash' | 'settings'
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
  sections: string[]; status: 'active' | 'invited'
}

const SESSION_KEY = 'tam-workhub-open'
const REACTIONS = ['❤️', '👍', '🔥', '👏', '😁', '👎']
const DAY = 24 * 60 * 60 * 1000
const COLLECTION_SECTION = 'collection'
const DEVELOPER_ID = '00000000-0000-0000-0000-000000000001'
const PUBLIC_APP_URL = 'https://andrei-komai.github.io/teatr-workhub/'
const ROLE_LABELS: Record<Role, string> = { developer: 'Разраб', leader: 'Руководитель', teacher: 'Педагог', admin: 'Админ', participant: 'Участник' }
const ROLE_DESCRIPTIONS: Record<Role, string> = {
  developer: 'Техническое сопровождение и полный доступ ко всем настройкам.',
  leader: 'Полный доступ, участники, роли, пароль и создание новых разделов.',
  teacher: 'Работа с материалами, приглашения и редактирование разделов.',
  admin: 'Те же права, что у педагога.',
  participant: 'Работа в доступных разделах без удаления материалов.',
}

function normalize(value: string) { return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru-RU') }
function titleCase(value: string) { const normalized = normalize(value); return normalized ? normalized[0].toLocaleUpperCase('ru-RU') + normalized.slice(1) : '' }
function formatSize(bytes: number) { if (!bytes) return ''; return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} КБ` : `${(bytes / 1024 / 1024).toFixed(1)} МБ` }
function fileListToAttachments(files: FileList | null): Attachment[] {
  return Array.from(files ?? []).map((file) => ({ id: crypto.randomUUID(), name: file.name, size: file.size, type: file.type || 'file', file }))
}
function mapParticipant(row: Record<string, unknown>): Participant {
  return { id: String(row.id), userId: row.user_id ? String(row.user_id) : null, name: String(row.name), email: String(row.email), role: row.role as Role, sections: (row.sections as string[]) ?? [], status: row.status as 'active' | 'invited' }
}
function mapMaterial(row: Record<string, unknown>): Material {
  return {
    id: String(row.id), source: String(row.source), sourceFiles: (row.source_files as Attachment[]) ?? [], category: String(row.category),
    categoryFiles: (row.category_files as Attachment[]) ?? [], description: String(row.description), descriptionFiles: (row.description_files as Attachment[]) ?? [],
    authorId: row.author_id ? String(row.author_id) : null, createdAt: new Date(String(row.created_at)).getTime(), pinned: Boolean(row.pinned),
    reactions: (row.reactions as Record<string, number>) ?? {}, comments: (row.comments as MaterialComment[]) ?? [], deletedAt: row.deleted_at ? new Date(String(row.deleted_at)).getTime() : null,
  }
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

function App() {
  const [unlocked, setUnlocked] = useState(() => sessionStorage.getItem(SESSION_KEY) === 'yes')
  const [passwordError, setPasswordError] = useState(false)
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Participant | null>(null)
  const [participants, setParticipants] = useState<Participant[]>([])
  const [materials, setMaterials] = useState<Material[]>([])
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
  const [isInstalled, setIsInstalled] = useState(() => window.matchMedia('(display-mode: standalone)').matches || ('standalone' in navigator && Boolean((navigator as Navigator & { standalone?: boolean }).standalone)))

  const currentRole: Role = profile?.role ?? 'participant'
  const canManageMembers = currentRole === 'developer' || currentRole === 'leader'
  const canInvite = canManageMembers || currentRole === 'teacher' || currentRole === 'admin'
  const canDelete = canInvite
  const canCreateSections = canManageMembers
  const canOpenCollection = Boolean(profile && (canManageMembers || profile.sections.includes(COLLECTION_SECTION)))

  async function loadData(activeSession: Session | null = session) {
    if (!activeSession?.user) { setProfile(null); setParticipants([]); setMaterials([]); return }
    const { data: ownProfile, error: profileError } = await supabase.from('profiles').select('*').eq('user_id', activeSession.user.id).maybeSingle()
    if (profileError) { setAppError(profileError.message); return }
    const mappedProfile = ownProfile ? mapParticipant(ownProfile) : null
    setProfile(mappedProfile)
    if (!mappedProfile) return
    if (['developer', 'leader', 'teacher', 'admin'].includes(mappedProfile.role)) {
      const { data } = await supabase.from('profiles').select('*').order('created_at')
      setParticipants((data ?? []).map(mapParticipant))
    } else setParticipants([mappedProfile])
    if (mappedProfile.role === 'developer' || mappedProfile.role === 'leader' || mappedProfile.sections.includes(COLLECTION_SECTION)) {
      const { data, error } = await supabase.from('materials').select('*').order('created_at')
      if (error) setAppError(error.message); else setMaterials((data ?? []).map(mapMaterial))
    }
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); loadData(data.session) })
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
      window.setTimeout(() => loadData(nextSession), 0)
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
    if (!session) return
    const channel = supabase.channel('workhub-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'materials' }, () => loadData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, () => loadData())
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [session?.user.id, profile?.role])

  const activeMaterials = useMemo(() => materials.filter((item) => !item.deletedAt), [materials])
  const trashMaterials = useMemo(() => materials.filter((item) => item.deletedAt), [materials])
  const categories = useMemo(() => Array.from(new Map(activeMaterials.map((item) => [normalize(item.category), item.category])).values()).sort((a, b) => a.localeCompare(b, 'ru')), [activeMaterials])
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
    const { data, error } = await supabase.rpc('check_hub_password', { attempt })
    if (!error && data === true) { sessionStorage.setItem(SESSION_KEY, 'yes'); setUnlocked(true) } else setPasswordError(true)
  }
  async function sendMagicLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setAuthMessage('')
    const email = String(new FormData(event.currentTarget).get('email')).trim()
    const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: PUBLIC_APP_URL } })
    setAuthMessage(error ? `Не удалось отправить ссылку: ${error.message}` : 'Ссылка для входа отправлена на почту. Откройте письмо на этом устройстве.')
  }
  async function logout() { await supabase.auth.signOut(); setProfile(null); setScreen('hub') }
  function requireAccess(target: Screen) {
    if (!session || !profile) { setReturnScreen(target); setScreen('auth'); return }
    if (target === 'collection' && !canOpenCollection) { setAppError('Для вашей роли пока нет доступа к копилке.'); return }
    if (target === 'settings' && !canInvite) { setAppError('Для вашей роли нет доступа к настройкам участников.'); return }
    setScreen(target)
  }
  async function uploadFiles(files: Attachment[], materialId: string, field: string) {
    const result: Attachment[] = []
    for (const attachment of files) {
      if (!attachment.file) { const { file: _file, ...stored } = attachment; result.push(stored); continue }
      const cleanName = attachment.name.replace(/[^a-zA-Zа-яА-ЯёЁ0-9._-]+/g, '-').slice(-100)
      const path = `${materialId}/${field}/${crypto.randomUUID()}-${cleanName}`
      const { error } = await supabase.storage.from('materials').upload(path, attachment.file)
      if (error) throw error
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
  async function moveToTrash(id: string) { await supabase.rpc('trash_material', { material_id: id }); await loadData() }
  async function restore(id: string) { await supabase.rpc('restore_material', { material_id: id }); await loadData() }
  async function removeForever(id: string) { await supabase.rpc('delete_material_forever', { material_id: id }); await loadData() }
  async function react(id: string, emoji: string) { const item = materials.find((m) => m.id === id); if (!item) return; await supabase.from('materials').update({ reactions: { ...item.reactions, [emoji]: (item.reactions[emoji] ?? 0) + 1 } }).eq('id', id); setReactionMenu(null); await loadData() }
  async function addComment(id: string, text: string) { const item = materials.find((m) => m.id === id); if (!item || !text.trim()) return; await supabase.from('materials').update({ comments: [...item.comments, { id: crypto.randomUUID(), author: profile?.name ?? 'Участник', text: text.trim(), createdAt: Date.now() }] }).eq('id', id); await loadData() }
  async function inviteParticipant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!canInvite) return
    const form = event.currentTarget; const data = new FormData(form); const email = String(data.get('email')).trim(); const requestedRole = String(data.get('role')) as Role; const role: Role = canManageMembers ? requestedRole : 'participant'
    const alreadyAdded = participants.some((participant) => normalize(participant.email) === normalize(email))
    if (!alreadyAdded) {
      const { error } = await supabase.from('profiles').insert({ name: String(data.get('name')).trim(), email, role, sections: [COLLECTION_SECTION], status: 'invited', created_by: profile?.id })
      if (error) { setAppError(error.message); return }
    }
    const { error: inviteError } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: PUBLIC_APP_URL } })
    if (inviteError) { setAppError(inviteError.message); return }
    setAppNotice(alreadyAdded ? 'Новое письмо для входа отправлено повторно.' : 'Участник добавлен, приглашение отправлено на почту.')
    form.reset(); await loadData()
  }
  async function updateParticipant(id: string, changes: Partial<Participant>) {
    if (!canManageMembers || id === DEVELOPER_ID) return
    const payload: Record<string, unknown> = {}; if (changes.role) payload.role = changes.role; if (changes.sections) payload.sections = changes.sections
    const { error } = await supabase.from('profiles').update(payload).eq('id', id); if (error) setAppError(error.message); else await loadData()
  }
  async function removeParticipant(id: string) { if (!canManageMembers || id === DEVELOPER_ID) return; const { error } = await supabase.from('profiles').delete().eq('id', id); if (error) setAppError(error.message); else await loadData() }
  async function copyInvitation(email?: string) { await navigator.clipboard.writeText(`Воркхаб Камерного театра-лаборатории Т.А.М.\n${PUBLIC_APP_URL}${email ? `\nВходите с почтой: ${email}` : ''}`) }
  async function changePassword(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = event.currentTarget; const value = String(new FormData(form).get('newPassword')).trim(); const { error } = await supabase.rpc('set_hub_password', { new_password: value }); if (error) setAppError(error.message); else form.reset() }

  async function installApp() {
    if (installPrompt) {
      await installPrompt.prompt()
      const choice = await installPrompt.userChoice
      if (choice.outcome === 'accepted') setInstallPrompt(null)
      return
    }
    setShowInstallHelp(true)
  }

  const installButton = !isInstalled && <button className="text-button install-button" type="button" onClick={installApp}>⇩ Установить</button>
  const installHelp = showInstallHelp && <InstallHelp onClose={() => setShowInstallHelp(false)} />

  if (!unlocked) return <main className="gate-shell"><section className="gate-panel"><div className="logo-mark">Т·А·М</div><p className="eyebrow">Камерный театр-лаборатория</p><h1>Рабочий воркхаб</h1><form onSubmit={unlock}><label htmlFor="hub-password">Общий пароль</label><input id="hub-password" name="password" type="password" autoComplete="current-password" autoFocus />{passwordError && <p className="form-error">Неверный пароль</p>}<button className="button button-solid" type="submit">Войти</button></form>{installButton}</section>{installHelp}</main>

  return <div className="app-shell">
    <header className="app-header"><button className="brand" type="button" onClick={() => setScreen('hub')}><span className="logo-mark small">Т·А·М</span><span><b>Камерный театр-лаборатория Т.А.М.</b><small>Рабочий воркхаб</small></span></button><div className="account-area">{installButton}<div className="user-chip"><span aria-hidden="true">○</span><span><b>{profile?.name ?? 'Общий вход'}</b><small>{profile ? ROLE_LABELS[profile.role] : 'Без личного входа'}</small></span></div>{session ? <button className="text-button header-logout" type="button" onClick={logout}>Выйти</button> : <button className="text-button header-logout" type="button" onClick={() => { setReturnScreen('hub'); setScreen('auth') }}>Войти по почте</button>}</div></header>
    {installHelp}
    {appError && <div className="app-alert" role="alert"><span>{appError}</span><button type="button" onClick={() => setAppError('')}>×</button></div>}
    {appNotice && <div className="app-alert success" role="status"><span>{appNotice}</span><button type="button" onClick={() => setAppNotice('')}>×</button></div>}
    {screen === 'hub' && <Hub profile={profile} canOpenCollection={canOpenCollection} canInvite={canInvite} canManageMembers={canManageMembers} canCreateSections={canCreateSections} onCollection={() => requireAccess('collection')} onSettings={() => requireAccess('settings')} />}
    {screen === 'auth' && <AuthScreen message={authMessage} onSubmit={sendMagicLink} onBack={() => setScreen('hub')} />}
    {screen === 'collection' && <CollectionScreen materials={filteredMaterials} categories={categories} activeFilters={activeFilters} query={query} trashCount={trashMaterials.length} canDelete={canDelete} reactionMenu={reactionMenu} openComments={openComments} onBack={() => setScreen('hub')} onAdd={() => { setEditingMaterial(null); setScreen('form') }} onQuery={setQuery} onClear={() => { setQuery(''); setActiveFilters([]) }} onTrashScreen={() => setScreen('trash')} onFilter={(category) => setActiveFilters((current) => current.includes(category) ? current.filter((item) => item !== category) : [...current, category])} onPin={togglePinned} onEdit={(item) => { setEditingMaterial(item); setScreen('form') }} onTrash={moveToTrash} onReactionMenu={setReactionMenu} onReact={react} onComments={setOpenComments} onAddComment={addComment} />}
    {screen === 'form' && <MaterialForm categories={categories} initial={editingMaterial} onCancel={() => { setEditingMaterial(null); setScreen('collection') }} onSave={editingMaterial ? updateMaterial : saveMaterial} />}
    {screen === 'trash' && <TrashScreen materials={trashMaterials} onBack={() => setScreen('collection')} onRestore={restore} onRemove={removeForever} />}
    {screen === 'settings' && <SettingsScreen participants={participants} canInvite={canInvite} canManageMembers={canManageMembers} onBack={() => setScreen('hub')} onShare={copyInvitation} onInvite={inviteParticipant} onUpdate={updateParticipant} onRemove={removeParticipant} onPassword={changePassword} />}
  </div>
}

function InstallHelp({ onClose }: { onClose: () => void }) {
  const isApple = /iPad|iPhone|iPod/.test(navigator.userAgent)
  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}><section className="install-modal" role="dialog" aria-modal="true" aria-labelledby="install-title" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" type="button" aria-label="Закрыть" onClick={onClose}>×</button><span className="logo-mark small">Т·А·М</span><p className="eyebrow">Установка на телефон</p><h2 id="install-title">Добавить иконку приложения</h2>{isApple ? <ol><li>Откройте эту страницу именно в <b>Safari</b>.</li><li>Нажмите <b>Поделиться</b> внизу экрана.</li><li>Прокрутите список вниз и выберите <b>На экран «Домой»</b>.</li><li>Если такого пункта нет: в самом низу нажмите <b>Редактировать действия</b> и добавьте действие <b>На экран «Домой»</b>.</li><li>Включите <b>Открыть как веб-приложение</b> и нажмите <b>Добавить</b>.</li></ol> : <ol><li>Откройте меню браузера <b>⋮</b>.</li><li>Нажмите <b>Добавить на главный экран</b>.</li><li>Выберите <b>Установить</b> и подтвердите.</li></ol>}<p className="install-note">После этого появится отдельная иконка «Т.А.М.», а приложение будет открываться без адресной строки.</p><button className="button button-solid" type="button" onClick={onClose}>Понятно</button></section></div>
}

function Hub({ profile, canOpenCollection, canInvite, canManageMembers, canCreateSections, onCollection, onSettings }: { profile: Participant | null; canOpenCollection: boolean; canInvite: boolean; canManageMembers: boolean; canCreateSections: boolean; onCollection: () => void; onSettings: () => void }) {
  return <main><section className="work-header hub-hero"><div><p className="eyebrow inverse">Рабочая зона</p><h1>Разделы театра</h1></div><img className="workhub-cover" src={`${import.meta.env.BASE_URL}workhub-cover.jpg`} alt="Камерный театр-лаборатория Т.А.М." /></section><section className="module-grid" aria-label="Разделы театра">
    <button className="module-card" type="button" disabled={Boolean(profile) && !canOpenCollection} onClick={onCollection}><span className="module-index">01</span><span className="module-icon">▦</span><span className="module-copy"><b>Копилка материалов</b><small>Ссылки, файлы, идеи и комментарии</small></span><span className="access-chip">{canOpenCollection ? 'Есть доступ' : profile ? 'Нет доступа' : 'Вход по почте'}</span><span>→</span></button>
    <button className="module-card" type="button" disabled><span className="module-index">02</span><span className="module-icon">□</span><span className="module-copy"><b>Календарь репертуара</b><small>Показы, репетиции и события</small></span><span className="access-chip">Все</span><span>→</span></button>
    <button className="module-card" type="button" disabled={Boolean(profile) && !canInvite} onClick={onSettings}><span className="module-index">03</span><span className="module-icon">◎</span><span className="module-copy"><b>Участники и настройки</b><small>Роли, доступы, приглашения и общий пароль</small></span><span className="access-chip">{canManageMembers ? 'Управление' : canInvite ? 'Приглашения' : profile ? 'Нет доступа' : 'Вход по почте'}</span><span>→</span></button>
    {canCreateSections && <div className="module-card muted"><span className="module-index">04</span><span className="module-icon">＋</span><span className="module-copy"><b>Новый раздел</b><small>Создавать разделы могут руководитель и разраб</small></span><span className="access-chip">Позже</span></div>}
  </section></main>
}

function AuthScreen({ message, onSubmit, onBack }: { message: string; onSubmit: (event: FormEvent<HTMLFormElement>) => void; onBack: () => void }) {
  return <main><section className="work-header compact"><button className="icon-button inverse" type="button" aria-label="Назад" onClick={onBack}>←</button><div><h1>Личный вход</h1><p>Для закрытых разделов и определения вашей роли</p></div></section><form className="auth-form" onSubmit={onSubmit}><label>Почта участника<input name="email" type="email" placeholder="name@gmail.com" required autoFocus /></label><button className="button button-solid" type="submit">Получить ссылку для входа</button>{message && <p>{message}</p>}</form></main>
}

type CollectionProps = { materials: Material[]; categories: string[]; activeFilters: string[]; query: string; trashCount: number; canDelete: boolean; reactionMenu: string | null; openComments: string | null; onBack: () => void; onAdd: () => void; onQuery: (value: string) => void; onClear: () => void; onTrashScreen: () => void; onFilter: (category: string) => void; onPin: (id: string) => void; onEdit: (item: Material) => void; onTrash: (id: string) => void; onReactionMenu: (id: string | null) => void; onReact: (id: string, emoji: string) => void; onComments: (id: string | null) => void; onAddComment: (id: string, text: string) => void }
function CollectionScreen(props: CollectionProps) {
  return <main><section className="work-header compact"><button className="icon-button inverse" type="button" aria-label="Назад" onClick={props.onBack}>←</button><div><h1>Копилка материалов</h1><p>Общие материалы театра</p></div><button className="button inverse-button" type="button" onClick={props.onAdd}>＋ Добавить</button></section>
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
  if (mobile) return <article className="material-card" style={style}><header><span className="category-chip">{item.category}</span><button className={item.pinned ? 'icon-button pinned' : 'icon-button'} type="button" aria-label={item.pinned ? 'Снять приоритет' : 'Поднять наверх'} onClick={() => onPin(item.id)}>◆</button></header><section><b><LinkifyText text={item.source} /></b><AttachmentList files={item.sourceFiles} /></section><section><p><LinkifyText text={item.description} /></p><AttachmentList files={item.descriptionFiles} /></section><footer>{reactions}<button className="text-button" type="button" onClick={() => onComments(commentsOpen === item.id ? null : item.id)}>Комментарии {item.comments.length}</button><span className="row-actions"><button className="icon-button" type="button" aria-label="Редактировать" onClick={() => onEdit(item)}>✎</button>{canDelete && <button className="icon-button danger" type="button" aria-label="Переместить в корзину" onClick={() => onTrash(item.id)}>×</button>}</span></footer>{comments}</article>
  return <article className="material-row" style={style}><span><button className={item.pinned ? 'icon-button pinned' : 'icon-button'} type="button" aria-label={item.pinned ? 'Снять приоритет' : 'Поднять наверх'} onClick={() => onPin(item.id)}>◆</button></span><span><b><LinkifyText text={item.source} /></b><AttachmentList files={item.sourceFiles} /></span><span><span className="category-chip">{item.category}</span><AttachmentList files={item.categoryFiles} /></span><span><LinkifyText text={item.description} /><AttachmentList files={item.descriptionFiles} /></span><span>{reactions}<button className="text-button" type="button" onClick={() => onComments(commentsOpen === item.id ? null : item.id)}>Комментарии {item.comments.length}</button></span><span className="row-actions"><button className="icon-button" type="button" aria-label="Редактировать" onClick={() => onEdit(item)}>✎</button>{canDelete && <button className="icon-button danger" type="button" aria-label="Переместить в корзину" onClick={() => onTrash(item.id)}>×</button>}</span>{comments && <div className="row-comments">{comments}</div>}</article>
}

type MaterialInput = Pick<Material, 'source' | 'sourceFiles' | 'category' | 'categoryFiles' | 'description' | 'descriptionFiles'>
function MaterialForm({ categories, initial, onCancel, onSave }: { categories: string[]; initial: Material | null; onCancel: () => void; onSave: (material: MaterialInput) => Promise<void> }) {
  const [sourceFiles, setSourceFiles] = useState<Attachment[]>(initial?.sourceFiles ?? []); const [categoryFiles, setCategoryFiles] = useState<Attachment[]>(initial?.categoryFiles ?? []); const [descriptionFiles, setDescriptionFiles] = useState<Attachment[]>(initial?.descriptionFiles ?? []); const [notify, setNotify] = useState(false); const [saving, setSaving] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setSaving(true); const data = new FormData(event.currentTarget); await onSave({ source: String(data.get('source')).trim(), sourceFiles, category: String(data.get('category')).trim(), categoryFiles, description: String(data.get('description')).trim(), descriptionFiles }); if (notify && Notification.permission === 'default') Notification.requestPermission().catch(() => undefined); setSaving(false) }
  return <main><section className="work-header compact"><button className="icon-button inverse" type="button" aria-label="Назад" onClick={onCancel}>←</button><div><h1>{initial ? 'Редактирование материала' : 'Новый материал'}</h1><p>Заполните три поля</p></div></section><form className="material-form" onSubmit={submit}><div className="form-grid">
    <section className="form-field"><h2>1. Источник</h2><textarea name="source" rows={5} defaultValue={initial?.source} placeholder="Ссылка, название или текст" required /><label className="file-control">Прикрепить файлы<input type="file" multiple onChange={(event) => setSourceFiles((current) => [...current, ...fileListToAttachments(event.target.files)])} /></label><AttachmentList files={sourceFiles} /></section>
    <section className="form-field"><h2>2. Для чего</h2><input name="category" list="category-list" defaultValue={initial?.category} placeholder="Например: спектакль" required /><datalist id="category-list">{categories.map((category) => <option value={category} key={category} />)}</datalist><small>Одна категория. Регистр букв не учитывается.</small><label className="file-control">Прикрепить файлы<input type="file" multiple onChange={(event) => setCategoryFiles((current) => [...current, ...fileListToAttachments(event.target.files)])} /></label><AttachmentList files={categoryFiles} /></section>
    <section className="form-field"><h2>3. Что внутри</h2><textarea name="description" rows={5} defaultValue={initial?.description} placeholder="Описание или комментарий" required /><label className="file-control">Прикрепить файлы<input type="file" multiple onChange={(event) => setDescriptionFiles((current) => [...current, ...fileListToAttachments(event.target.files)])} /></label><AttachmentList files={descriptionFiles} /></section>
  </div><div className="form-footer"><label className="switch"><input type="checkbox" checked={notify} onChange={(event) => setNotify(event.target.checked)} /><span>Уведомить остальных педагогов</span></label><div><button className="button" type="button" onClick={onCancel}>Отмена</button><button className="button button-solid" type="submit" disabled={saving}>{saving ? 'Сохраняю…' : initial ? 'Сохранить изменения' : 'Сохранить'}</button></div></div></form></main>
}

function TrashScreen({ materials, onBack, onRestore, onRemove }: { materials: Material[]; onBack: () => void; onRestore: (id: string) => void; onRemove: (id: string) => void }) {
  return <main><section className="work-header compact"><button className="icon-button inverse" type="button" aria-label="Назад" onClick={onBack}>←</button><div><h1>Корзина</h1><p>Материалы удаляются навсегда через 30 дней</p></div></section><section className="trash-list">{materials.map((item) => { const daysLeft = Math.max(1, 30 - Math.floor((Date.now() - (item.deletedAt ?? Date.now())) / DAY)); return <article className="trash-row" key={item.id}><div><b>{item.source}</b><small>{item.category} · осталось {daysLeft} дн.</small></div><div><button className="button" onClick={() => onRestore(item.id)}>Восстановить</button><button className="button danger" onClick={() => onRemove(item.id)}>Удалить навсегда</button></div></article> })}{!materials.length && <div className="empty-state">Корзина пуста</div>}</section></main>
}

function SettingsScreen({ participants, canInvite, canManageMembers, onBack, onShare, onInvite, onUpdate, onRemove, onPassword }: { participants: Participant[]; canInvite: boolean; canManageMembers: boolean; onBack: () => void; onShare: (email?: string) => void; onInvite: (event: FormEvent<HTMLFormElement>) => void; onUpdate: (id: string, changes: Partial<Participant>) => void; onRemove: (id: string) => void; onPassword: (event: FormEvent<HTMLFormElement>) => void }) {
  return <main><section className="work-header compact"><button className="icon-button inverse" type="button" aria-label="Назад" onClick={onBack}>←</button><div><h1>Участники и настройки</h1><p>Роли, доступы и приглашения</p></div>{canInvite && <button className="button inverse-button" type="button" onClick={() => onShare()}>Поделиться приложением</button>}</section><section className="settings-grid"><div className="settings-main"><div className="settings-heading"><div><p className="eyebrow">Состав театра</p><h2>Участники</h2></div><span>{participants.length}</span></div>
    {participants.map((participant) => <article className="participant-row" key={participant.id}><div className="participant-avatar">{participant.name.slice(0, 1).toLocaleUpperCase('ru-RU')}</div><div className="participant-identity"><b>{participant.name}</b><a href={`mailto:${participant.email}`}>{participant.email}</a><small>{participant.status === 'active' ? 'Активен' : 'Приглашён'}</small></div><label><span>Роль</span><select value={participant.role} disabled={!canManageMembers || participant.id === DEVELOPER_ID} onChange={(event) => onUpdate(participant.id, { role: event.target.value as Role })}>{(Object.keys(ROLE_LABELS) as Role[]).map((role) => <option value={role} key={role}>{ROLE_LABELS[role]}</option>)}</select></label><label className="section-access"><input type="checkbox" checked={participant.sections.includes(COLLECTION_SECTION)} disabled={!canManageMembers || participant.id === DEVELOPER_ID} onChange={(event) => onUpdate(participant.id, { sections: event.target.checked ? [COLLECTION_SECTION] : [] })} /><span>Копилка материалов</span></label><div className="participant-actions"><button className="icon-button" type="button" aria-label={`Скопировать приглашение для ${participant.name}`} onClick={() => onShare(participant.email)}>↗</button>{canManageMembers && participant.id !== DEVELOPER_ID && <button className="icon-button danger" type="button" aria-label={`Удалить ${participant.name}`} onClick={() => onRemove(participant.id)}>×</button>}</div></article>)}
    {canInvite && <form className="invite-form" onSubmit={onInvite}><div><p className="eyebrow">Новый участник</p><h2>Отправить приглашение</h2></div><label>Имя<input name="name" placeholder="Имя и фамилия" required /></label><label>Почта<input name="email" type="email" placeholder="name@gmail.com" required /></label>{canManageMembers ? <label>Роль<select name="role" defaultValue="participant">{(Object.keys(ROLE_LABELS) as Role[]).filter((role) => role !== 'developer').map((role) => <option value={role} key={role}>{ROLE_LABELS[role]}</option>)}</select></label> : <input name="role" type="hidden" value="participant" />}<button className="button button-solid" type="submit">Добавить участника</button></form>}
  </div><aside className="settings-side"><section className="settings-panel"><p className="eyebrow">Права доступа</p><h2>Роли</h2>{(Object.keys(ROLE_LABELS) as Role[]).map((role) => <div className="role-note" key={role}><b>{ROLE_LABELS[role]}</b><p>{ROLE_DESCRIPTIONS[role]}</p></div>)}</section>{canManageMembers && <section className="settings-panel"><p className="eyebrow">Безопасность</p><h2>Общий пароль</h2><form className="password-form" onSubmit={onPassword}><label>Новый пароль<input name="newPassword" type="password" minLength={4} required /></label><button className="button" type="submit">Изменить пароль</button></form></section>}<section className="settings-panel developer-card"><span className="access-chip">Разраб</span><h2>Андрей Комов</h2><a href="mailto:a.s.komow@gmail.com">a.s.komow@gmail.com</a><p>Техническое сопровождение воркхаба.</p></section></aside></section></main>
}

export default App
