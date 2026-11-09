import { useRef, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, spaceStream, useApi } from '../api.ts'
import { AssetNav, Markdown, Tag, when } from '../ui.tsx'

function AssetPage({ active, actions, children }: { active: string; actions?: ReactNode; children: ReactNode }) {
  const { spaceId } = useParams()
  return (
    <div className="page tight" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 16 }}>
      <div className="spread"><AssetNav spaceId={spaceId!} active={active} /><span className="row">{actions}</span></div>
      {children}
    </div>
  )
}

const ART_STATUS: Record<string, { label: string; tone?: 'amber' | 'green' }> = { pending: { label: '待确认', tone: 'amber' }, approved: { label: '已通过', tone: 'green' }, rejected: { label: '已打回' } }

export function Artifacts() {
  const { spaceId, artifactTaskId } = useParams()
  const { data } = useApi<{ artifacts: any[] }>(`/api/spaces/${spaceId}/artifacts`, [spaceStream(spaceId!)])
  const { data: task } = useApi(artifactTaskId ? `/api/tasks/${artifactTaskId}` : null)
  const latest = task?.artifacts?.[0]
  return (
    <AssetPage active="产物">
      <div className="row" style={{ alignItems: 'flex-start', gap: 20 }}>
        <section className="card list" style={{ flex: 1, minWidth: 0 }}>
          <div className="grid-row table-head" style={{ gridTemplateColumns: 'minmax(0,2fr) 70px minmax(0,1.4fr) 80px 90px' }}><span>产物</span><span>类型</span><span>来源任务</span><span>状态</span><span>更新</span></div>
          {data?.artifacts.map((a) => (
            <Link key={a.id} to={`/spaces/${spaceId}/assets/artifacts/${a.task_id}`} className="grid-row rowlink" style={{ gridTemplateColumns: 'minmax(0,2fr) 70px minmax(0,1.4fr) 80px 90px', ...(a.task_id === artifactTaskId ? { background: '#f7f7f5' } : {}) }}>
              <span>{a.title} <span className="small muted">v{a.version}</span></span><span className="small muted">{a.kind}</span><span className="sm sub">{a.task_title}</span>
              <span><Tag tone={ART_STATUS[a.status]?.tone}>{ART_STATUS[a.status]?.label}</Tag></span><span className="small muted">{when(a.created_at)}</span>
            </Link>
          ))}
          {data && data.artifacts.length === 0 && <div className="empty">任务交付后自动归档到这里</div>}
        </section>
        {latest && (
          <section className="card pad stack" style={{ flex: '0 0 440px' }}>
            <div className="spread"><h3>{latest.title}</h3><Link to={`/spaces/${spaceId}/tasks/${artifactTaskId}`} className="small muted">任务</Link></div>
            <div className="doc" style={{ maxHeight: 560, border: 0, padding: 0 }}><Markdown text={latest.content} /></div>
          </section>
        )}
      </div>
    </AssetPage>
  )
}

export function Skills() {
  const { spaceId } = useParams()
  const { data, reload } = useApi<{ skills: any[] }>(`/api/spaces/${spaceId}/skills`, [spaceStream(spaceId!)])
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ name: '', description: '', body: '' })
  const [error, setError] = useState('')
  const save = async () => {
    try { await api('POST', `/api/spaces/${spaceId}/skills`, form); setForm({ name: '', description: '', body: '' }); setOpen(false); reload() } catch (e) { setError((e as Error).message) }
  }
  return (
    <AssetPage active="Skills" actions={!open && <button className="btn primary" onClick={() => setOpen(true)}>新建 skill</button>}>
      {open && (
        <section className="card pad stack">
          <div className="row"><input className="input" aria-label="名称" placeholder="名称" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /><input className="input" aria-label="一句话说明" placeholder="一句话说明" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
          <textarea className="textarea" aria-label="做法" placeholder="做法：步骤、模板、注意事项" style={{ minHeight: 140 }} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
          {error && <p className="error">{error}</p>}
          <div className="row"><button className="btn primary" disabled={!form.name.trim() || !form.body.trim()} onClick={() => void save()}>保存</button><button className="btn ghost" onClick={() => setOpen(false)}>取消</button></div>
        </section>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 }}>
        {data?.skills.map((s) => (
          <div key={s.id} className="card pad stack" style={{ gap: 4 }}>
            <b style={{ fontWeight: 500 }}>{s.name}</b><span className="sm sub">{s.description}</span><span className="small muted">{s.maintainer_name ?? ''}{s.uses ? `，用过 ${s.uses} 次` : ''}</span>
          </div>
        ))}
      </div>
      {data && data.skills.length === 0 && !open && <div className="card empty">专项 agent 执行任务时会按需调用这里的 skill</div>}
    </AssetPage>
  )
}

export function Standards() {
  const { spaceId } = useParams()
  const { data, reload } = useApi<{ standards: any[] }>(`/api/spaces/${spaceId}/standards`, [spaceStream(spaceId!)])
  const [text, setText] = useState('')
  const [scope, setScope] = useState('全部')
  const [error, setError] = useState('')
  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    try { await api('POST', `/api/spaces/${spaceId}/standards`, { text, scope }); setText(''); reload() } catch (err) { setError((err as Error).message) }
  }
  const toggle = async (s: any) => { await api('PUT', `/api/spaces/${spaceId}/standards/${s.id}`, { enabled: !s.enabled }); reload() }
  return (
    <AssetPage active="团队标准">
      <form className="row" onSubmit={add}>
        <label className="sr" htmlFor="rule">规则</label>
        <input id="rule" className="input" placeholder="添加一条规则" value={text} onChange={(e) => setText(e.target.value)} />
        <select className="select" aria-label="适用范围" style={{ width: 110 }} value={scope} onChange={(e) => setScope(e.target.value)}>{['全部', '文档', '数据', '测试'].map((s) => <option key={s}>{s}</option>)}</select>
        <button className="btn primary" disabled={!text.trim()}>添加</button>
      </form>
      {error && <p className="error">{error}</p>}
      <section className="card list">
        <div className="grid-row table-head" style={{ gridTemplateColumns: 'minmax(0,1.6fr) minmax(0,1.4fr) 56px 56px 44px' }}><span>规则</span><span>来源</span><span>适用</span><span>引用</span><span>启用</span></div>
        {data?.standards.map((s) => (
          <div key={s.id} className="grid-row" style={{ gridTemplateColumns: 'minmax(0,1.6fr) minmax(0,1.4fr) 56px 56px 44px' }}>
            <span style={s.enabled ? undefined : { color: 'var(--faint)', textDecoration: 'line-through' }}>{s.text}</span>
            {s.source_ref ? <Link to={s.source_ref.startsWith('t_') ? `/spaces/${spaceId}/tasks/${s.source_ref}` : `/spaces/${spaceId}/discussions/${s.source_ref}`} className="small muted ellipsis" title={s.source}>{s.source}</Link> : <span className="small muted ellipsis" title={s.source}>{s.source}</span>}
            <span className="small muted">{s.scope}</span><span className="small muted">{s.uses || '—'}</span>
            <button className={`switch${s.enabled ? ' on' : ''}`} role="switch" aria-checked={!!s.enabled} aria-label="启用" onClick={() => void toggle(s)}><span /></button>
          </div>
        ))}
        {data && data.standards.length === 0 && <div className="empty">确认或打回时写的理由可以记成标准，所有 agent 都会遵守</div>}
      </section>
    </AssetPage>
  )
}

const MEM_KIND: Record<string, string> = { decision: '决策', standard: '标准', change: '变更', member: '人员' }

export function Memory() {
  const { spaceId } = useParams()
  const { data } = useApi<{ memory: any[] }>(`/api/spaces/${spaceId}/memory`, [spaceStream(spaceId!)])
  const [q, setQ] = useState('')
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [kind, setKind] = useState('')
  const ask = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setAnswer('')
    try { setAnswer((await api('POST', `/api/spaces/${spaceId}/memory/ask`, { question: q })).answer) } catch (err) { setAnswer((err as Error).message) } finally { setBusy(false) }
  }
  const items = (data?.memory ?? []).filter((m) => !kind || m.kind === kind)
  return (
    <AssetPage active="记忆" actions={<div className="seg">{[['', '全部'], ['decision', '决策'], ['standard', '标准'], ['member', '人员'], ['change', '变更']].map(([k, n]) => <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k!)}>{n}</button>)}</div>}>
      <form className="row card" style={{ padding: '4px 4px 4px 12px' }} onSubmit={ask}>
        <label className="sr" htmlFor="ask">问记忆</label>
        <input id="ask" style={{ flex: 1, border: 0, outline: 'none', height: 34, background: 'transparent' }} placeholder="问一个过去的决定，例如：为什么推迟分期付款？" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn primary" disabled={busy || !q.trim()}>{busy ? '查找中' : '问'}</button>
      </form>
      {answer && <div className="card pad sm" style={{ background: 'var(--side)', border: 0 }}>{answer}</div>}
      <section className="card list">
        {items.map((m) => (
          <div key={m.id} className="grid-row" style={{ gridTemplateColumns: '90px 56px minmax(0,1fr)' }}><span className="small muted">{when(m.created_at)}</span><span><Tag>{MEM_KIND[m.kind]}</Tag></span><span className="sm">{m.text}</span></div>
        ))}
        {data && items.length === 0 && <div className="empty">暂无记录</div>}
      </section>
    </AssetPage>
  )
}

export function Files() {
  const { spaceId } = useParams()
  const { data, reload } = useApi<{ files: any[] }>(`/api/spaces/${spaceId}/files`, [spaceStream(spaceId!)])
  const input = useRef<HTMLInputElement>(null)
  const [error, setError] = useState('')
  const upload = async (files: FileList | null) => {
    setError('')
    for (const f of Array.from(files ?? [])) {
      try {
        if (f.size > 500_000) throw new Error(`${f.name} 超过 500KB`)
        await api('POST', `/api/spaces/${spaceId}/files`, { name: f.name, content: await f.text() })
      } catch (e) { setError((e as Error).message) }
    }
    if (input.current) input.current.value = ''
    reload()
  }
  return (
    <AssetPage active="资料" actions={<>
      <button className="btn" disabled title="即将支持">从工作群导入</button>
      <input ref={input} type="file" multiple accept=".md,.txt,.csv,.json,.yaml,.yml,.html,.log" className="sr" id="upload" onChange={(e) => void upload(e.target.files)} />
      <label htmlFor="upload" className="btn primary">上传</label>
    </>}>
      {error && <p className="error">{error}</p>}
      <section className="card list">
        <div className="grid-row table-head" style={{ gridTemplateColumns: 'minmax(0,2fr) 90px 90px 90px 90px' }}><span>资料</span><span>大小</span><span>加入者</span><span>被读取</span><span>时间</span></div>
        {data?.files.map((f) => (
          <div key={f.id} className="grid-row" style={{ gridTemplateColumns: 'minmax(0,2fr) 90px 90px 90px 90px' }}>
            <span>{f.name}</span><span className="small muted">{f.size > 1024 ? `${Math.round(f.size / 1024)} KB` : `${f.size} B`}</span><span className="small muted">{f.added_by_name}</span><span className="small muted">{f.reads ? `${f.reads} 次` : '—'}</span><span className="small muted">{when(f.created_at)}</span>
          </div>
        ))}
        {data && data.files.length === 0 && <div className="empty">上传背景材料（文本、Markdown、CSV），agent 执行任务时会读取并注明出处</div>}
      </section>
    </AssetPage>
  )
}
