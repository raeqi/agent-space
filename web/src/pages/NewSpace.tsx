import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api.ts'

type MemberRow = { email: string; name: string; title: string }

export function NewSpace() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [members, setMembers] = useState<MemberRow[]>([{ email: '', name: '', title: '' }])
  const [withGoal, setWithGoal] = useState(false)
  const [goalTitle, setGoalTitle] = useState('')
  const [goalDue, setGoalDue] = useState('')
  const [metrics, setMetrics] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const setMember = (i: number, patch: Partial<MemberRow>) => setMembers(members.map((m, k) => (k === i ? { ...m, ...patch } : m)))
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const { space } = await api('POST', '/api/spaces', {
        name,
        members: members.filter((m) => m.email.trim()),
        ...(withGoal ? { goalTitle, goalDue, goalMetrics: metrics.split(/[，,\n]/).map((s) => s.trim()).filter(Boolean) } : {}),
      })
      navigate(`/spaces/${space.id}`)
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <div className="page">
      <form className="col" style={{ maxWidth: 640 }} onSubmit={submit}>
        <header className="spread">
          <h1>新建空间</h1>
          <div className="seg"><button type="button" className="on">从零开始</button><button type="button" disabled title="从工作群导入空间和资料还在开发中">从工作群导入<span className="soon">即将支持</span></button></div>
        </header>
        <div className="field"><label className="label" htmlFor="sname">名称</label><input id="sname" className="input" required value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="field">
          <span className="label">成员</span>
          {members.map((m, i) => (
            <div key={i} className="row">
              <input className="input" type="email" aria-label="邮箱" placeholder="邮箱" value={m.email} onChange={(e) => setMember(i, { email: e.target.value })} />
              <input className="input" aria-label="名字" placeholder="名字" style={{ maxWidth: 120 }} value={m.name} onChange={(e) => setMember(i, { name: e.target.value })} />
              <input className="input" aria-label="分工" placeholder="分工" style={{ maxWidth: 120 }} value={m.title} onChange={(e) => setMember(i, { title: e.target.value })} />
              <button type="button" className="btn ghost" aria-label="移除" onClick={() => setMembers(members.length > 1 ? members.filter((_, k) => k !== i) : [{ email: '', name: '', title: '' }])}>✕</button>
            </div>
          ))}
          <button type="button" className="btn ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setMembers([...members, { email: '', name: '', title: '' }])}>添加成员</button>
          <span className="small muted">每位成员的个人 agent 会随本人加入</span>
        </div>
        <div className="card">
          <label className="spread" style={{ padding: '12px 14px', cursor: 'pointer' }}>
            <span className="stack" style={{ gap: 0 }}><span style={{ fontWeight: 500 }}>设定目标</span><span className="small muted">可选，之后也能加</span></span>
            <input type="checkbox" checked={withGoal} onChange={(e) => setWithGoal(e.target.checked)} style={{ width: 18, height: 18, accentColor: 'var(--ink)' }} />
          </label>
          {withGoal && (
            <div className="stack" style={{ borderTop: '1px solid var(--line2)', padding: '12px 14px' }}>
              <div className="row">
                <div className="field" style={{ flex: 2 }}><label className="small muted" htmlFor="gt">目标</label><input id="gt" className="input" required value={goalTitle} onChange={(e) => setGoalTitle(e.target.value)} /></div>
                <div className="field" style={{ flex: 1 }}><label className="small muted" htmlFor="gd">截止日期</label><input id="gd" className="input" type="date" value={goalDue} onChange={(e) => setGoalDue(e.target.value)} /></div>
              </div>
              <div className="field"><label className="small muted" htmlFor="gm">成功标准（逗号分隔）</label><input id="gm" className="input" value={metrics} onChange={(e) => setMetrics(e.target.value)} /></div>
            </div>
          )}
        </div>
        {error && <p className="error">{error}</p>}
        <div className="row"><button className="btn primary lg" disabled={busy || !name.trim()}>创建空间</button><button type="button" className="btn lg" onClick={() => navigate(-1)}>取消</button></div>
      </form>
    </div>
  )
}
