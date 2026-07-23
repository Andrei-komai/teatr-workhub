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
export type ScheduleEntry = {
  id: string
  eventDate: string
  startTime: string
  teacher: string
  className: string
  topic: string
  absence: string
  authorId: string | null
  createdAt: number
}
export type ScheduleEntryInput = Omit<ScheduleEntry, 'id' | 'authorId' | 'createdAt'>

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

type ScheduleMarker = { id: string; eventDate: string; startTime: string; title: string; kind: 'schedule' | 'calendar' }

function scheduleSort(left: ScheduleEntry, right: ScheduleEntry) { return left.eventDate.localeCompare(right.eventDate) || left.startTime.localeCompare(right.startTime) }

function ScheduleEntryEditor({ initial, defaultDate, onClose, onSave }: { initial: ScheduleEntry | null; defaultDate: string; onClose: () => void; onSave: (input: ScheduleEntryInput, initial: ScheduleEntry | null) => Promise<boolean> }) {
  const [saving, setSaving] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    setSaving(true)
    const saved = await onSave({
      eventDate: String(data.get('eventDate')),
      startTime: String(data.get('startTime')),
      teacher: String(data.get('teacher')).trim(),
      className: String(data.get('className')).trim(),
      topic: String(data.get('topic')).trim(),
      absence: String(data.get('absence')).trim(),
    }, initial)
    setSaving(false)
    if (saved) onClose()
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}><form className="calendar-event-editor schedule-entry-editor" role="dialog" aria-modal="true" aria-labelledby="schedule-editor-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={submit}>
    <button className="modal-close" type="button" aria-label="Закрыть" onClick={onClose}>×</button>
    <p className="eyebrow">Расписание</p><h2 id="schedule-editor-title">{initial ? 'Редактировать запись' : 'Новая запись'}</h2>
    <div className="calendar-form-grid schedule-form-grid">
      <label><span>Дата</span><input name="eventDate" type="date" defaultValue={initial?.eventDate ?? defaultDate} required /></label>
      <label><span>Время</span><input name="startTime" type="time" defaultValue={initial?.startTime.slice(0, 5) ?? '18:00'} required /></label>
      <label className="calendar-form-wide"><span>Кто ведёт — педагог</span><input name="teacher" defaultValue={initial?.teacher ?? ''} maxLength={120} placeholder="ФИ педагога" required autoFocus /></label>
      <label className="calendar-form-wide"><span>Что за класс</span><input name="className" defaultValue={initial?.className ?? ''} maxLength={160} placeholder="Название или направление класса" required /></label>
      <label className="calendar-form-wide"><span>О чём он</span><textarea name="topic" defaultValue={initial?.topic ?? ''} rows={3} maxLength={1000} placeholder="Кратко о чём занятие" /></label>
      <label className="calendar-form-wide"><span>Отсутствие</span><textarea name="absence" defaultValue={initial?.absence ?? ''} rows={2} maxLength={1000} placeholder="ФИ и кратко причина отсутствия" /></label>
    </div>
    <div className="calendar-form-actions"><button className="button" type="button" onClick={onClose}>Отмена</button><button className="button button-solid" type="submit" disabled={saving}>{saving ? 'Сохраняю…' : 'Сохранить'}</button></div>
  </form></div>
}

function CompactMonthCalendar({ cursor, markers, onSelectDate }: { cursor: Date; markers: ScheduleMarker[]; onSelectDate: (date: string) => void }) {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1)
  const days = Array.from({ length: 42 }, (_, index) => addDays(startOfWeek(first), index))
  const today = new Date()
  return <div className="compact-month-calendar"><div className="calendar-weekdays">{WEEKDAYS.map((day) => <span key={day}>{day}</span>)}</div><div className="compact-month-days">{days.map((day) => { const key = dateKey(day); const dayMarkers = markers.filter((item) => item.eventDate === key); return <button className={`compact-calendar-day${day.getMonth() !== cursor.getMonth() ? ' outside' : ''}${sameDay(day, today) ? ' today' : ''}${dayMarkers.length ? ' filled' : ''}`} type="button" key={key} onClick={() => onSelectDate(key)} aria-label={`${formatDay(key)}, добавить запись`}><span>{day.getDate()}</span><div>{dayMarkers.slice(0, 4).map((item) => <i className={`schedule-marker ${item.kind}`} key={`${item.kind}-${item.id}`} />)}</div></button> })}</div></div>
}

function CompactWeekCalendar({ cursor, markers, onSelectDate }: { cursor: Date; markers: ScheduleMarker[]; onSelectDate: (date: string) => void }) {
  const start = startOfWeek(cursor); const today = new Date()
  return <div className="compact-week-calendar">{Array.from({ length: 7 }, (_, index) => addDays(start, index)).map((day, index) => { const key = dateKey(day); const count = markers.filter((item) => item.eventDate === key).length; return <button className={`${sameDay(day, today) ? 'today ' : ''}${count ? 'filled' : ''}`} type="button" onClick={() => onSelectDate(key)} key={key}><span>{WEEKDAYS[index]}</span><b>{day.getDate()}</b><small>{MONTHS_GENITIVE[day.getMonth()]}</small>{count > 0 && <i>{count}</i>}</button> })}</div>
}

function CompactYearCalendar({ cursor, markers, onSelectDate }: { cursor: Date; markers: ScheduleMarker[]; onSelectDate: (date: string) => void }) {
  const year = cursor.getFullYear()
  return <div className="compact-year-calendar">{MONTHS.map((month, monthIndex) => { const first = new Date(year, monthIndex, 1); const offset = (first.getDay() || 7) - 1; const daysInMonth = new Date(year, monthIndex + 1, 0).getDate(); return <section className="compact-year-month" key={month}><b>{month}</b><div className="compact-year-weekdays">{WEEKDAYS.map((day) => <span key={day}>{day.slice(0, 1)}</span>)}</div><div className="compact-year-days">{Array.from({ length: offset }, (_, index) => <i key={`blank-${index}`} />)}{Array.from({ length: daysInMonth }, (_, index) => { const day = index + 1; const key = dateKey(new Date(year, monthIndex, day)); const filled = markers.some((item) => item.eventDate === key); return <button className={filled ? 'filled' : ''} type="button" onClick={() => onSelectDate(key)} key={key}>{day}</button> })}</div></section> })}</div>
}

function ScheduleEntryCard({ item, canManage, onEdit, onDelete }: { item: ScheduleEntry; canManage: boolean; onEdit: (item: ScheduleEntry) => void; onDelete: (item: ScheduleEntry) => void }) {
  return <article className="schedule-entry-card"><div className="calendar-event-time"><b>{formatTime(item.startTime)}</b></div><div className="schedule-entry-content"><span className="event-type schedule">Занятие</span><h3>{item.className}</h3><dl><div><dt>Педагог</dt><dd>{item.teacher}</dd></div>{item.topic && <div><dt>О чём</dt><dd>{item.topic}</dd></div>}{item.absence && <div className="schedule-absence"><dt>Отсутствие</dt><dd>{item.absence}</dd></div>}</dl></div>{canManage && <div className="calendar-event-actions"><button className="icon-button" type="button" aria-label={`Редактировать ${item.className}`} onClick={() => onEdit(item)}>✎</button><button className="icon-button danger" type="button" aria-label={`Удалить ${item.className}`} onClick={() => onDelete(item)}>×</button></div>}</article>
}

function ScheduleGroups({ entries, events, canManage, emptyText, onEditEntry, onDeleteEntry, onEditEvent, onDeleteEvent }: { entries: ScheduleEntry[]; events: CalendarEvent[]; canManage: boolean; emptyText: string; onEditEntry: (item: ScheduleEntry) => void; onDeleteEntry: (item: ScheduleEntry) => void; onEditEvent: (item: CalendarEvent) => void; onDeleteEvent: (item: CalendarEvent) => void }) {
  const days = Array.from(new Set([...entries.map((item) => item.eventDate), ...events.map((item) => item.eventDate)])).sort()
  if (!days.length) return <div className="empty-state calendar-empty">{emptyText}</div>
  return <div className="calendar-event-groups">{days.map((day) => { const dayEntries = entries.filter((item) => item.eventDate === day).sort(scheduleSort); const dayEvents = events.filter((item) => item.eventDate === day).sort(eventSort); return <section className="calendar-day-group" key={day}><h2>{formatDay(day)}</h2>{[...dayEntries.map((item) => ({ kind: 'schedule' as const, time: item.startTime, item })), ...dayEvents.map((item) => ({ kind: 'calendar' as const, time: item.startTime, item }))].sort((left, right) => left.time.localeCompare(right.time)).map((row) => row.kind === 'schedule' ? <ScheduleEntryCard key={`schedule-${row.item.id}`} item={row.item as ScheduleEntry} canManage={canManage} onEdit={onEditEntry} onDelete={onDeleteEntry} /> : <EventCard key={`calendar-${row.item.id}`} item={row.item as CalendarEvent} canManage={canManage} onEdit={onEditEvent} onDelete={onDeleteEvent} />)}</section> })}</div>
}

export function ScheduleScreen({ title, description, events, entries, canManage, onBack, onSaveEvent, onDeleteEvent, onSaveEntry, onDeleteEntry }: { title: string; description: string; events: CalendarEvent[]; entries: ScheduleEntry[]; canManage: boolean; onBack: () => void; onSaveEvent: (input: CalendarEventInput, initial: CalendarEvent | null) => Promise<boolean>; onDeleteEvent: (item: CalendarEvent) => Promise<void>; onSaveEntry: (input: ScheduleEntryInput, initial: ScheduleEntry | null) => Promise<boolean>; onDeleteEntry: (item: ScheduleEntry) => Promise<void> }) {
  const [view, setView] = useState<CalendarView>('month')
  const [cursor, setCursor] = useState(() => new Date())
  const [entryEditor, setEntryEditor] = useState<{ initial: ScheduleEntry | null; date: string } | null>(null)
  const [eventEditor, setEventEditor] = useState<CalendarEvent | null>(null)
  const range = viewRange(view, cursor)
  const visibleEntries = entries.filter((item) => item.eventDate >= range.start && item.eventDate <= range.end).sort(scheduleSort)
  const visibleEvents = events.filter((item) => item.eventDate >= range.start && item.eventDate <= range.end).sort(eventSort)
  const markers: ScheduleMarker[] = [...entries.map((item) => ({ id: item.id, eventDate: item.eventDate, startTime: item.startTime, title: item.className, kind: 'schedule' as const })), ...events.map((item) => ({ id: item.id, eventDate: item.eventDate, startTime: item.startTime, title: item.title, kind: 'calendar' as const }))]
  const emptyText = view === 'week' ? 'На этой неделе записи не добавлены' : view === 'year' ? 'В этом году записи не добавлены' : 'В этом месяце записи не добавлены'
  function move(amount: number) { setCursor((current) => view === 'week' ? addDays(current, amount * 7) : view === 'year' ? addYears(current, amount) : addMonths(current, amount)) }
  function selectDate(day: string) { setCursor(parseDate(day)); if (canManage) setEntryEditor({ initial: null, date: day }) }
  return <main><section className="work-header compact calendar-header"><button className="icon-button inverse" type="button" aria-label="Назад" onClick={onBack}>←</button><div><h1>{title}</h1><p>{description}</p></div>{canManage && <button className="button inverse-button" type="button" onClick={() => setEntryEditor({ initial: null, date: dateKey(cursor) })}>＋ Добавить</button>}</section>
    <section className="calendar-shell schedule-calendar-shell"><div className="calendar-toolbar"><div className="calendar-view-switch" aria-label="Вид календаря расписания">{(['week', 'month', 'year'] as CalendarView[]).map((item) => <button className={view === item ? 'active' : ''} type="button" onClick={() => setView(item)} key={item}>{item === 'week' ? 'Неделя' : item === 'month' ? 'Месяц' : 'Год'}</button>)}</div><div className="calendar-period"><button className="icon-button" type="button" aria-label="Предыдущий период" onClick={() => move(-1)}>←</button><button className="button calendar-today" type="button" onClick={() => setCursor(new Date())}>Сегодня</button><button className="icon-button" type="button" aria-label="Следующий период" onClick={() => move(1)}>→</button></div><h2>{rangeTitle(view, cursor)}</h2></div>
      <div className="calendar-stage schedule-calendar-stage" key={`${view}-${range.start}`}>{view === 'month' ? <CompactMonthCalendar cursor={cursor} markers={markers} onSelectDate={selectDate} /> : view === 'week' ? <CompactWeekCalendar cursor={cursor} markers={markers} onSelectDate={selectDate} /> : <CompactYearCalendar cursor={cursor} markers={markers} onSelectDate={selectDate} />}</div>
      <section className="calendar-list schedule-list"><div className="calendar-list-heading"><p className="eyebrow">Заполненные дни</p><h2>{rangeTitle(view, cursor)}</h2></div><ScheduleGroups entries={visibleEntries} events={visibleEvents} canManage={canManage} emptyText={emptyText} onEditEntry={(item) => setEntryEditor({ initial: item, date: item.eventDate })} onDeleteEntry={onDeleteEntry} onEditEvent={setEventEditor} onDeleteEvent={onDeleteEvent} /></section>
    </section>{entryEditor && <ScheduleEntryEditor initial={entryEditor.initial} defaultDate={entryEditor.date} onClose={() => setEntryEditor(null)} onSave={onSaveEntry} />}{eventEditor && <EventEditor initial={eventEditor} defaultDate={eventEditor.eventDate} onClose={() => setEventEditor(null)} onSave={onSaveEvent} />}
  </main>
}
