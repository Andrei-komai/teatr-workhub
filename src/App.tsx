import { FormEvent, useEffect, useMemo, useRef, useState } from 'react'

type Screen = 'hub' | 'collection' | 'form' | 'trash'

type Attachment = {
  id: string
  name: string
  size: number
  type: string
}

type MaterialComment = {
  id: string
  author: string
  text: string
  createdAt: number
}

type Material = {
  id: string
  source: string
  sourceFiles: Attachment[]
  category: string
  categoryFiles: Attachment[]
  description: string
  descriptionFiles: Attachment[]
  author: string
  createdAt: number
  pinned: boolean
  reactions: Record<string, number>
  comments: MaterialComment[]
  deletedAt: number | null
}

const STORAGE_KEY = 'tam-workhub-materials-v1'
const SESSION_KEY = 'tam-workhub-open'
const REACTIONS = ['❤️', '👍', '🔥', '👏', '😁', '👎']
const DAY = 24 * 60 * 60 * 1000

const seedMaterials: Material[] = [
  {
    id: 'seed-1',
    source: 'Пластический разогрев',
    sourceFiles: [{ id: 'a1', name: 'Ссылка на видео', size: 0, type: 'link' }],
    category: 'Для трени',
    categoryFiles: [],
    description: 'Упражнение на внимание и общий ритм группы',
    descriptionFiles: [],
    author: 'Андрей',
    createdAt: 1,
    pinned: true,
    reactions: { '❤️': 2, '👍': 1 },
    comments: [{ id: 'c1', author: 'Мария', text: 'Попробуем на ближайшей тренировке', createdAt: Date.now() }],
    deletedAt: null,
  },
  {
    id: 'seed-2',
    source: 'Статья о камерной сцене',
    sourceFiles: [{ id: 'a2', name: 'stage-notes.pdf', size: 348000, type: 'application/pdf' }],
    category: 'Спектакль',
    categoryFiles: [],
    description: 'Идеи по работе с близкой посадкой зрителей',
    descriptionFiles: [],
    author: 'Ольга',
    createdAt: 2,
    pinned: false,
    reactions: { '❤️': 4 },
    comments: [],
    deletedAt: null,
  },
  {
    id: 'seed-3',
    source: 'Свет и движение',
    sourceFiles: [{ id: 'a3', name: 'Reels', size: 0, type: 'link' }],
    category: 'Перформанс',
    categoryFiles: [],
    description: 'Референс для короткого пластического этюда',
    descriptionFiles: [],
    author: 'Андрей',
    createdAt: 3,
    pinned: false,
    reactions: { '🔥': 1 },
    comments: [],
    deletedAt: null,
  },
]

function normalize(value: string) {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru-RU')
}

function titleCase(value: string) {
  const normalized = normalize(value)
  return normalized ? normalized[0].toLocaleUpperCase('ru-RU') + normalized.slice(1) : ''
}

function fileListToAttachments(files: FileList | null): Attachment[] {
  return Array.from(files ?? []).map((file) => ({
    id: crypto.randomUUID(),
    name: file.name,
    size: file.size,
    type: file.type || 'file',
  }))
}

function formatSize(bytes: number) {
  if (!bytes) return ''
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} КБ`
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`
}

function readMaterials(): Material[] {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (!saved) return seedMaterials
    const parsed = JSON.parse(saved) as Material[]
    const cutoff = Date.now() - 30 * DAY
    return parsed.filter((item) => !item.deletedAt || item.deletedAt > cutoff)
  } catch {
    return seedMaterials
  }
}

function AttachmentList({ files }: { files: Attachment[] }) {
  if (!files.length) return null
  return (
    <div className="attachment-list">
      {files.map((file) => (
        <span className="attachment" key={file.id}>
          <span aria-hidden="true">▣</span>
          <span>{file.name}</span>
          {file.size > 0 && <small>{formatSize(file.size)}</small>}
        </span>
      ))}
    </div>
  )
}

function App() {
  const [unlocked, setUnlocked] = useState(() => sessionStorage.getItem(SESSION_KEY) === 'yes')
  const [passwordError, setPasswordError] = useState(false)
  const [screen, setScreen] = useState<Screen>('hub')
  const [materials, setMaterials] = useState<Material[]>(readMaterials)
  const [query, setQuery] = useState('')
  const [activeFilters, setActiveFilters] = useState<string[]>([])
  const [reactionMenu, setReactionMenu] = useState<string | null>(null)
  const [openComments, setOpenComments] = useState<string | null>(null)
  const [editingMaterial, setEditingMaterial] = useState<Material | null>(null)

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(materials))
  }, [materials])

  const activeMaterials = useMemo(() => materials.filter((item) => !item.deletedAt), [materials])
  const trashMaterials = useMemo(() => materials.filter((item) => item.deletedAt), [materials])

  const categories = useMemo(
    () => Array.from(new Map(activeMaterials.map((item) => [normalize(item.category), item.category])).values()).sort((a, b) => a.localeCompare(b, 'ru')),
    [activeMaterials],
  )

  const filteredMaterials = useMemo(() => {
    const needle = normalize(query)
    return activeMaterials
      .filter((item) => !activeFilters.length || activeFilters.some((filter) => normalize(filter) === normalize(item.category)))
      .filter((item) => {
        if (!needle) return true
        const haystack = [
          item.source,
          item.category,
          item.description,
          ...item.sourceFiles.map((file) => file.name),
          ...item.categoryFiles.map((file) => file.name),
          ...item.descriptionFiles.map((file) => file.name),
          ...item.comments.map((comment) => comment.text),
        ].join(' ')
        return normalize(haystack).includes(needle)
      })
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.createdAt - b.createdAt)
  }, [activeMaterials, activeFilters, query])

  function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const expected = import.meta.env.VITE_HUB_PASSWORD || 'tam'
    if (String(data.get('password')) === expected) {
      sessionStorage.setItem(SESSION_KEY, 'yes')
      setUnlocked(true)
      setPasswordError(false)
    } else {
      setPasswordError(true)
    }
  }

  function toggleFilter(category: string) {
    setActiveFilters((current) => current.includes(category) ? current.filter((item) => item !== category) : [...current, category])
  }

  function togglePinned(id: string) {
    setMaterials((current) => current.map((item) => item.id === id ? { ...item, pinned: !item.pinned } : item))
  }

  function moveToTrash(id: string) {
    setMaterials((current) => current.map((item) => item.id === id ? { ...item, deletedAt: Date.now(), pinned: false } : item))
    setReactionMenu(null)
    setOpenComments(null)
  }

  function startEdit(item: Material) {
    setEditingMaterial(item)
    setScreen('form')
  }

  function restore(id: string) {
    setMaterials((current) => current.map((item) => item.id === id ? { ...item, deletedAt: null } : item))
  }

  function removeForever(id: string) {
    setMaterials((current) => current.filter((item) => item.id !== id))
  }

  function react(id: string, emoji: string) {
    setMaterials((current) => current.map((item) => item.id === id ? {
      ...item,
      reactions: { ...item.reactions, [emoji]: (item.reactions[emoji] ?? 0) + 1 },
    } : item))
    setReactionMenu(null)
  }

  function addComment(id: string, text: string) {
    if (!text.trim()) return
    setMaterials((current) => current.map((item) => item.id === id ? {
      ...item,
      comments: [...item.comments, { id: crypto.randomUUID(), author: 'Андрей', text: text.trim(), createdAt: Date.now() }],
    } : item))
  }

  function saveMaterial(material: Omit<Material, 'id' | 'author' | 'createdAt' | 'pinned' | 'reactions' | 'comments' | 'deletedAt'>) {
    const existing = categories.find((category) => normalize(category) === normalize(material.category))
    const category = existing ?? titleCase(material.category)
    setMaterials((current) => [...current, {
      ...material,
      category,
      id: crypto.randomUUID(),
      author: 'Андрей',
      createdAt: Date.now(),
      pinned: false,
      reactions: {},
      comments: [],
      deletedAt: null,
    }])
    setScreen('collection')
  }

  function updateMaterial(material: Omit<Material, 'id' | 'author' | 'createdAt' | 'pinned' | 'reactions' | 'comments' | 'deletedAt'>) {
    if (!editingMaterial) return
    const existing = categories.find((category) => normalize(category) === normalize(material.category))
    const category = existing ?? titleCase(material.category)
    setMaterials((current) => current.map((item) => item.id === editingMaterial.id ? { ...item, ...material, category } : item))
    setEditingMaterial(null)
    setScreen('collection')
  }

  if (!unlocked) {
    return (
      <main className="gate-shell">
        <section className="gate-panel">
          <div className="logo-mark">Т·А·М</div>
          <p className="eyebrow">Камерный театр-лаборатория</p>
          <h1>Рабочий воркхаб</h1>
          <form onSubmit={unlock}>
            <label htmlFor="hub-password">Общий пароль</label>
            <input id="hub-password" name="password" type="password" autoComplete="current-password" autoFocus />
            {passwordError && <p className="form-error">Неверный пароль</p>}
            <button className="button button-solid" type="submit">Войти</button>
          </form>
        </section>
      </main>
    )
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <button className="brand" type="button" onClick={() => setScreen('hub')}>
          <span className="logo-mark small">Т·А·М</span>
          <span><b>Камерный театр-лаборатория Т.А.М.</b><small>Рабочий воркхаб</small></span>
        </button>
        <div className="user-chip"><span aria-hidden="true">○</span> Андрей</div>
      </header>

      {screen === 'hub' && (
        <main>
          <section className="work-header">
            <div><p className="eyebrow inverse">Рабочая зона</p><h1>Разделы театра</h1></div>
          </section>
          <section className="module-grid" aria-label="Разделы театра">
            <button className="module-card" type="button" onClick={() => setScreen('collection')}>
              <span className="module-index">01</span><span className="module-icon" aria-hidden="true">▦</span>
              <span className="module-copy"><b>Копилка материалов</b><small>Ссылки, файлы, идеи и комментарии</small></span>
              <span className="access-chip">Педагоги</span><span aria-hidden="true">→</span>
            </button>
            <button className="module-card" type="button" disabled>
              <span className="module-index">02</span><span className="module-icon" aria-hidden="true">□</span>
              <span className="module-copy"><b>Календарь репертуара</b><small>Показы, репетиции и события</small></span>
              <span className="access-chip">Все</span><span aria-hidden="true">→</span>
            </button>
            <div className="module-card muted">
              <span className="module-index">03</span><span className="module-icon" aria-hidden="true">＋</span>
              <span className="module-copy"><b>Новый раздел</b><small>Здесь появится следующее приложение</small></span>
              <span className="access-chip">Позже</span>
            </div>
          </section>
        </main>
      )}

      {screen === 'collection' && (
        <main>
          <section className="work-header compact">
            <button className="icon-button inverse" type="button" aria-label="Назад" onClick={() => setScreen('hub')}>←</button>
            <div><h1>Копилка материалов</h1><p>Общий доступ педагогов</p></div>
            <button className="button inverse-button" type="button" onClick={() => setScreen('form')}>＋ Добавить</button>
          </section>

          <section className="collection-tools">
            <label className="search-box"><span aria-hidden="true">⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Поиск по всем полям" /></label>
            <button className="button" type="button" onClick={() => { setQuery(''); setActiveFilters([]) }}>Очистить</button>
            <button className="button" type="button" onClick={() => setScreen('trash')}>Корзина{trashMaterials.length ? ` · ${trashMaterials.length}` : ''}</button>
          </section>

          <section className="filters" aria-label="Фильтры">
            <span>Фильтр:</span>
            {categories.map((category) => <button className={activeFilters.includes(category) ? 'filter active' : 'filter'} type="button" key={category} onClick={() => toggleFilter(category)}>{category}</button>)}
          </section>

          <section className="materials" aria-live="polite">
            <div className="desktop-table">
              <div className="material-row table-head"><span>Важно</span><span>Источник</span><span>Для чего</span><span>Что внутри</span><span>Реакции</span><span></span></div>
              {filteredMaterials.map((item) => (
                <MaterialRow key={item.id} item={item} mobile={false} reactionMenu={reactionMenu} commentsOpen={openComments} onPin={togglePinned} onEdit={startEdit} onTrash={moveToTrash} onReactionMenu={setReactionMenu} onReact={react} onComments={setOpenComments} onAddComment={addComment} />
              ))}
            </div>
            <div className="mobile-cards">
              {filteredMaterials.map((item) => (
                <MaterialRow key={item.id} item={item} mobile reactionMenu={reactionMenu} commentsOpen={openComments} onPin={togglePinned} onEdit={startEdit} onTrash={moveToTrash} onReactionMenu={setReactionMenu} onReact={react} onComments={setOpenComments} onAddComment={addComment} />
              ))}
            </div>
            {!filteredMaterials.length && <div className="empty-state">Ничего не найдено</div>}
          </section>
        </main>
      )}

      {screen === 'form' && <MaterialForm categories={categories} initial={editingMaterial} onCancel={() => { setEditingMaterial(null); setScreen('collection') }} onSave={editingMaterial ? updateMaterial : saveMaterial} />}

      {screen === 'trash' && (
        <main>
          <section className="work-header compact">
            <button className="icon-button inverse" type="button" aria-label="Назад" onClick={() => setScreen('collection')}>←</button>
            <div><h1>Корзина</h1><p>Материалы удаляются навсегда через 30 дней</p></div>
          </section>
          <section className="trash-list">
            {trashMaterials.map((item) => {
              const daysLeft = Math.max(1, 30 - Math.floor((Date.now() - (item.deletedAt ?? Date.now())) / DAY))
              return <article className="trash-row" key={item.id}><div><b>{item.source}</b><small>{item.category} · осталось {daysLeft} дн.</small></div><div><button className="button" onClick={() => restore(item.id)}>Восстановить</button><button className="button danger" onClick={() => removeForever(item.id)}>Удалить навсегда</button></div></article>
            })}
            {!trashMaterials.length && <div className="empty-state">Корзина пуста</div>}
          </section>
        </main>
      )}
    </div>
  )
}

type RowProps = {
  item: Material
  mobile: boolean
  reactionMenu: string | null
  commentsOpen: string | null
  onPin: (id: string) => void
  onEdit: (item: Material) => void
  onTrash: (id: string) => void
  onReactionMenu: (id: string | null) => void
  onReact: (id: string, emoji: string) => void
  onComments: (id: string | null) => void
  onAddComment: (id: string, text: string) => void
}

function MaterialRow({ item, mobile, reactionMenu, commentsOpen, onPin, onEdit, onTrash, onReactionMenu, onReact, onComments, onAddComment }: RowProps) {
  const [comment, setComment] = useState('')
  const longPressTimer = useRef<number | null>(null)
  const longPressTriggered = useRef(false)
  const style = { '--row-color': `var(--category-${Math.abs(Array.from(normalize(item.category)).reduce((sum, letter) => sum + letter.codePointAt(0)!, 0)) % 6 + 1})` } as React.CSSProperties
  const reactionCount = Object.values(item.reactions).reduce((sum, count) => sum + count, 0)

  const reactions = (
    <div className="reaction-area">
      <button className="text-button" type="button"
        onPointerDown={() => { longPressTriggered.current = false; longPressTimer.current = window.setTimeout(() => { longPressTriggered.current = true; onReactionMenu(item.id) }, 450) }}
        onPointerUp={() => { if (longPressTimer.current) window.clearTimeout(longPressTimer.current) }}
        onPointerLeave={() => { if (longPressTimer.current) window.clearTimeout(longPressTimer.current) }}
        onClick={() => { if (longPressTriggered.current) { longPressTriggered.current = false; return }; onReactionMenu(reactionMenu === item.id ? null : item.id) }} aria-expanded={reactionMenu === item.id}
        title="Нажмите или удерживайте, чтобы выбрать реакцию">
        {reactionCount ? Object.entries(item.reactions).filter(([, count]) => count).map(([emoji, count]) => `${emoji}${count}`).join(' ') : '＋ реакция'}
      </button>
      {reactionMenu === item.id && <div className="reaction-menu">{REACTIONS.map((emoji) => <button type="button" key={emoji} onClick={() => onReact(item.id, emoji)}>{emoji}</button>)}</div>}
    </div>
  )

  const comments = commentsOpen === item.id && (
    <div className="comments-panel">
      {item.comments.map((entry) => <p key={entry.id}><b>{entry.author}:</b> {entry.text}</p>)}
      <form onSubmit={(event) => { event.preventDefault(); onAddComment(item.id, comment); setComment('') }}>
        <input value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Написать комментарий" />
        <button className="button" type="submit">Добавить</button>
      </form>
    </div>
  )

  if (mobile) {
    return (
      <article className="material-card" style={style} data-material-id={item.id} data-source={item.source}>
        <header><span className="category-chip">{item.category}</span><button className={item.pinned ? 'icon-button pinned' : 'icon-button'} type="button" aria-label={item.pinned ? 'Снять приоритет' : 'Поднять наверх'} onClick={() => onPin(item.id)}>◆</button></header>
        <section><b>{item.source}</b><AttachmentList files={item.sourceFiles} /></section>
        <section><p>{item.description}</p><AttachmentList files={item.descriptionFiles} /></section>
        <footer>{reactions}<button className="text-button" type="button" onClick={() => onComments(commentsOpen === item.id ? null : item.id)}>Комментарии {item.comments.length}</button><span className="row-actions"><button className="icon-button" type="button" aria-label="Редактировать" onClick={() => onEdit(item)}>✎</button><button className="icon-button danger" type="button" aria-label="Переместить в корзину" onClick={() => onTrash(item.id)}>×</button></span></footer>
        {comments}
      </article>
    )
  }

  return (
    <article className="material-row" style={style} data-material-id={item.id} data-source={item.source}>
      <span><button className={item.pinned ? 'icon-button pinned' : 'icon-button'} type="button" aria-label={item.pinned ? 'Снять приоритет' : 'Поднять наверх'} onClick={() => onPin(item.id)}>◆</button></span>
      <span><b>{item.source}</b><AttachmentList files={item.sourceFiles} /></span>
      <span><span className="category-chip">{item.category}</span><AttachmentList files={item.categoryFiles} /></span>
      <span>{item.description}<AttachmentList files={item.descriptionFiles} /></span>
      <span>{reactions}<button className="text-button" type="button" onClick={() => onComments(commentsOpen === item.id ? null : item.id)}>Комментарии {item.comments.length}</button></span>
      <span className="row-actions"><button className="icon-button" type="button" aria-label="Редактировать" onClick={() => onEdit(item)}>✎</button><button className="icon-button danger" type="button" aria-label="Переместить в корзину" onClick={() => onTrash(item.id)}>×</button></span>
      {comments && <div className="row-comments">{comments}</div>}
    </article>
  )
}

function MaterialForm({ categories, initial, onCancel, onSave }: { categories: string[]; initial: Material | null; onCancel: () => void; onSave: (material: Omit<Material, 'id' | 'author' | 'createdAt' | 'pinned' | 'reactions' | 'comments' | 'deletedAt'>) => void }) {
  const [sourceFiles, setSourceFiles] = useState<Attachment[]>(initial?.sourceFiles ?? [])
  const [categoryFiles, setCategoryFiles] = useState<Attachment[]>(initial?.categoryFiles ?? [])
  const [descriptionFiles, setDescriptionFiles] = useState<Attachment[]>(initial?.descriptionFiles ?? [])
  const [notify, setNotify] = useState(false)

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    onSave({
      source: String(data.get('source')).trim(),
      sourceFiles,
      category: String(data.get('category')).trim(),
      categoryFiles,
      description: String(data.get('description')).trim(),
      descriptionFiles,
    })
    if (notify && Notification.permission === 'default') Notification.requestPermission().catch(() => undefined)
  }

  return (
    <main>
      <section className="work-header compact">
        <button className="icon-button inverse" type="button" aria-label="Назад" onClick={onCancel}>←</button>
        <div><h1>{initial ? 'Редактирование материала' : 'Новый материал'}</h1><p>Заполните три поля</p></div>
      </section>
      <form className="material-form" onSubmit={submit}>
        <div className="form-grid">
          <fieldset><legend>1. Источник</legend><textarea name="source" rows={5} defaultValue={initial?.source} placeholder="Ссылка, название или текст" required /><label className="file-control">Прикрепить файлы<input type="file" multiple onChange={(event) => setSourceFiles((current) => [...current, ...fileListToAttachments(event.target.files)])} /></label><AttachmentList files={sourceFiles} /></fieldset>
          <fieldset><legend>2. Для чего</legend><input name="category" list="category-list" defaultValue={initial?.category} placeholder="Например: спектакль" required /><datalist id="category-list">{categories.map((category) => <option value={category} key={category} />)}</datalist><small>Одна категория. Регистр букв не учитывается.</small><label className="file-control">Прикрепить файлы<input type="file" multiple onChange={(event) => setCategoryFiles((current) => [...current, ...fileListToAttachments(event.target.files)])} /></label><AttachmentList files={categoryFiles} /></fieldset>
          <fieldset><legend>3. Что внутри</legend><textarea name="description" rows={5} defaultValue={initial?.description} placeholder="Описание или комментарий" required /><label className="file-control">Прикрепить файлы<input type="file" multiple onChange={(event) => setDescriptionFiles((current) => [...current, ...fileListToAttachments(event.target.files)])} /></label><AttachmentList files={descriptionFiles} /></fieldset>
        </div>
        <div className="form-footer"><label className="switch"><input type="checkbox" checked={notify} onChange={(event) => setNotify(event.target.checked)} /><span>Уведомить остальных педагогов</span></label><div><button className="button" type="button" onClick={onCancel}>Отмена</button><button className="button button-solid" type="submit">{initial ? 'Сохранить изменения' : 'Сохранить'}</button></div></div>
      </form>
    </main>
  )
}

export default App
