import { useCallback, useEffect, useRef, useState } from 'react'

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError((json as { error?: string }).error ?? `请求失败（${res.status}）`, res.status)
  return json as T
}

// One EventSource per stream URL, shared by every component that listens to it.
const sources = new Map<string, { es: EventSource; listeners: Set<() => void> }>()

function listen(url: string, fn: () => void): () => void {
  let entry = sources.get(url)
  if (!entry) {
    const es = new EventSource(url, { withCredentials: true })
    const listeners = new Set<() => void>()
    let timer: number | undefined
    es.onmessage = () => {
      // Coalesce bursts of updates into one refresh.
      window.clearTimeout(timer)
      timer = window.setTimeout(() => listeners.forEach((l) => l()), 150)
    }
    entry = { es, listeners }
    sources.set(url, entry)
  }
  entry.listeners.add(fn)
  return () => {
    entry!.listeners.delete(fn)
    if (entry!.listeners.size === 0) {
      entry!.es.close()
      sources.delete(url)
    }
  }
}

export function spaceStream(spaceId: string): string {
  return `/api/spaces/${spaceId}/stream`
}
export const USER_STREAM = '/api/me/stream'

/** Fetch JSON and refetch whenever one of the given live streams reports a change. */
export function useApi<T = any>(path: string | null, streams: string[] = []): { data: T | null; error: string | null; reload: () => void; loading: boolean } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const seq = useRef(0)
  const load = useCallback(() => {
    if (!path) return
    const mine = ++seq.current
    setLoading(true)
    api<T>('GET', path)
      .then((d) => { if (mine === seq.current) { setData(d); setError(null) } })
      .catch((e: Error) => { if (mine === seq.current) setError(e.message) })
      .finally(() => { if (mine === seq.current) setLoading(false) })
  }, [path])
  useEffect(() => {
    setData(null)
    load()
  }, [load])
  const key = streams.join('|')
  useEffect(() => {
    if (!path) return
    const offs = streams.map((s) => listen(s, load))
    return () => offs.forEach((off) => off())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, load])
  return { data, error, reload: load, loading }
}
