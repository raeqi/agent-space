import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, spaceStream, useApi } from '../api.ts'
import { JudgmentActions } from '../judgment.tsx'
import { agentLabels, Avatar, Live, Markdown, STATUS, StatusTag, Tag, useMe, when } from '../ui.tsx'
import { useSpace } from './Space.tsx'

const ORDER = ['review', 'in_progress', 'unclaimed', 'triage', 'done']

function sourceLabel(source: string | undefined): string {
  if (source === 'plan') return '目标拆解'
  if (source?.startsWith('event:')) return `来自${source.slice(6)}`
  return ''
}

function liveTone(t: any): 'warn' | undefined {
  return t.blocked_by_discussion || t.status === 'review' || /失败|没能/.test(t.live) ? 'warn' : undefined
}

export function Tasks({ flow = false }: { flow?: boolean }) {
  const { spaceId, taskId } = useParams()
  const { data } = useApi<{ tasks: any[] }>(`/api/spaces/${spaceId}/tasks`, [spaceStream(spaceId!)])
  const tasks = (data?.tasks ?? []).filter((t) => t.status !== 'merged')
  const [onlyMine, setOnlyMine] = useState(false)
  const { me } = useMe()
  const shown = onlyMine ? tasks.filter((t) => t.owner_id === me.user.id) : tasks

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <section style={{ flex: 1, minWidth: 0, padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="spread">
          <div className="seg"><Link to={`/spaces/${spaceId}/tasks`} className={flow ? '' : 'on'}>列表</Link><Link to={`/spaces/${spaceId}/flow`} className={flow ? 'on' : ''}>流程</Link></div>
          <label className="check"><input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} />只看我负责的</label>
        </div>
        {data && shown.length === 0 && <div className="card empty">还没有任务，点右上角「发起任务」</div>}
        {flow ? <FlowView tasks={shown} spaceId={spaceId!} /> : <ListView tasks={shown} spaceId={spaceId!} selected={taskId} />}
      </section>
      {taskId && <TaskPanel key={taskId} taskId={taskId} spaceId={spaceId!} />}
    </div>
  )
}

function ListView({ tasks, spaceId, selected }: { tasks: any[]; spaceId: string; selected?: string }) {
  const L = agentLabels(useSpace()?.data?.agents)
  if (tasks.length === 0) return null
  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      {ORDER.map((status) => {
        const rows = tasks.filter((t) => t.status === status)
        if (rows.length === 0) return null
        return (
          <div key={status}>
            <div className="group-head">{STATUS[status]!.label} {rows.length}</div>
            <div className="list">
              {rows.map((t) => (
                <Link key={t.id} to={`/spaces/${spaceId}/tasks/${t.id}`} className={`rowlink${t.id === selected ? ' sel' : ''}`}>
                  <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}><span>{t.title}{sourceLabel(t.source) && <span className="small muted" style={{ marginLeft: 8 }}>{sourceLabel(t.source)}</span>}</span>{t.status !== 'done' && <Live tone={liveTone(t)}>{L.text(t.live)}</Live>}</span>
                  {t.owner_id ? <span title={t.owner_name}><Avatar name={t.owner_name} id={t.owner_id} /></span> : <span style={{ width: 22 }} />}
                  <span style={{ width: 72, display: 'flex', justifyContent: 'flex-end' }}><StatusTag status={t.status} blocked={!!t.blocked_by_discussion} /></span>
                </Link>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function FlowView({ tasks, spaceId }: { tasks: any[]; spaceId: string }) {
  const L = agentLabels(useSpace()?.data?.agents)
  const cols = ['triage', 'in_progress', 'review', 'done']
  return (
    <div className="flow">
      {cols.map((status) => (
        <div key={status} className={`flow-col${status === 'review' ? ' human' : ''}`}>
          <b className="sm" style={{ fontWeight: 600, padding: '2px 2px 4px' }}>{STATUS[status]!.label}</b>
          {tasks.filter((t) => t.status === status).map((t) => (
            <Link key={t.id} to={`/spaces/${spaceId}/tasks/${t.id}`} className="fcard">
              <span style={{ fontWeight: 500 }}>{t.title}</span>
              {status !== 'done' && <Live tone={liveTone(t)}>{L.text(t.live)}</Live>}
              {t.owner_id && <span className="row small muted"><Avatar name={t.owner_name} id={t.owner_id} size={18} />{t.owner_name}</span>}
            </Link>
          ))}
        </div>
      ))}
    </div>
  )
}

function TaskPanel({ taskId, spaceId }: { taskId: string; spaceId: string }) {
  const navigate = useNavigate()
  const { data, reload } = useApi(`/api/tasks/${taskId}`, [spaceStream(spaceId)])
  const { data: space } = useSpace()
  const { me } = useMe()
  const [showHistory, setShowHistory] = useState(false)
  if (!data) return <aside className="panel" />
  const t = data.task
  const latest = data.artifacts[0]
  const claim = async () => { await api('POST', `/api/tasks/${t.id}/claim`, {}); reload() }
  const L = agentLabels(space?.agents)

  return (
    <aside className="panel" aria-label="任务详情">
      <div className="spread"><StatusTag status={t.status} blocked={!!t.blocked_by_discussion} /><button className="btn ghost" aria-label="关闭" onClick={() => navigate(`/spaces/${spaceId}/tasks`)}>✕</button></div>
      <div className="stack" style={{ gap: 4 }}>
        <h2>{t.title}</h2>
        {(t.owner_name || t.due || sourceLabel(t.source)) && <span className="sm muted">{[sourceLabel(t.source), t.owner_name && `负责人 ${t.owner_name}`, t.due && `截止 ${t.due}`].filter(Boolean).join('，')}</span>}
        {t.status !== 'done' && t.live && <Live tone={liveTone(t)}>{L.text(t.live)}</Live>}
      </div>
      {t.merged_into && <Link to={`/spaces/${spaceId}/tasks/${t.merged_into}`} className="sm">查看合并后的任务</Link>}
      {t.raw_input !== t.title && <p className="sm sub">{t.raw_input}</p>}
      {t.acceptance.length > 0 && (
        <div className="stack" style={{ gap: 4 }}>
          <span className="small muted">验收标准</span>
          {t.acceptance.map((a: string, i: number) => {
            const check = latest?.self_check?.find((c: any) => c.item === a)
            return <span key={i} className="sm" style={{ color: check ? (check.ok ? 'var(--green)' : 'var(--amber)') : undefined }}>{check ? (check.ok ? '✓ ' : '✗ ') : '· '}{a}</span>
          })}
        </div>
      )}
      {t.status === 'unclaimed' && (
        <div className="row"><button className="btn primary" onClick={() => void claim()}>由我负责，交给 agent 执行</button></div>
      )}
      {latest && (
        <div className="stack" style={{ gap: 6 }}>
          <span className="spread small muted"><span>{latest.title} v{latest.version}</span>{latest.status === 'approved' && <Tag tone="green">已通过</Tag>}{latest.status === 'rejected' && <Tag>已打回</Tag>}</span>
          <div className="doc"><Markdown text={latest.content} /></div>
        </div>
      )}
      {data.discussions.map((d: any) => (
        <Link key={d.id} to={`/spaces/${spaceId}/discussions/${d.id}`} className="card pad stack" style={{ gap: 2, textDecoration: 'none' }}>
          <span className="spread sm"><span>讨论：{d.title}</span>{d.status === 'resolved' ? <Tag tone="green">已有结论</Tag> : <Tag tone="amber">{d.status === 'escalated' ? '等人定夺' : '进行中'}</Tag>}</span>
          {d.outcome && <span className="small muted">{d.outcome}</span>}
        </Link>
      ))}
      {data.events.length > 0 && (() => {
        const RECENT = 3
        const hidden = Math.max(0, data.events.length - RECENT)
        const shown = showHistory ? data.events : data.events.slice(-RECENT)
        return (
          <section className="stack" style={{ gap: 6 }} aria-label="处理记录">
            <span className="spread"><b className="sm" style={{ fontWeight: 600 }}>处理记录</b><span className="small muted">谁在什么时候做了什么</span></span>
            {hidden > 0 && (
              <button className="btn ghost small history-toggle" aria-expanded={showHistory} onClick={() => setShowHistory(!showHistory)}>
                {showHistory ? '只看最近 3 条' : `显示更早的 ${hidden} 条`}
              </button>
            )}
            <ol className="history">
              {shown.map((e: any) => (
                <li key={e.id} className="sm"><span className="muted small">{when(e.created_at)}</span> <b>{L.name(e.actor_id, e.actor_name)}</b>：{L.text(e.text)}</li>
              ))}
            </ol>
          </section>
        )
      })()}
      {data.judgment && (
        <div style={{ marginTop: 'auto', borderTop: '1px solid var(--line2)', paddingTop: 14 }} className="stack">
          {data.judgment.suggestion && <span className="sm">{data.judgment.user_id === me.user.id ? '你的 agent ' : `${t.owner_name}的 agent `}建议{data.judgment.suggestion}</span>}
          {data.judgment.user_id === me.user.id ? <JudgmentActions j={data.judgment} onDone={reload} /> : <span className="small muted">等{t.owner_name}确认</span>}
        </div>
      )}
    </aside>
  )
}
