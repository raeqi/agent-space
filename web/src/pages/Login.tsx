import { useState } from 'react'
import { api, useApi } from '../api.ts'

export function Login({ onDone }: { onDone: () => void }) {
  const { data: cfg } = useApi<{ accessCodeRequired: boolean }>('/api/config')
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api('POST', '/api/login', { email, name, accessCode: code })
      onDone()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <form className="card" style={{ width: 380, padding: 28, display: 'flex', flexDirection: 'column', gap: 16 }} onSubmit={submit}>
        <div className="row"><span className="logo">空</span><b style={{ fontWeight: 600 }}>Agent 空间</b></div>
        <div className="stack" style={{ gap: 4 }}><h2>登录</h2><p className="sm muted">第一次登录会自动创建账号和你的个人 agent。</p></div>
        <div className="field"><label className="label" htmlFor="email">工作邮箱</label><input id="email" className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></div>
        <div className="field"><label className="label" htmlFor="name">名字</label><input id="name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="同事看到的名字" /></div>
        {cfg?.accessCodeRequired && <div className="field"><label className="label" htmlFor="code">访问码</label><input id="code" className="input" value={code} onChange={(e) => setCode(e.target.value)} /></div>}
        {error && <p className="error">{error}</p>}
        <button className="btn primary lg" disabled={busy}>登录</button>
      </form>
    </div>
  )
}
