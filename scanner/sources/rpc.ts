// scanner/sources/rpc.ts — 唯讀 RPC 包裝：併發限制、退避、計數。無 wallet、無簽名（SPEC §10.1）
import { createPublicClient, http, type PublicClient, type Log, type AbiEvent } from 'viem'
import { CHAIN } from '../../config/chain.js'
import type { ApiUsage } from './usage.js'

export function chunkRanges(from: bigint, to: bigint, chunk: bigint): [bigint, bigint][] {
  const out: [bigint, bigint][] = []
  for (let a = from; a <= to; a += chunk) out.push([a, a + chunk - 1n > to ? to : a + chunk - 1n])
  return out
}
export class Limiter {
  private q: (() => void)[] = []; private active = 0
  constructor(private n: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.n) await new Promise<void>(r => this.q.push(r))
    this.active++
    try { return await fn() } finally { this.active--; this.q.shift()?.() }
  }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
/** 沿著 cause 走訪錯誤鏈（viem 會把 HttpRequestError 包在 ContractFunctionExecutionError 底下）（D59，Codex review） */
const chain = (e: unknown, max = 6): any[] => { const out: any[] = []; let cur: any = e
  while (cur && typeof cur === 'object' && out.length < max) { out.push(cur); cur = cur.cause }
  return out }
/** viem 錯誤的可比對字串：message 之外還有 details / shortMessage / status，整條 cause 鏈都要看（D57、D59） */
export const errText = (e: unknown) => {
  if (!e || typeof e !== 'object') return String(e)
  const s = chain(e).flatMap(x => [x.message, x.details, x.shortMessage, x.status]).filter(Boolean).join(' | ')
  return s || String(e)
}
/** 可重試：HTTP 429 與任何 5xx（含 Cloudflare 專用的 520–524）、連線層錯誤、逾時。
 *  狀態碼優先，整條 cause 鏈上第一個有狀態碼的為準；沒有狀態碼才看錯誤名稱與字串，
 *  且不用鬆散的數字比對（errText 含請求內文，會誤中區塊號）（D59，Codex review） */
export const isRetryable = (e: unknown, text = errText(e)) => {
  for (const x of chain(e)) {
    const raw = x?.status; const st = raw === undefined || raw === null ? null : Number(raw)
    if (st !== null && Number.isFinite(st)) return st === 429 || (st >= 500 && st < 600)   // 4xx（429 除外）是永久錯誤
  }
  if (chain(e).some(x => /^(HttpRequestError|TimeoutError|SocketClosedError)$/.test(String(x?.name ?? '')))) return true
  return /429|Too Many Requests|compute units|exceeded|timed? ?out|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|fetch failed|socket hang up|other side closed|terminated|network socket disconnected|Bad Gateway|Service Unavailable|Gateway Time-?out|Internal Server Error/i.test(text)
}
export const isTooManyLogs = (e: unknown) => /exceeds limit|Missing or invalid parameters|query returned more than|response size/i.test(errText(e))
export interface Rpc {
  client: PublicClient
  call<T>(fn: () => Promise<T>): Promise<T>
  getBlockNumber(): Promise<bigint>
  getLogsChunked(p: { address: `0x${string}`; event: AbiEvent; args?: Record<string, unknown> }, from: bigint, to: bigint, chunk?: bigint): Promise<Log[]>
}
export function makeRpc(o: { usage: ApiUsage; url?: string; concurrency?: number; minGapMs?: number; source?: string }): Rpc {
  const url = o.url ?? CHAIN.publicRpc
  const source = o.source ?? 'rpc'
  const client = createPublicClient({
    chain: { id: CHAIN.id, name: CHAIN.name, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [url] } } },
    transport: http(url, { timeout: 60_000, retryCount: 0 }),
  })
  // D47：公用 RPC 對 getLogs 的限流變嚴時，可用環境變數降速（RPC_CONCURRENCY、RPC_GAP_MS）
  const lim = new Limiter(o.concurrency ?? Number(process.env.RPC_CONCURRENCY || 2))
  const minGapMs = o.minGapMs ?? Number(process.env.RPC_GAP_MS || 250); let lastStart = 0
  async function call<T>(fn: () => Promise<T>): Promise<T> {
    return lim.run(async () => {
      for (let attempt = 0; ; attempt++) {
        const wait = lastStart + minGapMs - Date.now(); if (wait > 0) await sleep(wait); lastStart = Date.now()
        o.usage.inc(source)
        try { return await fn() }
        catch (e) {
          // viem 把 HTTP 狀態放在 details / cause，不在 message（9/11：message 只有「RPC Request failed.」，429 沒被重試，961 池抓不到 swap）
          const msg = errText(e)
          if (process.env.RPC_DEBUG) console.error(`[rpc] attempt ${attempt} err: ${msg.split('\n')[0].slice(0, 120)}`)
          if (isTooManyLogs(msg)) throw e   // D47：>10k logs 不是限流，立刻交給 getLogsChunked 對半切，不進退避
          // public RPC 對 getLogs 有突發限流與 Cloudflare 錯誤頁（D59）；最多 12 次退避，上限 60 秒（合計約 8 分鐘）
          if (attempt < 12 && isRetryable(e, msg)) { await sleep(Math.min(60_000, 1000 * 2 ** attempt) + Math.random() * 500); continue }
          throw e
        }
      }
    })
  }
  return {
    client, call,
    getBlockNumber: () => call(() => client.getBlockNumber()),
    async getLogsChunked(p, from, to, chunk = BigInt(CHAIN.getLogsChunk)) {
      // 單段超過 10k logs 時 public RPC 回 "exceeds limit" 或 "Missing or invalid parameters"（DECISIONS D17）→ 對半切
      const one = async (a: bigint, b: bigint): Promise<Log[]> => {
        try { return await call(() => client.getLogs({ ...(p as any), fromBlock: a, toBlock: b })) }
        catch (e) {
          if (b > a && isTooManyLogs(e)) { const mid = a + (b - a) / 2n; return [...await one(a, mid), ...await one(mid + 1n, b)] }
          throw e
        }
      }
      const parts = await Promise.all(chunkRanges(from, to, chunk).map(([a, b]) => one(a, b)))
      return parts.flat()
    },
  }
}
