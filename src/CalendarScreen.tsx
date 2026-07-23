import { FormEvent, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { supabase } from './supabase'

export type CalendarAttachment = { id: string; name: string; size: number; type: string; path?: string; file?: File }
export type CalendarEventType = 'rehearsal' | 'show' | 'other'
export type CalendarEvent = {
  id: string
  title: string
  eventType: CalendarEventType
  eventDate: string
  startTime: string
  endTime: string | null
  description: string
  attachments: CalendarAttachment[]
  authorId: string | null
  createdAt: number
}
export type CalendarEventInput = Omit<CalendarEvent, 'id' | 'authorId' | 'createdAt'>
export type CalendarView = 'week' | 'month' | 'year'

const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь']
const MONTHS_GENITIVE = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря']
const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']
const TYPE_LABELS: Record<CalendarEventType, string> = { rehearsal: 'Репетиция', show: 'Показ', other: 'Событие' }

function pad(value: number) { return String(value).padStart(2, '0') }
function dateKey(date: Date) { return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` }
function parseDate(value: string) { const [year, month, day] = value.split('-').map(Number); return new Date(year, month - 1, day) }
function addDays(date: Date, amount: number) { const next = new Date(date); next.setDate(next.getDate() + amount); return next }
function addMonths(date: Date, amount: number) { return new Date(date.getFullYear(), date.getMonth() + amount, 1) }
function addYears(date: Date, amount: number) { return new Date(date.getFullYear() + amount, date.getMonth(), 1) }
function startOfWeek(date: Date) { const day = date.getDay() || 7; return addDays(new Date(date.getFullYear(), date.getMonth(), date.getDate()), 1 - day) }
function sameDay(left: Date, right: Date) { return dateKey(left) === dateKey(right) }
function formatDay(value: string) { const date = parseDate(value); return `${date.getDate()} ${MONTHS_GENITIVE[date.getMonth()]} ${date.getFullYear()}` }
function formatTime(value: string) { return value.slice(0, 5) }
function formatSize(bytes: number) { if (!bytes) return ''; return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} КБ` : `${(bytes / 1024 / 1024).toFixed(1)} МБ` }
function eventSort(left: CalendarEvent, right: CalendarEvent) { return left.eventDate.localeCompare(right.eventDate) || left.startTime.localeCompare(right.startTime) }

async function openCalendarAttachment(file: CalendarAttachment) {
  if (!file.path) return
  const { data, error } = await supabase.storage.from('calendar').createSignedUrl(file.path, 60)
  if (!error && data?.signedUrl) window.open(data.signedUrl, '_blank', 'noopener,noreferrer')
}

function CalendarAttachmentList({ files, removable, onRemove }: { files: CalendarAttachment[]; removable?: boolean; onRemove?: (id: string) => void }) {
  if (!files.length) return null
  return <div className="attachment-list calendar-attachments">{files.map((file) => (
    <span className="calendar-attachment-wrap" key={file.id}>
      <button className="attachment" type="button" onClick={() => openCalendarAttachment(file)} disabled={!file.path}><span aria-hidden="true">▣</span><span>{file.name}</span>{file.size > 0 && <small>{formatSize(file.size)}</small>}</button>
      {removable && <button className="attachment-remove" type="button" aria-label={`Убрать файл ${file.name}`} onClick={() => onRemove?.(file.id)}>×</button>}
    </span>
  ))}</div>
}

function EventCard({ item, canManage, onEdit, onDelete }: { item: CalendarEvent; canManage: boolean; onEdit: (item: CalendarEvent) => void; onDelete: (item: CalendarEvent) => void }) {
  const style = { '--event-accent': item.eventType === 'show' ? '#8f2d25' : item.eventType === 'rehearsal' ? '#335f47' : '#4d5061' } as CSSProperties
  return <article className="calendar-event-card" style={style}>
    <div className="calendar-event-time"><b>{formatTime(item.startTime)}</b>{item.endTime && <span>— {formatTime(item.endTime)}</span>}</div>
    <div className="calendar-event-content"><span className={`event-type ${item.eventType}`}>{TYPE_LABELS[item.eventType]}</span><h3>{item.title}</h3>{item.description && <p>{item.description}</p>}<CalendarAttachmentList files={item.attachments} /></div>
    {canManage && <div className="calendar-event-actions"><button className="icon-button" type="button" aria-label={`Редактировать ${item.title}`} onClick={() => onEdit(item)}>✎</button><button className="icon-button danger" type="button" aria-label={`Удалить ${item.title}`} onClick={() => onDelete(item)}>×</button></div>}
  </article>
}

function EventGroups({ events, canManage, onEdit, onDelete, emptyText }: { events: CalendarEvent[]; canManage: boolean; onEdit: (item: CalendarEvent) => void; onDelete: (item: CalendarEvent) => void; emptyText: string }) {
  const groups = useMemo(() => {
    const result = new Map<string, CalendarEvent[]>()
    events.slice().sort(eventSort).forEach((event) => result.set(event.eventDate, [...(result.get(event.eventDate) ?? []), event]))
    return Array.from(result.entries())
  }, [events])
  if (!groups.length) return <div className="empty-state calendar-empty">{emptyText}</div>
  return <div className="calendar-event-groups">{groups.map(([day, dayEvents]) => <section className="calendar-day-group" key={day}><h2>{formatDay(day)}</h2>{dayEvents.map((item) => <EventCard key={item.id} item={item} canManage={canManage} onEdit={onEdit} onDelete={onDelete} />)}</section>)}</div>
}

function EventEditor({ initial, defaultDate, onClose, onSave }: { initial: CalendarEvent | null; defaultDate: string; onClose: () => void; onSave: (input: CalendarEventInput, initial: CalendarEvent | null) => Promise<boolean> }) {
  const [attachments, setAttachments] = useState<CalendarAttachment[]>(initial?.attachments ?? [])
  const [saving, setSaving] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const startTime = String(data.get('startTime'))
    const endTime = String(data.get('endTime')) || null
    if (endTime && endTime <= startTime) return
    setSaving(true)
    const saved = await onSave({
      title: String(data.get('title')).trim(), eventType: String(data.get('eventType')) as CalendarEventType,
      eventDate: String(data.get('eventDate')), startTime, endTime, description: String(data.get('description')).trim(), attachments,
    }, initial)
    setSaving(false)
    if (saved) onClose()
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}><form className="calendar-event-editor" role="dialog" aria-modal="true" aria-labelledby="event-editor-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={submit}>
    <button className="modal-close" type="button" aria-label="Закрыть" onClick={onClose}>×</button>
    <p className="eyebrow">Календарь репертуара</p><h2 id="event-editor-title">{initial ? 'Редактировать событие' : 'Новое событие'}</h2>
    <div className="calendar-form-grid">
      <label><span>Дата</span><input name="eventDate" type="date" defaultValue={initial?.eventDate ?? defaultDate} required /></label>
      <label><span>Тип</span><select name="eventType" defaultValue={initial?.eventType ?? 'rehearsal'}><option value="rehearsal">Репетиция</option><option value="show">Показ</option><option value="other">Другое событие</option></select></label>
      <label><span>Начало</span><input name="startTime" type="time" defaultValue={initial?.startTime.slice(0, 5) ?? '18:00'} required /></label>
      <label><span>Окончание</span><input name="endTime" type="time" defaultValue={initial?.endTime?.slice(0, 5) ?? ''} /></label>
      <label className="calendar-form-wide"><span>Название</span><input name="title" defaultValue={initial?.title ?? ''} minLength={2} maxLength={120} placeholder="Например: репетиция спектакля" required autoFocus /></label>
      <label className="calendar-form-wide"><span>Описание</span><textarea name="description" defaultValue={initial?.description ?? ''} rows={4} maxLength={1000} placeholder="Место, участники и важные детали" /></label>
      <label className="file-control calendar-form-wide"><span>Фото, видео или документ</span><input type="file" multiple accept="image/*,video/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt" onChange={(event) => setAttachments((current) => [...current, ...Array.from(event.target.files ?? []).map((file) => ({ id: crypto.randomUUID(), name: file.name, size: file.size, type: file.type || 'file', file }))])} /></label>
      <div className="calendar-form-wide"><CalendarAttachmentList files={attachments} removable onRemove={(id) => setAttachments((current) => current.filter((file) => file.id !== id))} /></div>
    </div>
    <div className="calendar-form-actions"><button className="button" type="button" onClick={onClose}>Отмена</button><button className="button button-solid" type="submit" disabled={saving}>{saving ? 'Сохраняю…' : 'Сохранить'}</button></div>
  </form></div>
}

function viewRange(view: CalendarView, cursor: Date) {
  if (view === 'week') { const start = startOfWeek(cursor); return { start: dateKey(start), end: dateKey(addDays(start, 6)) } }
  if (view === 'year') return { start: `${cursor.getFullYear()}-01-01`, end: `${cursor.getFullYear()}-12-31` }
  return { start: dateKey(new Date(cursor.getFullYear(), cursor.getMonth(), 1)), end: dateKey(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0)) }
}

function rangeTitle(view: CalendarView, cursor: Date) {
  if (view === 'year') return String(cursor.getFullYear())
  if (view === 'week') { const start = startOfWeek(cursor); const end = addDays(start, 6); return `${start.getDate()} ${MONTHS_GENITIVE[start.getMonth()]} — ${end.getDate()} ${MONTHS_GENITIVE[end.getMonth()]} ${end.getFullYear()}` }
  return `${MONTHS[cursor.getMonth()]} ${cursor.getFullYear()}`
}

function MonthCalendar({ cursor, events, canManage, onSelectDate }: { cursor: Date; events: CalendarEvent[]; canManage: boolean; onSelectDate: (date: string) => void }) {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1)
  const gridStart = startOfWeek(first)
  const days = Array.from({ length: 42 }, (_, index) => addDays(gridStart, index))
  const today = new Date()
  return <div className="month-calendar"><div className="calendar-weekdays">{WEEKDAYS.map((day) => <span key={day}>{day}</span>)}</div><div className="month-days">{days.map((day) => {
    const key = dateKey(day); const dayEvents = events.filter((item) => item.eventDate === key); const outside = day.getMonth() !== cursor.getMonth()
    return <button className={`calendar-day${outside ? ' outside' : ''}${sameDay(day, today) ? ' today' : ''}${dayEvents.length ? ' filled' : ''}`} type="button" key={key} onClick={() => onSelectDate(key)} aria-label={`${formatDay(key)}${dayEvents.length ? `, событий: ${dayEvents.length}` : ''}${canManage ? ', добавить событие' : ''}`}><span>{day.getDate()}</span><div>{dayEvents.slice(0, 3).map((item) => <i className={`event-dot ${item.eventType}`} title={`${formatTime(item.startTime)} ${item.title}`} key={item.id} />)}</div>{dayEvents.length > 3 && <small>+{dayEvents.length - 3}</small>}</button>
  })}</div></div>
}

function WeekCalendar({ cursor, events, onSelectDate }: { cursor: Date; events: CalendarEvent[]; onSelectDate: (date: string) => void }) {
  const start = startOfWeek(cursor); const today = new Date()
  return <div className="week-calendar">{Array.from({ length: 7 }, (_, index) => addDays(start, index)).map((day, index) => { const key = dateKey(day); const dayEvents = events.filter((item) => item.eventDate === key).sort(eventSort); return <button className={`week-day${sameDay(day, today) ? ' today' : ''}`} type="button" onClick={() => onSelectDate(key)} key={key}><span>{WEEKDAYS[index]}</span><b>{day.getDate()}</b><small>{MONTHS_GENITIVE[day.getMonth()]}</small><div>{dayEvents.map((item) => <i className={`week-event ${item.eventType}`} key={item.id}>{formatTime(item.startTime)} {item.title}</i>)}</div></button> })}</div>
}

function YearCalendar({ cursor, events, onSelectMonth }: { cursor: Date; events: CalendarEvent[]; onSelectMonth: (month: number) => void }) {
  const year = cursor.getFullYear()
  return <div className="year-calendar">{MONTHS.map((month, index) => { const prefix = `${year}-${pad(index + 1)}-`; const monthEvents = events.filter((item) => item.eventDate.startsWith(prefix)); return <button className="year-month" type="button" onClick={() => onSelectMonth(index)} key={month}><span>{month}</span><b>{monthEvents.length}</b><small>{monthEvents.length ? `событ${monthEvents.length === 1 ? 'ие' : 'ия'}` : 'нет событий'}</small><div>{Array.from(new Set(monthEvents.map((item) => Number(item.eventDate.slice(-2))))).slice(0, 10).map((day) => <i key={day}>{day}</i>)}</div></button> })}</div>
}

export function CalendarScreen({ title, description, events, canManage, onBack, onSave, onDelete }: { title: string; description: string; events: CalendarEvent[]; canManage: boolean; onBack: () => void; onSave: (input: CalendarEventInput, initial: CalendarEvent | null) => Promise<boolean>; onDelete: (item: CalendarEvent) => Promise<void> }) {
  const [view, setView] = useState<CalendarView>('month')
  const [cursor, setCursor] = useState(() => new Date())
  const [editor, setEditor] = useState<{ initial: CalendarEvent | null; date: string } | null>(null)
  const range = viewRange(view, cursor)
  const visibleEvents = events.filter((item) => item.eventDate >= range.start && item.eventDate <= range.end).sort(eventSort)
  const emptyText = view === 'week' ? 'На этой неделе уведомления не добавлены' : view === 'year' ? 'В этом году уведомления не добавлены' : 'В этом месяце уведомления не добавлены'
  function move(amount: number) { setCursor((current) => view === 'week' ? addDays(current, amount * 7) : view === 'year' ? addYears(current, amount) : addMonths(current, amount)) }
  function selectDate(day: string) { setCursor(parseDate(day)); if (canManage) setEditor({ initial: null, date: day }) }
  return <main><section className="work-header compact calendar-header"><button className="icon-button inverse" type="button" aria-label="Назад" onClick={onBack}>←</button><div><h1>{title}</h1><p>{description}</p></div>{canManage && <button className="button inverse-button" type="button" onClick={() => setEditor({ initial: null, date: dateKey(cursor) })}>＋ Добавить событие</button>}</section>
    <section className="calendar-shell"><div className="calendar-toolbar"><div className="calendar-view-switch" aria-label="Вид календаря">{(['week', 'month', 'year'] as CalendarView[]).map((item) => <button className={view === item ? 'active' : ''} type="button" onClick={() => setView(item)} key={item}>{item === 'week' ? 'Неделя' : item === 'month' ? 'Месяц' : 'Год'}</button>)}</div><div className="calendar-period"><button className="icon-button" type="button" aria-label="Предыдущий период" onClick={() => move(-1)}>←</button><button className="button calendar-today" type="button" onClick={() => setCursor(new Date())}>Сегодня</button><button className="icon-button" type="button" aria-label="Следующий период" onClick={() => move(1)}>→</button></div><h2>{rangeTitle(view, cursor)}</h2></div>
      <div className="calendar-stage" key={`${view}-${range.start}`}>{view === 'month' ? <MonthCalendar cursor={cursor} events={events} canManage={canManage} onSelectDate={selectDate} /> : view === 'week' ? <WeekCalendar cursor={cursor} events={events} onSelectDate={selectDate} /> : <YearCalendar cursor={cursor} events={events} onSelectMonth={(month) => { setCursor(new Date(cursor.getFullYear(), month, 1)); setView('month') }} />}</div>
      <section className="calendar-list"><div className="calendar-list-heading"><p className="eyebrow">Заполненные дни</p><h2>{rangeTitle(view, cursor)}</h2></div><EventGroups events={visibleEvents} canManage={canManage} emptyText={emptyText} onEdit={(item) => setEditor({ initial: item, date: item.eventDate })} onDelete={onDelete} /></section>
    </section>{editor && <EventEditor initial={editor.initial} defaultDate={editor.date} onClose={() => setEditor(null)} onSave={onSave} />}
  </main>
}

export function ScheduleScreen({ title, description, events, canManage, onBack, onSave, onDelete }: { title: string; description: string; events: CalendarEvent[]; canManage: boolean; onBack: () => void; onSave: (input: CalendarEventInput, initial: CalendarEvent | null) => Promise<boolean>; onDelete: (item: CalendarEvent) => Promise<void> }) {
  const [editor, setEditor] = useState<{ initial: CalendarEvent | null; date: string } | null>(null)
  const synchronized = events.filter((item) => item.eventType === 'rehearsal' || item.eventType === 'show').sort(eventSort)
  return <main><section className="work-header compact"><button className="icon-button inverse" type="button" aria-label="Назад" onClick={onBack}>←</button><div><h1>{title}</h1><p>{description}</p></div>{canManage && <button className="button inverse-button" type="button" onClick={() => setEditor({ initial: null, date: dateKey(new Date()) })}>＋ Добавить</button>}</section><section className="schedule-sync-note"><span>↻</span><div><b>Синхронизировано с календарём репертуара</b><p>Репетиции и показы появляются здесь автоматически. Изменение записи обновит оба раздела.</p></div></section><section className="calendar-list schedule-list"><EventGroups events={synchronized} canManage={canManage} emptyText="Репетиции и показы пока не добавлены" onEdit={(item) => setEditor({ initial: item, date: item.eventDate })} onDelete={onDelete} /></section>{editor && <EventEditor initial={editor.initial} defaultDate={editor.date} onClose={() => setEditor(null)} onSave={onSave} />}</main>
}
