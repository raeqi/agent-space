import { StrictMode, useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import './styles.css'
import { api, ApiError } from './api.ts'
import { ComposeProvider, MeProvider, type Me } from './ui.tsx'
import { Login } from './pages/Login.tsx'
import { Inbox, WorkLog, MyAgent, PersonalLayout } from './pages/Home.tsx'
import { NewSpace } from './pages/NewSpace.tsx'
import { SpaceLayout, Overview, Members } from './pages/Space.tsx'
import { Tasks } from './pages/Tasks.tsx'
import { Discussions } from './pages/Discussions.tsx'
import { Artifacts, Skills, Standards, Memory, Files } from './pages/Assets.tsx'

function Root() {
  const [me, setMe] = useState<Me | null | undefined>(undefined)
  const refresh = useCallback(() => {
    api<{ loggedIn: boolean }>('GET', '/api/session')
      .then((s) => (s.loggedIn ? api<Me>('GET', '/api/me').then(setMe) : setMe(null)))
      .catch((e) => { if (e instanceof ApiError) setMe(null) })
  }, [])
  useEffect(refresh, [refresh])
  if (me === undefined) return null
  if (me === null) return <Login onDone={refresh} />
  return (
    <MeProvider me={me} refresh={refresh}>
      <ComposeProvider>
        <Routes>
          <Route element={<PersonalLayout />}>
            <Route index element={<Inbox />} />
            <Route path="log" element={<WorkLog />} />
            <Route path="agent" element={<MyAgent />} />
            <Route path="new" element={<NewSpace />} />
          </Route>
          <Route path="spaces/:spaceId" element={<SpaceLayout />}>
            <Route index element={<Overview />} />
            <Route path="tasks" element={<Tasks />} />
            <Route path="tasks/:taskId" element={<Tasks />} />
            <Route path="flow" element={<Tasks flow />} />
            <Route path="discussions" element={<Discussions />} />
            <Route path="discussions/:discussionId" element={<Discussions />} />
            <Route path="assets" element={<Artifacts />} />
            <Route path="assets/artifacts" element={<Artifacts />} />
            <Route path="assets/artifacts/:artifactTaskId" element={<Artifacts />} />
            <Route path="assets/skills" element={<Skills />} />
            <Route path="assets/standards" element={<Standards />} />
            <Route path="assets/memory" element={<Memory />} />
            <Route path="assets/files" element={<Files />} />
            <Route path="members" element={<Members />} />
          </Route>
        </Routes>
      </ComposeProvider>
    </MeProvider>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Root />
    </BrowserRouter>
  </StrictMode>,
)
