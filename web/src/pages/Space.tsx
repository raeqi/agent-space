import { useState } from 'react'
import { Link, Outlet, useLocation, useOutletContext, useParams } from 'react-router-dom'
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
  const [editing, setEditing] = useState(false)
  const s = data.space
  const c = data.counts ?? {}
  const total = Number(c.total ?? 0)
  const done = Number(c.done ?? 0)
  const left = daysLeft(s.goal_due)
  const isOwner = s.owner_id === me.user.id
  const working = data.agents.filter((a: any) => a.activity)
  const personal = data.members.filter((m: any) => !m.left_at && m.agent_activity)

  return (
    <div className="page tight">
      <div className="col">
        {editing ? <GoalEditor space={s} onDone={() => { setEditing(false); reload() }} /> : s.goal_title ? (
          <section className="card pad stack" style={{ gap: 12 }}>
            <div className="spread">
              <span className="stack" style={{ gap: 2 }}><h2>{s.goal_title}</h2><span className="sm muted">{s.goal_due ? `${s.goal_due}${left !== null ? (left >= 0 ? `，还有 ${left} 天` : `，已过 ${-left} 天`) : ''}` : '未定日期'}</span></span>
              {isOwner && <button className="btn ghost" onClick={() => setEditing(true)}>修改</button>}
            </div>
            {s.goal_metrics.length > 0 && <div className="row wrap">{s.goal_metrics.map((m: string) => <span key={m} className="chip" style={{ fontSize: 13, color: 'var(--ink)' }}>{m}</span>)}</div>}
            <div className="stack" style={{ gap: 6 }}>
              <div className="spread sm"><span>完成 {done} / {total} 个任务</span>{Number(c.review ?? 0) > 0 && <span className="muted">{c.review} 个待确认</span>}</div>
              <div className="progress"><div style={{ width: total ? `${(done / total) * 100}%` : 0 }} /></div>
            </div>
          </section>
        ) : (
          <section className="card pad spread">
            <span className="sm muted">没有设定目标</span>
            {isOwner && <button className="btn" onClick={() => setEditing(true)}>设定目标</button>}
          </section>
        )}

        <section className="row wrap" style={{ gap: 10 }}>
          {[['待整理', c.triage], ['待认领', c.unclaimed], ['进行中', c.in_progress], ['待确认', c.review], ['完成', c.done]].map(([label, n]) => (
            <Link key={label} to={`/spaces/${s.id}/tasks`} className="card pad" style={{ flex: '1 1 110px', textDecoration: 'none', display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span className="small muted">{label}</span><span style={{ fontSize: 22, fontWeight: 600 }}>{Number(n ?? 0)}</span>
            </Link>
          ))}
        </section>

        <section>
          <div className="section-label"><span>最近</span><Link to={`/spaces/${s.id}/assets/memory`} className="small muted">全部记忆</Link></div>
          <div className="card list">
            {data.recentMemory.map((m: any, i: number) => <div key={i} className="grid-row" style={{ gridTemplateColumns: '84px minmax(0,1fr)' }}><span className="small muted">{when(m.created_at)}</span><span className="sm">{m.text}</span></div>)}
          </div>
        </section>
      </div>

      <aside className="aside">
        <section className="card pad">
          <div className="section-label"><span>等人判断</span><span>{data.waiting.length}</span></div>
          {data.waiting.length === 0 && <p className="sm muted">暂无</p>}
          {data.waiting.map((j: any) => (
            <Link key={j.id} to={j.kind === 'confirm' ? `/spaces/${s.id}/tasks/${j.ref_id}` : `/spaces/${s.id}/discussions/${j.ref_id}`} className="spread" style={{ textDecoration: 'none', padding: '6px 0' }}>
              <span className="sm">{j.title}</span><Tag tone="amber">{j.user_id === me.user.id ? '等你' : `等${j.user_name}`}{j.kind === 'confirm' ? '确认' : '定夺'}</Tag>
            </Link>
          ))}
        </section>
        <section>
          <div className="section-label"><span>agent 此刻</span></div>
          <div className="list">
            {working.map((a: any) => <div key={a.id} className="stack" style={{ gap: 2, padding: '8px 0' }}><span className="sm">{a.name}</span><Live>{a.activity}</Live></div>)}
            {personal.map((m: any) => <div key={m.id} className="stack" style={{ gap: 2, padding: '8px 0' }}><span className="sm">{m.name}的 agent</span><Live>{m.agent_activity}</Live></div>)}
            {working.length + personal.length === 0 && <p className="sm muted" style={{ padding: '8px 0' }}>都空闲</p>}
          </div>
        </section>
      </aside>
    </div>
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
        <section className="card pad stack sm">
          <h3>空间 agent</h3>
          {data.agents.map((a: any) => <span key={a.id} className="spread"><span>{a.name}</span>{a.activity ? <Live>{a.activity}</Live> : <span className="muted small">空闲</span>}</span>)}
        </section>
      </aside>
    </div>
  )
}
