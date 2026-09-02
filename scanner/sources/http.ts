// scanner/sources/http.ts — 所有 REST 呼叫共用：超時、重試、計數（SPEC §5 規則）
import type { ApiUsage } from './usage.js'
export interface FetchOpts {
  source: string; usage: ApiUsage; timeoutMs?: number; retries?: number; baseDelayMs?: number
  headers?: Record<string, string>; fetchImpl?: typeof fetch
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
export class HttpError extends Error { constructor(public status: number, url: string) { super(`HTTP ${status} ${url}`) } }
export async function fetchJson<T>(url: string, o: FetchOpts): Promise<T> {
  const { timeoutMs = 15_000, retries = 3, baseDelayMs = 500, fetchImpl = fetch } = o
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    o.usage.inc(o.source)
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      const r = await fetchImpl(url, { headers: o.headers, signal: ctl.signal })
      if (r.ok) return (await r.json()) as T
      if (r.status !== 429 && r.status < 500) throw new HttpError(r.status, url)   // 4xx 不重試
      lastErr = new HttpError(r.status, url)
    } catch (e) {
      if (e instanceof HttpError && e.status !== 429 && e.status < 500) throw e
      lastErr = e
    } finally { clearTimeout(t) }
    if (attempt < retries) await sleep(baseDelayMs * 2 ** attempt)
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}
