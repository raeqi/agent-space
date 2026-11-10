import { CompactText } from '../ui.tsx'
import { useState } from 'react'
import { Link, Outlet, useLocation, useOutletContext, useParams, useSearchParams } from 'react-router-dom'
import { api, spaceStream, useApi } from '../api.ts'
import { Avatar, Live, Nav, SpaceHeader, Tag, useMe, when } from '../ui.tsx'

export interface SpaceCtx { data: any; reload: () => void; spaceId: string }
export const useSpace = () => useOutletContext<SpaceCtx>()

export function SpaceLayout() {
  const { spaceId = '' } = useParams()
  const { pathname } = useLocation()
  const { data, error, reload } = useApi(`/api/spaces/${spaceId}`, [spaceStream(spaceId)])
  const tab = pathname.includes('/tasks') || pathname.includes('/flow') ? '任务' : pathname.includes('/discussions') ? '讨论' : pathname.includes('/assets') ? '资产' : pathname.includes('/members') ? '成员' : '概览'
  return (
    <div className="app">
      <Nav />
      <main className="main">
        {error && <div className="page"><p className="error">{error}</p></div>}
        {data && <><SpaceHeader space={data.space} tab={tab} members={data.members} /><Outlet context={{ data, reload, spaceId } satisfies SpaceCtx} /></>}
      </main>
    </div>
  )
}

function daysLeft(due: string | null): number | null {
  if (!due) return null
  const d = new Date(`${due}T23:59:59`)
  if (Number.isNaN(d.getTime())) return null
  return Math.ceil((d.getTime() - Date.now()) / 86_400_000)
}

function GoalEditor({ space, onDone }: { space: any; onDone: () => void }) {
  const [title, setTitle] = useState(space.goal_title ?? '')
  const [due, setDue] = useState(space.goal_due ?? '')
  const [metrics, setMetrics] = useState((space.goal_metrics ?? []).join('，'))
  const [error, setError] = useState('')
  const save = async () => {
    try {
      await api('PUT', `/api/spaces/${space.id}/goal`, { goalTitle: title, goalDue: due, goalMetrics: metrics.split(/[，,]/).map((s: string) => s.trim()).filter(Boolean) })
      onDone()
    } catch (e) { setError((e as Error).message) }
  }
  return (
    <div className="card pad stack">
      <div className="row">
        <input className="input" aria-label="目标" placeholder="目标" value={title} onChange={(e) => setTitle(e.target.value)} />
        <input className="input" aria-label="截止日期" type="date" style={{ maxWidth: 170 }} value={due} onChange={(e) => setDue(e.target.value)} />
      </div>
      <input className="input" aria-label="成功标准" placeholder="成功标准（逗号分隔）" value={metrics} onChange={(e) => setMetrics(e.target.value)} />
      {error && <p className="error">{error}</p>}
      <div className="row"><button className="btn primary" onClick={() => void save()}>保存目标</button><button className="btn ghost" onClick={onDone}>取消</button></div>
    </div>
  )
}

export function Overview() {
  const { data, reload } = useSpace()
  const { me } = useMe()
  const [goalParams, setGoalParams] = useSearchParams()
  const editing = goalParams.get("goal") === "edit" && data.space.owner_id === me.user.id
  const setEditing = (value: boolean) => setGoalParams((previous) => { const next = new URLSearchParams(previous); if (value) next.set("goal", "edit"); else next.delete("goal"); return next })
  const { data: taskData } = useApi<{ tasks: any[] }>(`/api/spaces/${data.space.id}/tasks`, [spaceStream(data.space.id)])
  const tasks = (taskData?.tasks ?? []).filter((t: any) => t.status !== 'merged')
  const s = data.space
  const c = data.counts ?? {}
  const total = Number(c.total ?? 0)
  const done = Number(c.done ?? 0)
  const left = daysLeft(s.goal_due)
  const isOwner = s.owner_id === me.user.id

  return (
    <div className="page tight workspace-overview">
      <div className="col">

        {editing ? <GoalEditor space={s} onDone={() => { setEditing(false); reload() }} /> : s.goal_title ? (
          <section className="card pad stack goal-card" style={{ gap: 12 }}>
            <div className="spread">
              <span className="stack" style={{ gap: 2 }}><h2>{s.goal_title}</h2><span className="sm muted">{s.goal_due ? `${s.goal_due}${left !== null ? (left >= 0 ? `，还有 ${left} 天` : `，已过 ${-left} 天`) : ''}` : '未定日期'}</span></span>
              {isOwner && <span className="row"><button className="btn ghost" disabled={data.planning} onClick={() => void api('POST', `/api/spaces/${s.id}/plan`).then(reload)}>再拆一批</button><button className="btn ghost" onClick={() => setEditing(true)}>修改</button></span>}
            </div>
            {data.planning && <Live>空间助理在按目标拆任务</Live>}
            {s.goal_metrics.length > 0 && <div className="row wrap">{s.goal_metrics.map((m: string) => <span key={m} className="chip" style={{ fontSize: 13, color: 'var(--ink)' }}>{m}</span>)}</div>}
            <div className="stack" style={{ gap: 6 }}>
              <div className="spread sm"><span>完成 {done} / {total} 个任务</span>{Number(c.review ?? 0) > 0 && <span className="muted">{c.review} 个待确认</span>}</div>
              <div className="progress"><div style={{ width: total ? `${(done / total) * 100}%` : 0 }} /></div>
            </div>
          </section>
        ) : null}

        <section className="work-section">
          <div className="section-label"><span>空间里的事</span><Link to={`/spaces/${s.id}/tasks`} className="small muted">全部任务 ↗</Link></div>
          {!taskData && <div className="card empty">正在读取任务…</div>}
          {taskData && tasks.length === 0 && <div className="card empty">还没有任务，点击右上角「发起任务」开始。</div>}
          <div className="work-items">{[...tasks].sort((a: any, b: any) => (['review','in_progress','unclaimed','triage','done'].indexOf(a.status) - ['review','in_progress','unclaimed','triage','done'].indexOf(b.status))).slice(0, 8).map((t: any) => {
            const stage = t.status === 'done' ? 4 : t.status === 'review' ? 3 : t.status === 'in_progress' ? 1 : 0
            const waiting = data.waiting.find((j: any) => j.ref_id === t.id)
            return <Link className={`work-item stage-${stage}`} key={t.id} to={`/spaces/${s.id}/tasks/${t.id}`}><div className="work-item-top"><Tag tone={t.blocked_by_discussion ? 'amber' : stage === 4 ? 'green' : stage === 3 ? 'amber' : 'indigo'}>{t.blocked_by_discussion ? '讨论中' : ['整理与分工','执行中','','待确认','已完成'][stage]}</Tag><span className="small muted">{when(t.updated_at)}</span></div><h3>{t.title}</h3><div className="work-ownership"><span>负责人 <b>{t.owner_name || '待分配'}</b></span><span>执行 <b>{t.executor_name || '空间助理正在安排'}</b></span></div><p className="work-next">{t.blocked_by_discussion ? `需要先解决：${t.blocked_title || '执行中的分歧'}` : stage === 3 ? `等待${waiting?.user_name || t.owner_name || '负责人'}确认交付，查看产物和个人 agent 的建议 →` : stage === 4 ? '查看交付结果 →' : t.live || '空间助理正在补全需求和验收标准'}</p></Link>
          })}</div>
        </section>
        {data.openDiscussions.length > 0 && <section>
          <div className="section-label"><span>正在协调 <span className="count-pill">{data.openDiscussions.length}</span></span><Link to={`/spaces/${s.id}/discussions`} className="small muted">查看讨论 ↗</Link></div>
          <div className="coordination-grid">{data.openDiscussions.map((d: any) => <Link className="coordination-card" key={d.id} to={`/spaces/${s.id}/discussions/${d.id}`}><span className="coordination-symbol">↔</span><Tag tone={d.status === 'escalated' ? 'amber' : 'indigo'}>{d.status === 'escalated' ? '需要人来定夺' : 'agent 正在协商'}</Tag><h3>{d.title}</h3><span className="small muted">查看各方意见与讨论进展 →</span></Link>)}{data.openDiscussions.length === 0 && <div className="card empty">目前没有待协调的分歧。新的讨论会出现在这里。</div>}</div>
        </section>}

        <section>
          <div className="section-label"><span>共享动态</span><Link to={`/spaces/${s.id}/assets/memory`} className="small muted">全部记忆</Link></div>
          <div className="card list">
            {data.recentMemory.length === 0 && <div className="empty">讨论结论、团队标准和成员变化会留在这里，成为共同的上下文。</div>}
            {data.recentMemory.map((m: any, i: number) => <div key={i} className="grid-row" style={{ gridTemplateColumns: '84px minmax(0,1fr)' }}><span className="small muted">{when(m.created_at)}</span><span className="sm">{<CompactText text={m.text} />}</span></div>)}
          </div>
        </section>
      </div>

      <aside className="aside workspace-people">
        <section className="people-card"><div className="section-label"><span>成员和他们的 agent</span><Link to={`/spaces/${s.id}/members`} className="small muted">管理 ↗</Link></div><div className="people-list">{data.members.filter((m: any) => !m.left_at).map((m: any) => <div className="person-pair" key={m.id}><div className="row"><Avatar name={m.name} id={m.id} size={34}/><div className="stack" style={{gap: 1}}><b>{m.name}</b><span className="small muted">{m.title || '空间成员'}</span></div>{m.id === me.user.id && <span className="self-label">你</span>}</div><div className="personal-agent"><span className="agent-spark">✧</span><div><span className="sm">{m.name}的 agent</span><div className="small muted">{m.agent_activity || '暂无进行中的活动'}</div></div></div></div>)}</div><div className="space-agent-block"><span className="eyebrow">空间协作</span>{data.agents.filter((a: any) => a.kind === 'assistant').map((a: any) => <div className="row" key={a.id}><span className="assistant-mark">✳</span><div><b className="sm">{a.name}</b><p className="small muted">{a.activity || '空闲'}</p></div></div>)}</div></section>

      </aside>
    </div>
  )
}

function HookCard({ spaceId }: { spaceId: string }) {
  const { data, reload } = useApi<{ url: string; token: string }>(`/api/spaces/${spaceId}/hook`)
  const [show, setShow] = useState(false)
  const [text, setText] = useState('')
  const [sent, setSent] = useState('')
  if (!data) return null
  const url = `${window.location.origin}${data.url}`
  const send = async (e: React.FormEvent) => {
    e.preventDefault()
    await api('POST', `/api/spaces/${spaceId}/hook/test`, { text, source: '测试事件' })
    setText(''); setSent('已转成任务')
  }
  return (
    <section className="card pad stack sm">
      <h3>事件入口</h3>
      <span className="small muted">外部系统把事件 POST 到这里，空间助理会整理成任务</span>
      <code className="small" style={{ wordBreak: 'break-all', background: 'var(--side)', padding: '6px 8px', borderRadius: 6 }}>{url}</code>
      <span className="row small"><span className="muted">token</span><code style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{show ? data.token : '••••••••••••'}</code>
        <button className="btn ghost" onClick={() => setShow(!show)}>{show ? '隐藏' : '显示'}</button>
        <button className="btn ghost" onClick={() => void api('POST', `/api/spaces/${spaceId}/hook/rotate`).then(reload)}>重置</button></span>
      <form className="row" onSubmit={send}>
        <input className="input" aria-label="模拟一条事件" placeholder="模拟一条事件" value={text} onChange={(e) => { setText(e.target.value); setSent('') }} />
        <button className="btn" disabled={!text.trim()}>发送</button>
      </form>
      {sent && <span className="small muted">{sent}</span>}
    </section>
  )
}

export function Members() {
  const { data, reload, spaceId } = useSpace()
  const { me } = useMe()
  const isOwner = data.space.owner_id === me.user.id
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [title, setTitle] = useState('')
  const [leaving, setLeaving] = useState('')
  const [successor, setSuccessor] = useState('')
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')
  const active = data.members.filter((m: any) => !m.left_at)

  const invite = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    try { await api('POST', `/api/spaces/${spaceId}/members`, { email, name, title }); setEmail(''); setName(''); setTitle(''); reload() } catch (err) { setError((err as Error).message) }
  }
  const handover = async () => {
    setError('')
    try {
      const r = await api('POST', `/api/spaces/${spaceId}/handover`, { leavingUserId: leaving, successorId: successor })
      setMsg(`已交接 ${r.tasks} 个任务`); setLeaving(''); setSuccessor(''); reload()
    } catch (err) { setError((err as Error).message) }
  }

  return (
    <div className="page tight">
      <div className="col">
        <section className="card list">
          <div className="grid-row table-head" style={{ gridTemplateColumns: 'minmax(0,1.3fr) minmax(0,1fr) minmax(0,1.4fr)' }}><span>成员</span><span>分工</span><span>个人 agent</span></div>
          {data.members.map((m: any) => (
            <div key={m.id} className="grid-row" style={{ gridTemplateColumns: 'minmax(0,1.3fr) minmax(0,1fr) minmax(0,1.4fr)', opacity: m.left_at ? 0.5 : 1 }}>
              <span className="row" style={{ gap: 10 }}><Avatar name={m.name} id={m.id} size={28} /><span className="stack" style={{ gap: 0 }}><span>{m.name}{m.id === me.user.id ? '（你）' : ''}</span><span className="small muted">{m.email}</span></span></span>
              <span className="sm">{m.id === data.space.owner_id ? 'owner' : m.title || '—'}{m.left_at ? '，已离开' : ''}</span>
              <span className="sm">{m.left_at ? '随本人离开' : m.agent_activity ? <Live>{m.agent_activity}</Live> : <span className="muted">空闲</span>}</span>
            </div>
          ))}
        </section>
        {isOwner && active.length > 1 && (
          <section className="card pad stack">
            <h3>交接</h3>
            <div className="row">
              <select className="select" aria-label="离开的人" value={leaving} onChange={(e) => setLeaving(e.target.value)}><option value="">谁离开</option>{active.filter((m: any) => m.id !== data.space.owner_id).map((m: any) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
              <select className="select" aria-label="接手的人" value={successor} onChange={(e) => setSuccessor(e.target.value)}><option value="">交给谁</option>{active.filter((m: any) => m.id !== leaving).map((m: any) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
              <button className="btn primary" disabled={!leaving || !successor} onClick={() => void handover()}>确认交接</button>
            </div>
            <span className="small muted">任务和待处理事项转给接手的人；标准、决策和产物留在空间</span>
            {msg && <span className="sm">{msg}</span>}
          </section>
        )}
        {error && <p className="error">{error}</p>}
      </div>
      <aside className="aside">
        <form className="card pad stack" onSubmit={invite}>
          <h3>邀请成员</h3>
          <input className="input" type="email" required aria-label="邮箱" placeholder="邮箱" value={email} onChange={(e) => setEmail(e.target.value)} />
          <div className="row"><input className="input" aria-label="名字" placeholder="名字" value={name} onChange={(e) => setName(e.target.value)} /><input className="input" aria-label="分工" placeholder="分工" value={title} onChange={(e) => setTitle(e.target.value)} /></div>
          <button className="btn primary" disabled={!email.trim()}>邀请</button>
        </form>
        {isOwner && <HookCard spaceId={spaceId} />}
        <section className="card pad stack sm">
          <h3>空间 agent</h3>
          {data.agents.filter((a: any) => a.kind === 'assistant').map((a: any) => <span key={a.id} className="spread"><span>{a.name}</span>{a.activity ? <Live>{a.activity}</Live> : <span className="muted small">空闲</span>}</span>)}
        </section>
      </aside>
    </div>
  )
}
