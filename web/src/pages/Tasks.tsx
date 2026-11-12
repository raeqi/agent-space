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

/** One line from a Markdown deliverable: its "结论" line if any, else the first prose paragraph. */
function summarize(md: string, max = 90): string {
  const plain = (s: string) => s.replace(/\*\*|__|`/g, '').replace(/^\s*(\d+[.)]|[-*])\s+/, '').trim()
  const lines = md.split('\n').map((l) => l.trim())
  const prose = lines.filter((l) => l && !/^(#|\||```|---|\*\*\*|>)/.test(l))
  const line = plain(prose.find((l) => /^(\*\*)?结论/.test(l)) ?? prose[0] ?? '').replace(/^结论[：:]\s*/, '')
  return line.length > max ? `${line.slice(0, max)}…` : line
}

/** A short state-based status line; agents' step-by-step narration belongs in the history, not here. */
function statusLine(t: any): string {
  if (t.status === 'triage') return '空间助理在整理'
  if (t.status === 'review') return '已交付，等负责人确认'
  if (t.status === 'merged') return t.live
  if (t.status === 'in_progress') {
    if (t.blocked_by_discussion) return '等待讨论结论'
    if (/失败|没能/.test(t.live ?? '')) return '执行遇到问题，需要处理'
    if (/打回/.test(t.live ?? '')) return '按反馈修改中'
    if (/定时任务/.test(t.live ?? '')) return '等待定时执行'
    if (/整理执行结果/.test(t.live ?? '')) return '正在整理结果'
    return 'agent 执行中'
  }
  return t.live ?? ''
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
                  <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}><span>{t.title}{sourceLabel(t.source) && <span className="small muted" style={{ marginLeft: 8 }}>{sourceLabel(t.source)}</span>}</span>{t.status !== 'done' && <Live tone={liveTone(t)}>{L.text(statusLine(t))}</Live>}</span>
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
              {status !== 'done' && <Live tone={liveTone(t)}>{L.text(statusLine(t))}</Live>}
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
  const [showChecks, setShowChecks] = useState(false)
  const [showDoc, setShowDoc] = useState(false)
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
        {t.status !== 'done' && t.live && <Live tone={liveTone(t)}>{L.text(statusLine(t))}</Live>}
      </div>
      {t.merged_into && <Link to={`/spaces/${spaceId}/tasks/${t.merged_into}`} className="sm">查看合并后的任务</Link>}
      {t.raw_input !== t.title && <p className="sm sub">{t.raw_input}</p>}
      {t.status === 'unclaimed' && (
        <div className="row"><button className="btn primary" onClick={() => void claim()}>由我负责，交给 agent 执行</button></div>
      )}
      {data.canRetry && (t.owner_id === me.user.id || space?.space?.owner_id === me.user.id) && (
        <div className="row"><button className="btn primary" onClick={() => void api('POST', `/api/tasks/${t.id}/retry`).then(reload)}>重新执行</button></div>
      )}
      {/* The deliverable stays compact: title, a one-line summary, and the full text and the agent's
          self-check against the acceptance criteria one click away. */}
      {latest && (() => {
        const checks = t.acceptance.map((a: string) => latest.self_check?.find((c: any) => c.item === a))
        const passed = checks.filter((c: any) => c?.ok).length
        const failed = checks.filter((c: any) => c && !c.ok).length
        return (
          <div className="card pad stack" style={{ gap: 6 }}>
            <span className="spread sm"><b style={{ fontWeight: 600 }}>{latest.title}</b>{latest.status === 'approved' ? <Tag tone="green">已通过</Tag> : latest.status === 'rejected' ? <Tag>已打回</Tag> : <span className="small muted">v{latest.version}</span>}</span>
            {!showDoc && <span className="sm sub">{summarize(latest.content)}</span>}
            <span className="row small">
              <button className="btn ghost small history-toggle" aria-expanded={showDoc} onClick={() => setShowDoc(!showDoc)}>{showDoc ? '收起全文' : '查看全文'}</button>
              {t.acceptance.length > 0 && (
                <button className="btn ghost small history-toggle" aria-expanded={showChecks} onClick={() => setShowChecks(!showChecks)} style={{ color: failed ? 'var(--amber)' : undefined }}>
                  {`自检 ${passed}/${t.acceptance.length} 通过${failed ? `，${failed} 项没过` : ''}`}
                </button>
              )}
            </span>
            {showChecks && t.acceptance.map((a: string, i: number) => {
              const check = checks[i]
              return <span key={i} className="sm" style={{ color: check ? (check.ok ? 'var(--green)' : 'var(--amber)') : undefined }}>{check ? (check.ok ? '✓ ' : '✗ ') : '· '}{a}</span>
            })}
            {showDoc && <div className="doc"><Markdown text={latest.content} /></div>}
          </div>
        )
      })()}
      {data.discussions.map((d: any) => (
        <Link key={d.id} to={`/spaces/${spaceId}/discussions/${d.id}`} className="card pad stack" style={{ gap: 2, textDecoration: 'none' }}>
          <span className="spread sm"><span>讨论：{d.title}</span>{d.status === 'resolved' ? <Tag tone="green">已有结论</Tag> : <Tag tone="amber">{d.status === 'escalated' ? (d.decider_name ? `交给${d.decider_name}定夺` : '等人定夺') : '进行中'}</Tag>}</span>
          {d.status === 'escalated' && d.escalate_why && <span className="small muted">{d.escalate_why}</span>}
          {d.outcome && <span className="small muted">{d.outcome}</span>}
        </Link>
      ))}
      {data.events.length > 0 && (() => {
        // Keep a short recent timeline; preserve every event in the expanded view.
        const isDetail = (e: any) => L.internal(e.actor_id) && !/^(交付|创建定时任务|第 \d+ 次执行)/.test(e.text)
        const brief = (s: string) => {
          if (showHistory) return s
          const line = s.split(/[。\n]/)[0]!.trim()
          return line.length > 72 ? `${line.slice(0, 72)}…` : line
        }
        const milestones = data.events.filter((e: any) => !isDetail(e))
        const recent = [...milestones].sort((a: any, b: any) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 3)
        const recentIds = new Set(recent.map((e: any) => e.id))
        const shown = showHistory ? data.events : milestones.filter((e: any) => recentIds.has(e.id))
        const details = data.events.length > shown.length || data.events.some((e: any) => brief(e.text) !== e.text)
        return (
          <section className="stack" style={{ gap: 6 }} aria-label="处理记录">
            <span className="spread"><b className="sm" style={{ fontWeight: 600 }}>处理记录</b><span className="small muted">最近进展</span></span>
            <ol className="history">
              {shown.map((e: any) => (
                <li key={e.id} className="sm"><span className="muted small">{when(e.created_at)}</span> <b>{L.name(e.actor_id, e.actor_name)}</b>：{L.text(brief(e.text))}</li>
              ))}
            </ol>
            {(showHistory || details) && (
              <button className="btn ghost small history-toggle" aria-expanded={showHistory} onClick={() => setShowHistory(!showHistory)}>
                {showHistory ? '收起细节' : `查看完整过程（${data.events.length} 条）`}
              </button>
            )}
          </section>
        )
      })()}
      {data.judgment && (
        <div style={{ marginTop: 'auto', borderTop: '1px solid var(--line2)', paddingTop: 14 }} className="stack">
          {data.judgment.suggestion && <span className="sm">{data.judgment.user_id === me.user.id ? '你的 agent ' : `${t.owner_name}的 agent `}建议{data.judgment.suggestion.replace(/^(通过|打回)：\s*建议(通过|打回)[：:，,]?\s*/, '$1：')}</span>}
          {data.judgment.user_id === me.user.id ? <JudgmentActions j={data.judgment} onDone={reload} /> : <span className="small muted">等{t.owner_name}确认</span>}
        </div>
      )}
    </aside>
  )
}
