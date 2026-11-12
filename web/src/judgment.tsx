import { useState } from 'react'
import { api } from './api.ts'

/** Actions for one open judgment: confirm (通过 / 打回) or decide (按建议定 / 改判). */
export function JudgmentActions({ j, onDone }: { j: any; onDone?: () => void }) {
  const [mode, setMode] = useState<'' | 'reject' | 'override'>('')
  const [reason, setReason] = useState('')
  const [choice, setChoice] = useState('')
  const [asStandard, setAsStandard] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const send = async (body: Record<string, unknown>) => {
    setBusy(true)
    setError('')
    try {
      await api('POST', `/api/judgments/${j.id}`, body)
      onDone?.()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  const confirm = j.kind === 'confirm'
  const watch = j.role === 'watch' || j.suggested_action === 'watch'
  const suggestedReject = j.suggested_action === 'reject'

  if (mode === 'reject') {
    return (
      <div className="stack">
        <label className="sr" htmlFor={`r-${j.id}`}>打回理由</label>
        <input id={`r-${j.id}`} className="input" autoFocus placeholder="打回理由" value={reason} onChange={(e) => setReason(e.target.value)} />
        <label className="check"><input type="checkbox" checked={asStandard} onChange={(e) => setAsStandard(e.target.checked)} />记为团队标准</label>
        {error && <p className="error">{error}</p>}
        <div className="row"><button className="btn primary" disabled={busy || !reason.trim()} onClick={() => void send({ action: 'reject', reason, saveAsStandard: asStandard })}>确认打回</button><button className="btn ghost" onClick={() => setMode('')}>取消</button></div>
      </div>
    )
  }
  if (mode === 'override') {
    return (
      <div className="stack">
        <label className="sr" htmlFor={`c-${j.id}`}>你的结论</label>
        <input id={`c-${j.id}`} className="input" autoFocus placeholder="你的结论" value={choice} onChange={(e) => setChoice(e.target.value)} />
        <input className="input" placeholder="理由（可选）" value={reason} onChange={(e) => setReason(e.target.value)} />
        {reason.trim() && <label className="check"><input type="checkbox" checked={asStandard} onChange={(e) => setAsStandard(e.target.checked)} />把理由记为团队标准</label>}
        {error && <p className="error">{error}</p>}
        <div className="row"><button className="btn primary" disabled={busy || !choice.trim()} onClick={() => void send({ action: 'override', choice, reason, saveAsStandard: asStandard && !!reason.trim() })}>确认</button><button className="btn ghost" onClick={() => setMode('')}>取消</button></div>
      </div>
    )
  }
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row">
        {confirm ? (
          <>
            <button className={`btn${suggestedReject ? '' : ' primary'}`} disabled={busy} onClick={() => void send({ action: 'pass' })}>通过</button>
            <button className={`btn${suggestedReject ? ' primary' : ''}`} disabled={busy} onClick={() => { setReason(suggestedReject ? j.suggestion.replace(/^打回：/, '') : ''); setMode('reject') }}>打回</button>
          </>
        ) : watch ? (
          <>
            <input className="input" placeholder="补充你的意见" value={reason} onChange={(e) => setReason(e.target.value)} />
            <button className="btn" disabled={busy || !reason.trim()} onClick={() => void send({ action: 'comment', reason })}>补充意见</button>
          </>
        ) : (
          <>
            {j.suggestion && <button className="btn primary" disabled={busy} onClick={() => void send({ action: 'accept' })}>按建议定</button>}
            <button className={`btn${j.suggestion ? '' : ' primary'}`} disabled={busy} onClick={() => setMode('override')}>{j.suggestion ? '改判' : '定夺'}</button>
          </>
        )}
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  )
}
