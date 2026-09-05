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
export const isTooManyLogs = (e: unknown) => /exceeds limit|Missing or invalid parameters|query returned more than|response size/i.test(String((e as Error)?.message ?? e))
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
  const lim = new Limiter(o.concurrency ?? 2)
  const minGapMs = o.minGapMs ?? 250; let lastStart = 0
  async function call<T>(fn: () => Promise<T>): Promise<T> {
    return lim.run(async () => {
      for (let attempt = 0; ; attempt++) {
        const wait = lastStart + minGapMs - Date.now(); if (wait > 0) await sleep(wait); lastStart = Date.now()
        o.usage.inc(source)
        try { return await fn() }
        catch (e) {
          const msg = String((e as Error).message ?? e)
          // public RPC 對 getLogs 有突發限流（DECISIONS 11.5）；最多 8 次退避，上限 30 秒
          if (attempt < 8 && /429|Too Many|compute units|exceeded|timeout|timed out|ECONNRESET|fetch failed|503|502/i.test(msg)) { await sleep(Math.min(30_000, 1000 * 2 ** attempt) + Math.random() * 500); continue }
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
