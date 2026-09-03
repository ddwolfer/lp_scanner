// scanner/sources/dexscreener.ts — 免 key，60 req/min。只做 TVL 交叉驗證與池子補漏（DECISIONS D9）
import { fetchJson } from './http.js'
import type { ApiUsage } from './usage.js'
export interface DsCtx { usage: ApiUsage; fetchImpl?: typeof fetch; minIntervalMs?: number }
export interface DsPair { pairId: string; dexId: string; labels: string[]; baseToken: { address: string; symbol: string }; quoteToken: { address: string; symbol: string }; liquidityUsd: number | null; volume24hUsd: number | null; priceUsd: number | null }
let lastCall = 0
const num = (v: unknown) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v))) ? null : Number(v)
export async function fetchTokenPairs(ctx: DsCtx, token: string): Promise<DsPair[]> {
  const gap = ctx.minIntervalMs ?? 1100; const wait = lastCall + gap - Date.now()
  if (wait > 0) await new Promise(r => setTimeout(r, wait)); lastCall = Date.now()
  const rows = await fetchJson<any[]>(`https://api.dexscreener.com/token-pairs/v1/robinhood/${token.toLowerCase()}`, { source: 'dexscreener', usage: ctx.usage, fetchImpl: ctx.fetchImpl })
  return (rows ?? []).map(r => ({ pairId: String(r.pairAddress).toLowerCase(), dexId: String(r.dexId), labels: r.labels ?? [],
    baseToken: { address: String(r.baseToken?.address).toLowerCase(), symbol: String(r.baseToken?.symbol) },
    quoteToken: { address: String(r.quoteToken?.address).toLowerCase(), symbol: String(r.quoteToken?.symbol) },
    liquidityUsd: num(r.liquidity?.usd), volume24hUsd: num(r.volume?.h24), priceUsd: num(r.priceUsd) }))
}
