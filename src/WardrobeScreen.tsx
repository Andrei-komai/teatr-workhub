import { FormEvent, useMemo, useState } from 'react'

export type WardrobeItem = {
  id: string
  performance: string
  itemQuantity: string
  updatedByName: string
  updatedAt: number
}

export type WardrobeItemInput = {
  performance: string
  itemQuantity: string
}

function formatUpdatedAt(value: number) {
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value))
}

function WardrobeEditor({ initial, onSave, onCancel }: { initial: WardrobeItem | null; onSave: (input: WardrobeItemInput, initial: WardrobeItem | null) => Promise<boolean>; onCancel: () => void }) {
  const [saving, setSaving] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    setSaving(true)
    const saved = await onSave({
      performance: String(data.get('performance') ?? '').trim(),
      itemQuantity: String(data.get('itemQuantity') ?? '').trim(),
    }, initial)
    setSaving(false)
    if (saved) onCancel()
  }

  return <form className="wardrobe-editor" onSubmit={submit}>
    <label><span>Спектакль</span><input name="performance" defaultValue={initial?.performance ?? ''} placeholder="Например, Вера" minLength={2} maxLength={120} autoFocus required /></label>
    <label><span>Наименование и количество</span><input name="itemQuantity" defaultValue={initial?.itemQuantity ?? ''} placeholder="Например, платья серые — 9 штук" minLength={2} maxLength={500} required /></label>
    <div className="wardrobe-editor-actions"><button className="button" type="button" onClick={onCancel} disabled={saving}>Отмена</button><button className="button button-solid" type="submit" disabled={saving}>{saving ? 'Сохраняем…' : 'Сохранить'}</button></div>
  </form>
}

export function WardrobeScreen({ title, description, items, loading, canManage, onBack, onSave, onDelete }: { title: string; description: string; items: WardrobeItem[]; loading: boolean; canManage: boolean; onBack: () => void; onSave: (input: WardrobeItemInput, initial: WardrobeItem | null) => Promise<boolean>; onDelete: (item: WardrobeItem) => Promise<void> }) {
  const [editor, setEditor] = useState<WardrobeItem | null | undefined>(undefined)
  const sortedItems = useMemo(() => [...items].sort((left, right) => left.performance.localeCompare(right.performance, 'ru', { numeric: true }) || right.updatedAt - left.updatedAt), [items])

  return <main>
    <section className="work-header compact wardrobe-header"><button className="icon-button inverse" type="button" aria-label="Назад" onClick={onBack}>←</button><div><h1>{title}</h1><p>{description}</p></div>{canManage && <button className="button inverse-button" type="button" onClick={() => setEditor(null)}>＋ Добавить строку</button>}</section>
    <section className="wardrobe-shell">
      {editor !== undefined && <WardrobeEditor initial={editor} onSave={onSave} onCancel={() => setEditor(undefined)} />}

      <div className={`wardrobe-table${canManage ? ' can-manage' : ''}`} role="table" aria-label="Костюмерная">
        <div className="wardrobe-row wardrobe-table-head" role="row"><span role="columnheader">Спектакль</span><span role="columnheader">Наименование и количество</span><span role="columnheader">Последнее изменение</span><span role="columnheader">Кто изменил</span>{canManage && <span role="columnheader" aria-label="Действия" />}</div>
        {sortedItems.map((item) => <article className="wardrobe-row" role="row" key={item.id}>
          <div className="wardrobe-cell" role="cell" data-label="Спектакль"><b>{item.performance}</b></div>
          <div className="wardrobe-cell wardrobe-item-quantity" role="cell" data-label="Наименование и количество">{item.itemQuantity}</div>
          <div className="wardrobe-cell" role="cell" data-label="Последнее изменение"><time dateTime={new Date(item.updatedAt).toISOString()}>{formatUpdatedAt(item.updatedAt)}</time></div>
          <div className="wardrobe-cell" role="cell" data-label="Кто изменил">{item.updatedByName || 'Участник'}</div>
          {canManage && <div className="wardrobe-row-actions" role="cell"><button className="icon-button" type="button" aria-label={`Редактировать ${item.performance}`} onClick={() => setEditor(item)}>✎</button><button className="icon-button danger" type="button" aria-label={`Удалить ${item.performance}`} onClick={() => onDelete(item)}>×</button></div>}
        </article>)}
      </div>

      {loading && <div className="wardrobe-empty">Загружаем костюмерную…</div>}
      {!loading && !sortedItems.length && <div className="wardrobe-empty">Здесь пока нет записей</div>}
    </section>
  </main>
}
