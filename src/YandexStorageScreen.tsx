import { useEffect, useMemo, useState } from 'react'

const STORAGE_PUBLIC_URL = 'https://disk.yandex.ru/d/NFlQesl7kdXu3A'
const STORAGE_API_URL = 'https://cloud-api.yandex.net/v1/disk/public/resources'
const PAGE_SIZE = 200

type YandexResource = {
  name: string
  path: string
  type: 'dir' | 'file'
  mime_type?: string
  media_type?: string
  size?: number
  modified?: string
  file?: string
  preview?: string
}

type YandexFolderResponse = YandexResource & {
  _embedded?: {
    items: YandexResource[]
    total: number
  }
}

type Breadcrumb = { name: string; path: string }

function apiUrl(path: string, offset = 0) {
  const params = new URLSearchParams({
    public_key: STORAGE_PUBLIC_URL,
    limit: String(PAGE_SIZE),
    offset: String(offset),
    preview_size: 'XL',
    preview_crop: 'false',
  })
  if (path) params.set('path', path)
  return `${STORAGE_API_URL}?${params.toString()}`
}

async function loadFolder(path: string, signal: AbortSignal) {
  const firstResponse = await fetch(apiUrl(path), { signal, cache: 'no-store' })
  if (!firstResponse.ok) throw new Error(`Яндекс Диск вернул ошибку ${firstResponse.status}.`)
  const firstPage = await firstResponse.json() as YandexFolderResponse
  const firstItems = firstPage._embedded?.items ?? []
  const total = firstPage._embedded?.total ?? firstItems.length

  if (firstItems.length >= total) return firstItems

  const pageRequests: Promise<YandexResource[]>[] = []
  for (let offset = firstItems.length; offset < total; offset += PAGE_SIZE) {
    pageRequests.push(fetch(apiUrl(path, offset), { signal, cache: 'no-store' }).then(async (response) => {
      if (!response.ok) throw new Error(`Яндекс Диск вернул ошибку ${response.status}.`)
      const page = await response.json() as YandexFolderResponse
      return page._embedded?.items ?? []
    }))
  }

  return firstItems.concat(...await Promise.all(pageRequests))
}

function formatSize(size?: number) {
  if (size === undefined) return ''
  if (size < 1024) return `${size} Б`
  const units = ['КБ', 'МБ', 'ГБ', 'ТБ']
  let value = size / 1024
  let unit = units[0]
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024
    unit = units[index]
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${unit}`
}

function formatDate(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date)
}

function previewKind(item: YandexResource) {
  const mime = item.mime_type ?? ''
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime === 'application/pdf' || item.name.toLowerCase().endsWith('.pdf')) return 'pdf'
  return null
}

function ResourceIcon({ item }: { item: YandexResource }) {
  if (item.type === 'dir') {
    return <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M3.5 8.5h9l2.5 3h13.5v14H3.5z" /><path d="M3.5 11.5v-5h8l2 2h8" /></svg>
  }
  return <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M7.5 3.5h11l6 6v19h-17z" /><path d="M18.5 3.5v6h6" /><path d="M11 16h10M11 21h10" /></svg>
}

export function YandexStorageScreen({ title, description, onBack }: { title: string; description: string; onBack: () => void }) {
  const [trail, setTrail] = useState<Breadcrumb[]>([{ name: 'Проекты', path: '' }])
  const [items, setItems] = useState<YandexResource[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [previewItem, setPreviewItem] = useState<YandexResource | null>(null)
  const [previewError, setPreviewError] = useState(false)
  const currentPath = trail[trail.length - 1].path

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    const timeout = window.setTimeout(() => controller.abort(), 15000)
    setLoading(true)
    setError('')
    setItems([])

    loadFolder(currentPath, controller.signal)
      .then((nextItems) => {
        if (!cancelled) setItems(nextItems)
      })
      .catch((reason: unknown) => {
        if (cancelled) return
        if (controller.signal.aborted) setError('Яндекс Диск не ответил вовремя. Попробуйте ещё раз.')
        else setError(reason instanceof Error ? reason.message : 'Не удалось загрузить папку.')
      })
      .finally(() => {
        window.clearTimeout(timeout)
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
      window.clearTimeout(timeout)
      controller.abort()
    }
  }, [currentPath, reloadKey])

  useEffect(() => {
    if (!previewItem) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreviewItem(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [previewItem])

  const sortedItems = useMemo(() => [...items].sort((left, right) => {
    if (left.type !== right.type) return left.type === 'dir' ? -1 : 1
    return left.name.localeCompare(right.name, 'ru', { numeric: true })
  }), [items])

  function openFolder(item: YandexResource) {
    setTrail((current) => [...current, { name: item.name, path: item.path }])
  }

  function goToBreadcrumb(index: number) {
    setTrail((current) => current.slice(0, index + 1))
  }

  function openPreview(item: YandexResource) {
    setPreviewError(false)
    setPreviewItem(item)
  }

  const activePreviewKind = previewItem ? previewKind(previewItem) : null
  const previewUrl = previewItem ? (activePreviewKind === 'image' ? previewItem.preview || previewItem.file : previewItem.file) : ''

  return <main>
    <section className="work-header compact storage-header">
      <button className="icon-button inverse" type="button" aria-label="Назад" onClick={onBack}>←</button>
      <div><h1>{title}</h1><p>{description || 'Файлы театра'}</p></div>
      <a className="button inverse-button storage-external-link" href={STORAGE_PUBLIC_URL} target="_blank" rel="noreferrer">Открыть в Яндекс Диске ↗</a>
    </section>

    <section className="storage-shell" aria-live="polite">
      <nav className="storage-breadcrumbs" aria-label="Путь к папке">
        {trail.map((crumb, index) => <span key={`${crumb.path}-${index}`}>
          {index > 0 && <i aria-hidden="true">/</i>}
          <button type="button" disabled={index === trail.length - 1} onClick={() => goToBreadcrumb(index)}>{crumb.name}</button>
        </span>)}
      </nav>

      {loading && <div className="storage-status"><span className="storage-loader" aria-hidden="true" /><b>Загружаем папку…</b><small>Сам воркхаб продолжает работать</small></div>}

      {!loading && error && <div className="storage-status storage-error"><b>Не удалось открыть папку</b><p>{error}</p><button className="button button-solid" type="button" onClick={() => setReloadKey((value) => value + 1)}>Повторить</button></div>}

      {!loading && !error && sortedItems.length > 0 && <div className="storage-grid">
        {sortedItems.map((item) => {
          const canPreview = Boolean(previewKind(item) && (item.file || item.preview))
          return <article className={`storage-card ${item.type === 'dir' ? 'folder' : 'file'}`} key={item.path}>
            <button className="storage-card-main" type="button" onClick={() => item.type === 'dir' ? openFolder(item) : canPreview && openPreview(item)} disabled={item.type === 'file' && !canPreview}>
              <span className="storage-resource-icon"><ResourceIcon item={item} /></span>
              <span className="storage-resource-copy"><b>{item.name}</b><small>{item.type === 'dir' ? `Папка${item.modified ? ` · ${formatDate(item.modified)}` : ''}` : [formatSize(item.size), formatDate(item.modified)].filter(Boolean).join(' · ')}</small></span>
              {item.type === 'dir' && <span className="storage-arrow" aria-hidden="true">→</span>}
            </button>
            {item.type === 'file' && <div className="storage-card-actions">
              {canPreview && <button type="button" onClick={() => openPreview(item)}>Посмотреть</button>}
              {item.file && <a href={item.file} target="_blank" rel="noreferrer">Скачать</a>}
            </div>}
          </article>
        })}
      </div>}

      {!loading && !error && sortedItems.length === 0 && <div className="storage-status"><b>Папка пустая</b><small>Новые файлы появятся здесь после обновления папки в Яндекс Диске</small></div>}
    </section>

    {previewItem && <div className="storage-preview-backdrop" role="presentation" onMouseDown={() => setPreviewItem(null)}>
      <section className="storage-preview" role="dialog" aria-modal="true" aria-label={`Просмотр ${previewItem.name}`} onMouseDown={(event) => event.stopPropagation()}>
        <header><div><b>{previewItem.name}</b><small>{[formatSize(previewItem.size), formatDate(previewItem.modified)].filter(Boolean).join(' · ')}</small></div><button className="icon-button" type="button" aria-label="Закрыть просмотр" onClick={() => setPreviewItem(null)}>×</button></header>
        <div className="storage-preview-body">
          {activePreviewKind === 'image' && previewUrl && !previewError && <img src={previewUrl} alt={previewItem.name} referrerPolicy="no-referrer" onError={() => setPreviewError(true)} />}
          {activePreviewKind === 'video' && previewUrl && !previewError && <video src={previewUrl} poster={previewItem.preview} controls playsInline preload="metadata" onError={() => setPreviewError(true)} />}
          {activePreviewKind === 'pdf' && previewUrl && !previewError && <iframe src={previewUrl} title={previewItem.name} referrerPolicy="no-referrer" onError={() => setPreviewError(true)} />}
          {previewError && <div className="storage-preview-fallback">{previewItem.preview && <img src={previewItem.preview} alt="" referrerPolicy="no-referrer" />}<b>Этот файл не воспроизводится на устройстве</b><p>{activePreviewKind === 'video' ? 'Для гарантированного просмотра на Android и iPhone используйте видео MP4 с кодеком H.264. Исходный MOV можно скачать или открыть в Яндекс Диске.' : 'Яндекс не отдал предпросмотр. Файл можно скачать или открыть в Яндекс Диске.'}</p></div>}
        </div>
        <footer>{previewItem.file && <a className="button button-solid" href={previewItem.file} target="_blank" rel="noreferrer">Скачать файл</a>}</footer>
      </section>
    </div>}
  </main>
}
