import { FormEvent, useEffect, useMemo, useState } from 'react'
import { supabase } from './supabase'

export type ContentPlanAttachment = { id: string; name: string; size: number; type: string; path?: string; file?: File }
export type ContentPlanKind = 'current' | 'development'
export type ContentPlanItem = {
  id: string
  kind: ContentPlanKind
  contentDate: string
  description: string
  format: string
  responsible: string
  link: string
  attachments: ContentPlanAttachment[]
  authorId: string | null
  createdAt: number
}
export type ContentPlanInput = Omit<ContentPlanItem, 'id' | 'authorId' | 'createdAt'>

type PlanView = 'week' | 'month'
type Draft = { id: string; date: string }

const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь']
const MONTHS_GENITIVE = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря']
const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']

function pad(value: number) { return String(value).padStart(2, '0') }
function dateKey(date: Date) { return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` }
function parseDate(value: string) { const [year, month, day] = value.split('-').map(Number); return new Date(year, month - 1, day) }
function addDays(date: Date, amount: number) { const next = new Date(date); next.setDate(next.getDate() + amount); return next }
function addMonths(date: Date, amount: number) { return new Date(date.getFullYear(), date.getMonth() + amount, 1) }
function startOfWeek(date: Date) { const day = date.getDay() || 7; return addDays(new Date(date.getFullYear(), date.getMonth(), date.getDate()), 1 - day) }
function sameDay(left: Date, right: Date) { return dateKey(left) === dateKey(right) }
function monthStart(date: Date) { return new Date(date.getFullYear(), date.getMonth(), 1) }
function monthEnd(date: Date) { return new Date(date.getFullYear(), date.getMonth() + 1, 0) }
function formatSize(bytes: number) { if (!bytes) return ''; return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} КБ` : `${(bytes / 1024 / 1024).toFixed(1)} МБ` }
function formatDay(value: string) { const date = parseDate(value); return `${date.getDate()} ${MONTHS_GENITIVE[date.getMonth()]}` }
function monthTitle(date: Date) { return `${MONTHS[date.getMonth()]} ${date.getFullYear()}` }
function rangeFor(view: PlanView, cursor: Date) {
  if (view === 'week') { const start = startOfWeek(cursor); return { start: dateKey(start), end: dateKey(addDays(start, 6)) } }
  return { start: dateKey(monthStart(cursor)), end: dateKey(monthEnd(cursor)) }
}
function rangeTitle(view: PlanView, cursor: Date) {
  if (view === 'month') return monthTitle(cursor)
  const start = startOfWeek(cursor); const end = addDays(start, 6)
  return `${start.getDate()} ${MONTHS_GENITIVE[start.getMonth()]} — ${end.getDate()} ${MONTHS_GENITIVE[end.getMonth()]} ${end.getFullYear()}`
}

async function openAttachment(file: ContentPlanAttachment) {
  if (!file.path) return
  const { data, error } = await supabase.storage.from('content-plan').createSignedUrl(file.path, 60)
  if (!error && data?.signedUrl) window.open(data.signedUrl, '_blank', 'noopener,noreferrer')
}

function AttachmentList({ files, onRemove }: { files: ContentPlanAttachment[]; onRemove?: (id: string) => void }) {
  if (!files.length) return null
  return <div className="attachment-list content-plan-attachments">{files.map((file) => <span className="calendar-attachment-wrap" key={file.id}>
    <button className="attachment" type="button" disabled={!file.path} onClick={() => openAttachment(file)}><span aria-hidden="true">▣</span><span>{file.name}</span>{file.size > 0 && <small>{formatSize(file.size)}</small>}</button>
    {onRemove && <button className="attachment-remove" type="button" aria-label={`Убрать файл ${file.name}`} onClick={() => onRemove(file.id)}>×</button>}
  </span>)}</div>
}

function MiniCalendar({ view, cursor, entries, selectedDate, onSelectDate }: { view: PlanView; cursor: Date; entries: ContentPlanItem[]; selectedDate: string; onSelectDate: (date: string) => void }) {
  const today = new Date()
  const days = useMemo(() => {
    if (view === 'week') return Array.from({ length: 7 }, (_, index) => addDays(startOfWeek(cursor), index))
    const first = monthStart(cursor); const start = startOfWeek(first); const cells = Math.ceil(((first.getDay() || 7) - 1 + monthEnd(cursor).getDate()) / 7) * 7
    return Array.from({ length: cells }, (_, index) => addDays(start, index))
  }, [view, cursor])
  return <div className={`content-mini-calendar ${view}`}><div className="content-mini-weekdays">{WEEKDAYS.map((day) => <span key={day}>{day}</span>)}</div><div className="content-mini-days">{days.map((day) => {
    const key = dateKey(day); const count = entries.filter((item) => item.contentDate === key).length; const outside = view === 'month' && day.getMonth() !== cursor.getMonth()
    return <button className={`${outside ? 'outside ' : ''}${sameDay(day, today) ? 'today ' : ''}${selectedDate === key ? 'selected ' : ''}${count ? 'filled' : ''}`.trim()} type="button" key={key} onClick={() => onSelectDate(key)} aria-label={`${formatDay(key)}${count ? `, записей: ${count}` : ''}`}><span>{day.getDate()}</span>{count > 0 && <small>{count}</small>}</button>
  })}</div></div>
}

function PlanRow({ kind, initial, defaultDate, minDate, maxDate, onSave, onDelete, onSaved }: { kind: ContentPlanKind; initial?: ContentPlanItem; defaultDate: string; minDate: string; maxDate: string; onSave: (input: ContentPlanInput, initial: ContentPlanItem | null) => Promise<boolean>; onDelete?: (item: ContentPlanItem) => void; onSaved?: () => void }) {
  const [date, setDate] = useState(initial?.contentDate ?? defaultDate)
  const [attachments, setAttachments] = useState<ContentPlanAttachment[]>(initial?.attachments ?? [])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { if (!initial) setDate(defaultDate) }, [defaultDate, initial])
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const description = String(data.get('description')).trim(); const responsible = String(data.get('responsible')).trim(); const format = String(data.get('format')).trim(); const link = String(data.get('link')).trim()
    if (!description) { setError(kind === 'current' ? 'Напишите, что публикуем.' : 'Опишите смысл или задачу.'); return }
    if (!responsible) { setError('Укажите ответственного.'); return }
    setError(''); setSaving(true)
    const saved = await onSave({ kind, contentDate: date, description, format, responsible, link, attachments }, initial ?? null)
    setSaving(false)
    if (saved) onSaved?.()
  }
  return <form className={`content-plan-row ${kind}`} onSubmit={submit}>
    <label><span>Дата</span><input name="contentDate" type="date" min={minDate} max={maxDate} value={date} onChange={(event) => setDate(event.target.value)} required /></label>
    <label className="content-plan-description"><span>{kind === 'current' ? 'Что публикуем' : 'Смыслы'}</span><textarea name="description" rows={2} defaultValue={initial?.description ?? ''} placeholder={kind === 'current' ? 'Что постим, краткое описание' : 'Что именно разрабатываем и зачем'} /></label>
    {kind === 'development' && <label><span>Формат</span><input name="format" defaultValue={initial?.format ?? ''} placeholder="Сторителлинг, пост, видео…" /></label>}
    <label><span>Ответственный</span><input name="responsible" defaultValue={initial?.responsible ?? ''} placeholder="Кто делает или публикует" /></label>
    <label className="content-plan-resource"><span>Ссылка или файлы</span><input name="link" type="url" defaultValue={initial?.link ?? ''} placeholder="https://…" />{initial?.link && <a className="content-plan-link" href={initial.link} target="_blank" rel="noreferrer">Открыть ссылку ↗</a>}<span className="file-control compact-file-control">Прикрепить<input type="file" multiple onChange={(event) => setAttachments((current) => [...current, ...Array.from(event.target.files ?? []).map((file) => ({ id: crypto.randomUUID(), name: file.name, size: file.size, type: file.type || 'file', file }))])} /></span><AttachmentList files={attachments} onRemove={(id) => { const file = attachments.find((item) => item.id === id); if (file && window.confirm(`Убрать файл «${file.name}» из строки? Изменение применится после сохранения.`)) setAttachments((current) => current.filter((item) => item.id !== id)) }} /></label>
    <div className="content-plan-row-actions"><button className="button button-solid" type="submit" disabled={saving}>{saving ? 'Сохраняю…' : initial ? 'Сохранить' : 'Добавить'}</button>{initial && onDelete && <button className="icon-button danger" type="button" aria-label="Удалить запись" onClick={() => onDelete(initial)}>×</button>}</div>
    {error && <p className="content-plan-row-error" role="alert">{error}</p>}
  </form>
}

function DraftRows({ kind, defaultDate, minDate, maxDate, onSave }: { kind: ContentPlanKind; defaultDate: string; minDate: string; maxDate: string; onSave: (input: ContentPlanInput, initial: ContentPlanItem | null) => Promise<boolean> }) {
  const [drafts, setDrafts] = useState<Draft[]>(() => [{ id: crypto.randomUUID(), date: defaultDate }])
  useEffect(() => { setDrafts((current) => current.map((draft, index) => index === 0 ? { ...draft, date: defaultDate } : draft)) }, [defaultDate])
  function replaceSaved(id: string) { setDrafts((current) => current.length === 1 ? [{ id: crypto.randomUUID(), date: defaultDate }] : current.filter((draft) => draft.id !== id)) }
  return <div className="content-plan-drafts">{drafts.map((draft) => <PlanRow kind={kind} defaultDate={draft.date} minDate={minDate} maxDate={maxDate} onSave={onSave} onSaved={() => replaceSaved(draft.id)} key={draft.id} />)}<button className="button content-plan-add-row" type="button" onClick={() => setDrafts((current) => [...current, { id: crypto.randomUUID(), date: defaultDate }])}>＋ Добавить ещё строку</button></div>
}

export function ContentPlanScreen({ title, description, entries, onBack, onSave, onDelete }: { title: string; description: string; entries: ContentPlanItem[]; onBack: () => void; onSave: (input: ContentPlanInput, initial: ContentPlanItem | null) => Promise<boolean>; onDelete: (item: ContentPlanItem) => void }) {
  const [tab, setTab] = useState<ContentPlanKind>('current')
  const [view, setView] = useState<PlanView>('month')
  const [cursor, setCursor] = useState(() => new Date())
  const [selectedDate, setSelectedDate] = useState(() => dateKey(new Date()))
  const [developmentCursor, setDevelopmentCursor] = useState(() => new Date())
  const currentRange = rangeFor(view, cursor)
  const currentEntries = entries.filter((item) => item.kind === 'current' && item.contentDate >= currentRange.start && item.contentDate <= currentRange.end).sort((left, right) => left.contentDate.localeCompare(right.contentDate) || left.createdAt - right.createdAt)
  const developmentStart = dateKey(monthStart(developmentCursor)); const developmentEnd = dateKey(monthEnd(developmentCursor))
  const developmentEntries = entries.filter((item) => item.kind === 'development' && item.contentDate >= developmentStart && item.contentDate <= developmentEnd).sort((left, right) => left.contentDate.localeCompare(right.contentDate) || left.createdAt - right.createdAt)
  function selectDate(value: string) { const date = parseDate(value); setSelectedDate(value); setCursor(date) }
  function moveCurrent(amount: number) { const next = view === 'week' ? addDays(cursor, amount * 7) : addMonths(cursor, amount); setCursor(next); setSelectedDate(dateKey(next)) }
  return <main><section className="work-header compact"><button className="icon-button inverse" type="button" aria-label="Назад" onClick={onBack}>←</button><div><h1>{title}</h1><p>{description}</p></div></section>
    <section className="content-plan-shell"><div className="settings-tabs content-plan-tabs" role="tablist" aria-label="Разделы контент-плана"><button type="button" role="tab" aria-selected={tab === 'current'} className={tab === 'current' ? 'active' : ''} onClick={() => setTab('current')}>Текущий контент-план</button><button type="button" role="tab" aria-selected={tab === 'development'} className={tab === 'development' ? 'active' : ''} onClick={() => setTab('development')}>Разработка контента</button></div>
      {tab === 'current' ? <><div className="content-plan-toolbar"><div className="calendar-view-switch"><button className={view === 'week' ? 'active' : ''} type="button" onClick={() => setView('week')}>Неделя</button><button className={view === 'month' ? 'active' : ''} type="button" onClick={() => setView('month')}>Месяц</button></div><div className="calendar-period"><button className="icon-button" type="button" aria-label="Предыдущий период" onClick={() => moveCurrent(-1)}>←</button><button className="button calendar-today" type="button" onClick={() => { const today = new Date(); setCursor(today); setSelectedDate(dateKey(today)) }}>Сегодня</button><button className="icon-button" type="button" aria-label="Следующий период" onClick={() => moveCurrent(1)}>→</button></div><h2>{rangeTitle(view, cursor)}</h2></div>
        <MiniCalendar view={view} cursor={cursor} entries={entries.filter((item) => item.kind === 'current')} selectedDate={selectedDate} onSelectDate={selectDate} />
        <section className="content-plan-table-section"><div className="content-plan-section-heading"><p className="eyebrow">Текущий контент-план</p><h2>{selectedDate ? `Выбрано: ${formatDay(selectedDate)}` : rangeTitle(view, cursor)}</h2></div><DraftRows kind="current" defaultDate={selectedDate} minDate={currentRange.start} maxDate={currentRange.end} onSave={onSave} />{currentEntries.length > 0 && <div className="content-plan-saved"><h3>Заполненные строки</h3>{currentEntries.map((item) => <PlanRow kind="current" initial={item} defaultDate={item.contentDate} minDate={currentRange.start} maxDate={currentRange.end} onSave={onSave} onDelete={onDelete} key={item.id} />)}</div>}</section></> : <><div className="content-development-toolbar"><div><p className="eyebrow">Разработка контента</p><h2>{monthTitle(developmentCursor)}</h2></div><div className="calendar-period"><button className="icon-button" type="button" aria-label="Предыдущий месяц" onClick={() => setDevelopmentCursor((current) => addMonths(current, -1))}>←</button><button className="button calendar-today" type="button" onClick={() => setDevelopmentCursor(new Date())}>Текущий месяц</button><button className="icon-button" type="button" aria-label="Следующий месяц" onClick={() => setDevelopmentCursor((current) => addMonths(current, 1))}>→</button></div></div>
        <section className="content-plan-table-section development"><DraftRows kind="development" defaultDate={developmentStart} minDate={developmentStart} maxDate={developmentEnd} onSave={onSave} />{developmentEntries.length > 0 && <div className="content-plan-saved"><h3>Заполненные строки</h3>{developmentEntries.map((item) => <PlanRow kind="development" initial={item} defaultDate={item.contentDate} minDate={developmentStart} maxDate={developmentEnd} onSave={onSave} onDelete={onDelete} key={item.id} />)}</div>}</section></>}
    </section>
  </main>
}
