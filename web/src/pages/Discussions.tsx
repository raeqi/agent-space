import { useState } from 'react'
import { CompactText } from '../ui.tsx'
import { Link, useParams } from 'react-router-dom'
import { api, spaceStream, useApi } from '../api.ts'
import { JudgmentActions } from '../judgment.tsx'
import { agentLabels, Avatar, Tag, useMe, when } from '../ui.tsx'
import { useSpace } from './Space.tsx'

const TONE: Record<string, { label: string; tone?: 'amber' | 'green' }> = {
  open: { label: '进行中' },
  escalated: { label: '等人定夺', tone: 'amber' },
  resolved: { label: '已有结论', tone: 'green' },
}

export function Discussions() {
  const { spaceId, discussionId } = useParams()
  const { data } = useApi<{ discussions: any[] }>(`/api/spaces/${spaceId}/discussions`, [spaceStream(spaceId!)])
  const list = data?.discussions ?? []
  const current = discussionId ?? list[0]?.id
  const L = agentLabels(useSpace()?.data?.agents)
  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <aside className="thread-list" style={{ flex: '0 0 290px', borderRight: '1px solid var(--line)', padding: '14px 10px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {data && list.length === 0 && <p className="sm muted" style={{ padding: '8px 10px' }}>agent 需要协调时会自己发起讨论</p>}
        {list.map((d) => (
          <Link key={d.id} to={`/spaces/${spaceId}/discussions/${d.id}`} style={{ textDecoration: 'none', display: 'flex', flexDirection: 'column', gap: 2, padding: '9px 10px', borderRadius: 8, ...(d.id === current ? { background: '#fff', boxShadow: '0 0 0 1px var(--line)' } : {}) }}>
            <span className="spread"><span className="sm">{d.title}</span><Tag tone={TONE[d.status]?.tone}>{TONE[d.status]?.label}</Tag></span>
            <span className="small muted">{L.name(null, d.opened_by ?? '')}{d.task_title ? `，来自「${d.task_title}」` : ''}{d.status === 'escalated' && d.decider_name ? `，交给${d.decider_name}` : ''}</span>
          </Link>
        ))}
      </aside>
      {current ? <Thread key={current} id={current} spaceId={spaceId!} /> : <div className="col" />}
    </div>
  )
}

function RevokeDecision({ discussionId, standards, onDone }: { discussionId: string; standards: Array<{ id: string; text: string; enabled: number }>; onDone: () => void }) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [disableStandards, setDisableStandards] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const linked = standards.filter((s) => s.enabled)
  if (!open) return <button className="btn" onClick={() => setOpen(true)}>撤销结论</button>
  return (
    <div className="stack">
      <input className="input" autoFocus placeholder="为什么撤销" value={reason} onChange={(e) => setReason(e.target.value)} />
      {linked.length > 0 && <label className="check"><input type="checkbox" checked={disableStandards} onChange={(e) => setDisableStandards(e.target.checked)} />同时停用因此记下的团队标准（{linked.map((s) => s.text).join('、')}）</label>}
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button className="btn primary" disabled={busy || !reason.trim()} onClick={() => {
          setBusy(true)
          setError('')
          void api('POST', `/api/discussions/${discussionId}/revoke`, { reason, disableStandards }).then(onDone).catch((e: Error) => { setError(e.message); setBusy(false) })
        }}>确认撤销</button>
        <button className="btn ghost" onClick={() => setOpen(false)}>取消</button>
      </div>
    </div>
  )
}

function Thread({ id, spaceId }: { id: string; spaceId: string }) {
  const { data, reload } = useApi(`/api/discussions/${id}`, [spaceStream(spaceId)])
  const { me } = useMe()
  const L = agentLabels(useSpace()?.data?.agents)
  if (!data) return <main style={{ flex: 1 }} />
  const d = data.discussion
  return (
    <main className="thread" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <div className="spread" style={{ padding: '14px 24px', borderBottom: '1px solid var(--line2)' }}>
        <span className="stack" style={{ gap: 2 }}><b style={{ fontSize: 16, fontWeight: 600 }}>{d.title}</b>{data.task && <span className="small muted">来自任务 <Link to={`/spaces/${spaceId}/tasks/${data.task.id}`} className="muted">{data.task.title}</Link></span>}</span>
        <Tag tone={TONE[d.status]?.tone}>{TONE[d.status]?.label}</Tag>
      </div>
      <div className="thread-body" style={{ padding: '16px 24px', display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 760 }}>
        {data.messages.map((m: any) => {
          const conclusion = m.text.startsWith('结论：') || m.text.startsWith('总结：')
          return conclusion ? (
            <div key={m.id} className="bubble-summary stack" style={{ gap: 2 }}><span className="small muted">{L.name(m.author_id, m.author_name)}，{when(m.created_at)}</span><span>{<CompactText text={L.text(m.text)} limit={140} />}</span></div>
          ) : (
            <div key={m.id} className="msg"><Avatar name={L.name(m.author_id, m.author_name)} id={m.author_id ?? m.author_name} size={26} agent={m.author_kind === 'agent' && !m.author_name.endsWith('的 agent')} />
              <span className="stack" style={{ gap: 2 }}><span className="small muted">{L.name(m.author_id, m.author_name)}，{when(m.created_at)}</span><span>{<CompactText text={L.text(m.text)} limit={140} />}</span></span></div>
          )
        })}
        {d.status === 'escalated' && data.escalation && (
          <div className="bubble-summary stack" style={{ gap: 4 }}>
            <b>交给谁定夺</b>
            <span>{data.escalation.why}</span>
          </div>
        )}
        {d.revoked_outcome && (
          <div className="bubble-summary stack" style={{ gap: 2 }}>
            <span className="small muted">已撤销的结论（不再有效）</span>
            <span>{d.revoked_outcome}</span>
            {d.revoke_reason && <span className="small muted">原因：{d.revoke_reason}</span>}
          </div>
        )}
        {d.status === 'resolved' && d.outcome && (
          <div className="card strong pad stack" style={{ gap: 8 }}>
            <span className="small muted">当前结论</span>
            <b style={{ fontSize: 16, fontWeight: 600 }}>{d.outcome}</b>
            {data.canRevoke && <RevokeDecision discussionId={d.id} standards={data.linkedStandards ?? []} onDone={reload} />}
          </div>
        )}
        {data.judgment && (
          <div className="card strong pad stack decision-dock">
            <span className="small muted">{data.judgment.role === 'watch' ? `你的 agent 供${data.escalation?.deciderName || '负责人'}参考` : data.judgment.user_id === me.user.id ? '你的 agent 以负责人名义建议' : `等${data.escalation?.deciderName || '负责人'}定夺`}</span>
            {data.judgment.suggestion && <b style={{ fontSize: 16, fontWeight: 600 }}>{<CompactText text={data.judgment.suggestion} />}</b>}
            {data.judgment.basis && data.judgment.role !== 'watch' && <span className="small muted">依据：{<CompactText text={data.judgment.basis} />}</span>}
            {data.judgment.user_id === me.user.id && <JudgmentActions j={data.judgment} onDone={reload} />}
          </div>
        )}
      </div>
    </main>
  )
}
