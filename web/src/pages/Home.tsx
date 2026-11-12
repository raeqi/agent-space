import { CompactText } from '../ui.tsx'
import { useEffect, useState } from 'react'
import { Link, Outlet } from 'react-router-dom'
import { api, useApi, USER_STREAM } from '../api.ts'
import { JudgmentActions } from '../judgment.tsx'
import { DemoBanner, Live, Markdown, Nav, Tag, logout, useMe, when } from '../ui.tsx'

export function PersonalLayout() {
  return <div className="app"><Nav /><main className="main"><DemoBanner /><Outlet /></main></div>
}

function JudgmentCard({ j, first, onDone }: { j: any; first: boolean; onDone: () => void }) {
  const [open, setOpen] = useState(false)
  const suggestion = j.kind === 'confirm' ? j.suggestion.replace(/^(通过|打回)：/, '') : j.suggestion
  return (
    <div className="judgment-card" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10, ...(first ? { background: '#fafaf8', boxShadow: 'inset 2px 0 0 var(--ink)' } : {}) }}>
      <div className="spread">
        <span className="row"><Tag>{j.kind === 'confirm' ? '确认' : '定夺'}</Tag><Link to={j.link} style={{ fontWeight: 500, textDecoration: 'none' }}>{j.title}</Link></span>
        <span className="small muted">{j.space_name}</span>
      </div>
      {j.kind === 'decide' && j.summary && <p className="sm sub">{<CompactText text={j.summary} />}</p>}
      <div className="row wrap sm">
        {j.suggestion ? <span>建议{j.kind === 'confirm' ? (j.suggested_action === 'pass' ? '通过' : '打回') : ''}：{<CompactText text={suggestion} limit={120} />}</span> : <span className="muted">agent 没有给出建议</span>}
        {j.basis && <span className="small muted">依据：{<CompactText text={j.basis} />}</span>}
      </div>
      {j.artifact && (
        <div className="stack" style={{ gap: 6 }}>
          <button className="btn ghost" style={{ alignSelf: 'flex-start', padding: '2px 0' }} onClick={() => setOpen(!open)}>{open ? '收起' : '查看'}「{j.artifact.title}」v{j.artifact.version}</button>
          {open && <div className="doc"><Markdown text={j.artifact.content} /></div>}
        </div>
      )}
      <JudgmentActions j={j} onDone={onDone} />
    </div>
  )
}

export function Inbox() {
  const { data, reload } = useApi<{ judgments: any[] }>('/api/judgments', [USER_STREAM])
  const { data: mine } = useApi<{ tasks: any[] }>('/api/tasks/mine', [USER_STREAM])
  const { data: log } = useApi<{ items: any[] }>('/api/worklog', [USER_STREAM])
  const list = data?.judgments ?? []
  return (
    <div className="page">
      <div className="col">
        <header className="stack" style={{ gap: 4 }}><h1>待处理</h1>{data && <p className="muted">{list.length ? `${list.length} 件需要你判断` : '没有需要你判断的事'}</p>}</header>
        {list.length > 0 && <section className="card list">{list.map((j, i) => <JudgmentCard key={j.id} j={j} first={i === 0} onDone={reload} />)}</section>}
        {data && list.length === 0 && <div className="card empty">agent 交付或遇到分歧时，会出现在这里</div>}
      </div>
      <aside className="aside">
        <section>
          <div className="section-label"><span>我负责的任务</span><span>{mine?.tasks.length ?? ''}</span></div>
          <div className="list">
            {mine?.tasks.map((t) => (
              <Link key={t.id} to={`/spaces/${t.space_id}/tasks/${t.id}`} style={{ textDecoration: 'none', display: 'flex', flexDirection: 'column', gap: 2, padding: '9px 0' }}>
                <span className="spread"><span>{t.title}</span><span className="small muted">{t.space_name}</span></span>
                <Live tone={t.status === 'review' ? 'warn' : undefined}>{t.status === 'review' ? '等待确认' : t.blocked_by_discussion ? '等待讨论结论' : '执行中'}</Live>
              </Link>
            ))}
            {mine && mine.tasks.length === 0 && <p className="sm muted">暂无</p>}
          </div>
        </section>
        <section>
          <div className="section-label"><span>agent 最近替你做的</span><Link to="/log" className="small muted">全部</Link></div>
          <div className="stack sm">{log?.items.slice(0, 4).map((w) => <span key={w.id}>{<CompactText text={w.text} />}</span>)}{log && log.items.length === 0 && <span className="muted">暂无</span>}</div>
        </section>
      </aside>
    </div>
  )
}

export function WorkLog() {
  const { data } = useApi<{ items: any[] }>('/api/worklog', [USER_STREAM])
  const groups = new Map<string, any[]>()
  for (const w of data?.items ?? []) {
    const day = new Date(w.created_at).toDateString() === new Date().toDateString() ? '今天' : new Date(w.created_at).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })
    groups.set(day, [...(groups.get(day) ?? []), w])
  }
  return (
    <div className="page">
      <div className="col">
        <header className="stack" style={{ gap: 4 }}><h1>工作记录</h1><p className="muted">你的 agent 以你的名义做过的事</p></header>
        {data && data.items.length === 0 && <div className="card empty">还没有记录</div>}
        {[...groups].map(([day, items]) => (
          <section key={day} className="card" style={{ overflow: 'hidden' }}>
            <div className="group-head">{day}</div>
            <div className="list">
              {items.map((w) => (
                <div key={w.id} className="grid-row" style={{ gridTemplateColumns: '52px minmax(0,1fr) 120px 72px' }}>
                  <span className="small muted">{when(w.created_at).slice(-5)}</span>
                  <span className="stack" style={{ gap: 2 }}><span>{<CompactText text={w.text} />}</span>{w.basis && <span className="small muted">依据：{w.basis}</span>}</span>
                  <span className="small muted">{w.space_name}</span>
                  {w.link ? <Link to={w.link} className="btn ghost">查看</Link> : <span />}
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}

export function MyAgent() {
  const { me, refresh } = useMe()
  const { data: cfg } = useApi<{ demoMode?: boolean }>('/api/config')
  const [profile, setProfile] = useState(me.agent.public_profile)
  const [handbook, setHandbook] = useState(me.agent.handbook)
  const [saved, setSaved] = useState(false)
  useEffect(() => { setSaved(false) }, [profile, handbook])
  const save = async () => {
    await api('PUT', '/api/me/agent', { public_profile: profile, handbook })
    setSaved(true)
    refresh()
  }
  return (
    <div className="page">
      <div className="col" style={{ maxWidth: 720 }}>
        <header className="spread"><h1>{me.agent.name}</h1><button className="btn ghost" onClick={logout}>退出登录</button></header>
        <div className="field">
          <label className="label" htmlFor="profile">公开档案</label>
          <textarea id="profile" className="textarea" placeholder="擅长什么、近期在做什么、本月可用时间" value={profile} onChange={(e) => setProfile(e.target.value)} />
          <span className="small muted">空间助理分配任务时会参考，成员可见</span>
        </div>
        <div className="field">
          <label className="label" htmlFor="handbook">判断手册</label>
          <textarea id="handbook" className="textarea" style={{ minHeight: 140 }} placeholder="你在意什么、怎么取舍、什么情况一定要问你" value={handbook} onChange={(e) => setHandbook(e.target.value)} />
          <span className="small muted">只给你的 agent 用，不会出现在空间里。{cfg?.demoMode ? '这里写下的内容，代替个人桌面 agent 已经学到的记忆。' : ''}</span>
        </div>
        <div className="row"><button className="btn primary lg" onClick={() => void save()}>保存</button>{saved && <span className="sm muted">已保存</span>}</div>
        <section className="card pad spread">
          <span className="stack" style={{ gap: 2 }}><b style={{ fontWeight: 500 }}>Kimi Work</b><span className="small muted">从桌面端带入你的个人 agent</span></span>
          <button className="btn" disabled>即将支持</button>
        </section>
      </div>
    </div>
  )
}
