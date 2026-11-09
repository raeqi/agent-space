import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { api, useApi, USER_STREAM } from './api.ts'

const PALETTE = ['#0F766E', '#6D28D9', '#BE185D', '#C2410C', '#A16207', '#1D4ED8', '#4D7C0F', '#0E7490']

export function colorFor(id: string): string {
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return PALETTE[h % PALETTE.length]!
}

export function Avatar({ name, id, size = 22, agent = false }: { name: string; id: string; size?: number; agent?: boolean }) {
  // People and their personal agents share a colour, keyed by the person's name.
  const person = (name || id).replace(/的 agent$/, '')
  return <span className={`av${agent ? ' agent' : ''}`} style={{ width: size, height: size, background: agent ? '#52525B' : colorFor(person), fontSize: Math.max(10, size / 2 - 1) }} aria-hidden>{(person || '?').slice(0, 1)}</span>
}

export function Tag({ children, tone }: { children: ReactNode; tone?: 'amber' | 'green' | 'indigo' }) {
  return <span className={`tag${tone ? ` ${tone}` : ''}`}>{children}</span>
}

export function Live({ children, tone }: { children: ReactNode; tone?: 'warn' | 'idle' }) {
  if (!children) return null
  return <span className={`live${tone ? ` ${tone}` : ''}`}>{children}</span>
}

export const STATUS: Record<string, { label: string; tone?: 'amber' | 'green' | 'indigo' }> = {
  triage: { label: '待整理' },
  unclaimed: { label: '待认领', tone: 'indigo' },
  in_progress: { label: '进行中' },
  review: { label: '待确认', tone: 'amber' },
  done: { label: '完成', tone: 'green' },
  merged: { label: '已合并' },
}

export function StatusTag({ status, blocked }: { status: string; blocked?: boolean }) {
  if (blocked && status === 'in_progress') return <Tag tone="amber">卡在讨论</Tag>
  const s = STATUS[status] ?? { label: status }
  return <Tag tone={s.tone}>{s.label}</Tag>
}

export function when(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

/** Minimal, escaping Markdown renderer for agent-produced documents. */
export function Markdown({ text }: { text: string }) {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>')
  const out: string[] = []
  let list = false
  for (const line of text.split('\n')) {
    const h = /^(#{1,3})\s+(.*)$/.exec(line)
    const li = /^\s*[-*]\s+(.*)$/.exec(line)
    if (!li && list) { out.push('</ul>'); list = false }
    if (h) out.push(`<h${h[1]!.length}>${inline(h[2]!)}</h${h[1]!.length}>`)
    else if (li) { if (!list) { out.push('<ul>'); list = true } out.push(`<li>${inline(li[1]!)}</li>`) }
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`)
  }
  if (list) out.push('</ul>')
  return <div dangerouslySetInnerHTML={{ __html: out.join('') }} />
}

// ---------- session & compose ----------

export interface Me { user: { id: string; name: string; email: string }; agent: { id: string; name: string; public_profile: string; handbook: string; activity: string } }
const MeContext = createContext<{ me: Me; refresh: () => void } | null>(null)
export const useMe = () => useContext(MeContext)!
export function MeProvider({ me, refresh, children }: { me: Me; refresh: () => void; children: ReactNode }) {
  return <MeContext.Provider value={{ me, refresh }}>{children}</MeContext.Provider>
}

const ComposeContext = createContext<(spaceId?: string) => void>(() => undefined)
export const useCompose = () => useContext(ComposeContext)

export function ComposeProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<{ spaceId?: string } | null>(null)
  const location = useLocation()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        const m = /^\/spaces\/([^/]+)/.exec(location.pathname)
        setOpen({ spaceId: m?.[1] })
      }
      if (e.key === 'Escape') setOpen(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [location.pathname])
  return (
    <ComposeContext.Provider value={(spaceId) => setOpen({ spaceId })}>
      {children}
      {open && <ComposeDialog initialSpace={open.spaceId} onClose={() => setOpen(null)} />}
    </ComposeContext.Provider>
  )
}

function ComposeDialog({ initialSpace, onClose }: { initialSpace?: string; onClose: () => void }) {
  const { data } = useApi<{ spaces: Array<{ id: string; name: string }> }>('/api/spaces')
  const [spaceId, setSpaceId] = useState(initialSpace ?? '')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const navigate = useNavigate()
  useEffect(() => { if (!spaceId && data?.spaces[0]) setSpaceId(data.spaces[0].id) }, [data, spaceId])
  const submit = async () => {
    if (!text.trim() || !spaceId) return
    setBusy(true)
    try {
      const { task } = await api('POST', `/api/spaces/${spaceId}/tasks`, { text })
      onClose()
      navigate(`/spaces/${spaceId}/tasks/${task.id}`)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="dialog" role="dialog" aria-label="发起任务">
        <div className="dialog-head"><h3>发起任务</h3>
          <label className="row sm muted">空间
            <select className="select" style={{ width: 180 }} value={spaceId} onChange={(e) => setSpaceId(e.target.value)}>
              {data?.spaces.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        </div>
        <div className="dialog-body">
          <label className="sr" htmlFor="compose">任务内容</label>
          <textarea id="compose" className="textarea" autoFocus placeholder="用一句话说要做什么，例如：上线前写一份客服 FAQ，失败原因和处理办法都要有" value={text} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit() }} />
          <p className="small muted">发布后，空间助理会改写标题、写验收标准、选负责人和执行的专项 agent；和已有任务重复会自动合并。</p>
          {error && <p className="error">{error}</p>}
          {data && data.spaces.length === 0 && <p className="error">你还没有空间，先新建一个。</p>}
        </div>
        <div className="dialog-foot"><span className="small muted">⌘ Enter 发布，Esc 取消</span>
          <span className="row"><button className="btn lg" onClick={onClose}>取消</button><button className="btn primary lg" disabled={busy || !text.trim() || !spaceId} onClick={() => void submit()}>发布任务</button></span>
        </div>
      </div>
    </div>
  )
}

// ---------- navigation ----------

export function Nav() {
  const { me } = useMe()
  const compose = useCompose()
  const { data: spaces } = useApi<{ spaces: Array<{ id: string; name: string; pending: number }> }>('/api/spaces', [USER_STREAM])
  const { data: inbox } = useApi<{ judgments: unknown[] }>('/api/judgments', [USER_STREAM])
  const pending = inbox?.judgments.length ?? 0
  const item = ({ isActive }: { isActive: boolean }) => `nav-item${isActive ? ' active' : ''}`
  return (
    <nav className="nav" aria-label="主导航">
      <div className="nav-org"><span className="logo">空</span>Agent 空间</div>
      <button className="nav-search" onClick={() => compose()}><span>发起任务</span><span className="kbd">⌘K</span></button>
      <div className="nav-group"><span>我的</span></div>
      <NavLink to="/" end className={item}><span>待处理</span>{pending > 0 && <span className="badge amber">{pending}</span>}</NavLink>
      <NavLink to="/log" className={item}><span>工作记录</span></NavLink>
      <div className="nav-group"><span>空间</span><Link to="/new" className="nav-add" aria-label="新建空间" title="新建空间">+</Link></div>
      {spaces?.spaces.map((s) => (
        <NavLink key={s.id} to={`/spaces/${s.id}`} className={item}><span>{s.name}</span>{s.pending > 0 && <span className="badge">{s.pending}</span>}</NavLink>
      ))}
      {spaces && spaces.spaces.length === 0 && <Link to="/new" className="nav-item muted sm">新建第一个空间</Link>}
      <NavLink to="/agent" className={({ isActive }) => `nav-foot${isActive ? ' active' : ''}`}>
        <Avatar name={me.user.name} id={me.user.id} size={28} />
        <span className="stack" style={{ gap: 0, lineHeight: 1.35 }}><span className="sm">{me.user.name}</span><span className="small muted">{me.agent.activity || '我的 agent'}</span></span>
      </NavLink>
    </nav>
  )
}

export function SpaceHeader({ space, tab, members }: { space: any; tab: string; members: any[] }) {
  const compose = useCompose()
  const tabs = [['概览', ''], ['任务', '/tasks'], ['讨论', '/discussions'], ['资产', '/assets'], ['成员', '/members']]
  const active = members.filter((m) => !m.left_at)
  return (
    <header className="shead">
      <div className="shead-top">
        <span className="row" style={{ gap: 10 }}><b style={{ fontSize: 15, fontWeight: 600 }}>{space.name}</b>
          {space.goal_title ? <span className="chip">目标 {space.goal_due || '未定日期'}</span> : <Link to={`/spaces/${space.id}`} className="small muted">没有设定目标</Link>}
        </span>
        <span className="row" style={{ gap: 12 }}>
          <span className="row" style={{ gap: 0 }}>{active.slice(0, 6).map((m, i) => <span key={m.id} style={{ marginLeft: i ? -6 : 0, border: '2px solid #fff', borderRadius: '50%', display: 'inline-flex' }} title={m.name}><Avatar name={m.name} id={m.id} size={24} /></span>)}</span>
          <button className="btn primary" onClick={() => compose(space.id)}>发起任务</button>
        </span>
      </div>
      <div className="tabs">{tabs.map(([n, p]) => <Link key={n} to={`/spaces/${space.id}${p}`} className={`tab${tab === n ? ' active' : ''}`} aria-current={tab === n ? 'page' : undefined}>{n}</Link>)}</div>
    </header>
  )
}

export function AssetNav({ spaceId, active }: { spaceId: string; active: string }) {
  const items = [['产物', 'artifacts'], ['Skills', 'skills'], ['团队标准', 'standards'], ['记忆', 'memory'], ['资料', 'files']]
  return <div className="seg">{items.map(([n, p]) => <Link key={p} to={`/spaces/${spaceId}/assets/${p}`} className={active === n ? 'on' : ''}>{n}</Link>)}</div>
}

export function logout(): void {
  void api('POST', '/api/logout').then(() => window.location.assign('/'))
}
