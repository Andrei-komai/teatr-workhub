export type ParticipationPolicySignature = {
  profileId: string
  signerName: string
  policyVersion: string
  signedAt: string
}

const POLICY_PAGES = [1, 2, 3]

function formatSignedAt(value: string) {
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

export function ParticipationPolicyScreen({ title, description, signature, signing, onBack, onSign }: {
  title: string
  description: string
  signature: ParticipationPolicySignature | null
  signing: boolean
  onBack: () => void
  onSign: () => void
}) {
  const documentBase = `${import.meta.env.BASE_URL}documents/participation-policy-v1.1`
  return <main>
    <section className="work-header compact policy-header"><button className="icon-button inverse" type="button" aria-label="Назад" onClick={onBack}>←</button><div><h1>{title}</h1><p>{description}</p></div><a className="button inverse-button" href={`${documentBase}.pdf`} target="_blank" rel="noreferrer">Открыть PDF</a></section>
    <section className="policy-shell">
      <div className="policy-version"><span>Официальный документ</span><b>Версия 1.1</b></div>
      <div className="policy-pages" aria-label="Положение об участии, версия 1.1">
        {POLICY_PAGES.map((page) => <img key={page} src={`${documentBase}/page-${page}.png`} alt={`Положение об участии, страница ${page} из ${POLICY_PAGES.length}`} loading={page === 1 ? 'eager' : 'lazy'} decoding="async" />)}
      </div>
      <section className={`policy-signature${signature ? ' signed' : ''}`}>
        {signature ? <><p className="eyebrow">Подпись зафиксирована</p><h2>{signature.signerName}</h2><p>Положение версии {signature.policyVersion} подписано {formatSignedAt(signature.signedAt)}.</p><span className="policy-signed-mark" aria-hidden="true">✓</span></> : <><p className="eyebrow">Подтверждение ознакомления</p><h2>Вы прочитали положение полностью</h2><p>Нажимая кнопку, вы подтверждаете, что прочитали документ версии 1.1 и согласны с каждым его пунктом.</p><button className="button button-solid" type="button" disabled={signing} onClick={onSign}>{signing ? 'Подписываем…' : 'Подписать'}</button></>}
      </section>
    </section>
  </main>
}

export function PolicySignaturesList({ signatures, loading }: { signatures: ParticipationPolicySignature[]; loading: boolean }) {
  return <section className="settings-tab-panel policy-signatures-panel" role="tabpanel">
    <div className="policy-signatures-heading"><div><p className="eyebrow">Версия 1.1</p><h2>Подписали положение</h2></div><span>{signatures.length}</span></div>
    {loading ? <p className="empty-state">Загружаем подписи…</p> : signatures.length === 0 ? <p className="empty-state">Пока никто не подписал положение.</p> : <div className="policy-signatures-list">{signatures.map((signature) => <article key={`${signature.profileId}-${signature.policyVersion}`}><div><b>{signature.signerName}</b><small>Версия {signature.policyVersion}</small></div><time dateTime={signature.signedAt}>{formatSignedAt(signature.signedAt)}</time></article>)}</div>}
  </section>
}
