// scanner/sources/robinhood.ts — 公開唯讀 endpoint，不帶帳號資訊（SPEC §10.3）。格式見 DECISIONS 11.2 / 11.3
import { z } from 'zod'
import { fetchJson, HttpError } from './http.js'
import type { ApiUsage } from './usage.js'
import { CHAIN } from '../../config/chain.js'
const BASE = 'https://api.robinhood.com/rhj'
export interface RhCtx { usage: ApiUsage; fetchImpl?: typeof fetch; retries?: number; baseDelayMs?: number }
const Cap = z.object({ whole: z.string(), fractional: z.string() })
const AssetSchema = z.object({
  id: z.string(), tokenSymbol: z.string(), tokenName: z.string(),
  deployments: z.array(z.object({ contractAddress: z.string(), chainId: z.number() })),
  currentMultiplier: z.string(), pendingMultiplier: z.string(), status: z.string(),
  tradingCapabilities: z.object({ market: Cap, extended: Cap, overnight: Cap }).partial(),
  tokenDecimals: z.number(),
}).passthrough()
export interface RhAsset { id: string; tokenSymbol: string; tokenName: string; address: string; currentMultiplier: string; pendingMultiplier: string; status: string; allDayTradable: boolean; tokenDecimals: number; raw: unknown }
/** 把 /assets 的一筆 raw 解析成 RhAsset；不在本鏈的回 null。tokens.raw 快取也用它還原（D63） */
export function parseAsset(raw: unknown): RhAsset | null {
  const a = AssetSchema.parse(raw)
  const dep = a.deployments.find(d => d.chainId === CHAIN.id); if (!dep) return null
  return { id: a.id, tokenSymbol: a.tokenSymbol, tokenName: a.tokenName, address: dep.contractAddress.toLowerCase(),
    currentMultiplier: a.currentMultiplier, pendingMultiplier: a.pendingMultiplier, status: a.status,
    allDayTradable: a.tradingCapabilities.overnight?.whole === 'TRADING_STATUS_TRADABLE',   // DECISIONS 11.2
    tokenDecimals: a.tokenDecimals, raw }
}
export async function fetchAssets(ctx: RhCtx): Promise<RhAsset[]> {
  const body = await fetchJson<{ assets: unknown[] }>(`${BASE}/assets`, { source: 'robinhood', usage: ctx.usage, fetchImpl: ctx.fetchImpl, retries: ctx.retries, baseDelayMs: ctx.baseDelayMs })
  return body.assets.map(parseAsset).filter((x): x is RhAsset => x !== null)
}
export interface RhQuote { symbol: string; bid: number; ask: number; mid: number; spreadPct: number; isTradingHalt: boolean; generatedAt: string }
export async function fetchPrice(ctx: RhCtx, symbol: string): Promise<RhQuote | null> {
  try {
    const body = await fetchJson<{ quotes: any[] }>(`${BASE}/prices/${encodeURIComponent(symbol)}`, { source: 'robinhood', usage: ctx.usage, fetchImpl: ctx.fetchImpl })
    const q = body.quotes?.[0]; if (!q) return null
    const bid = Number(q.bid), ask = Number(q.ask)
    const mid = (bid + ask) / 2
    return { symbol: q.tokenSymbol, bid, ask, mid, spreadPct: mid > 0 ? (ask - bid) / mid : 0, isTradingHalt: Boolean(q.isTradingHalt), generatedAt: String(q.generatedAt ?? '') }
  } catch (e) { if (e instanceof HttpError && e.status === 404) return null; throw e }
}
export interface RhCorpAction { id: string; tokenSymbol: string; address: string; type: string; status: string; effectiveAt: string; raw: unknown }
export async function fetchCorporateActions(ctx: RhCtx): Promise<RhCorpAction[]> {
  const body = await fetchJson<{ corpActions: any[] }>(`${BASE}/corporate-actions`, { source: 'robinhood', usage: ctx.usage, fetchImpl: ctx.fetchImpl, retries: ctx.retries, baseDelayMs: ctx.baseDelayMs })
  return (body.corpActions ?? []).map(c => {
    const d = c.processDate ?? {}; const pad = (n: number) => String(n).padStart(2, '0')
    const dep = (c.deployments ?? []).find((x: any) => x.chainId === CHAIN.id)
    return { id: String(c.id), tokenSymbol: String(c.tokenSymbol), address: String(dep?.contractAddress ?? '').toLowerCase(), type: String(c.type), status: String(c.status),
      effectiveAt: d.year ? `${d.year}-${pad(d.month)}-${pad(d.day)}` : '', raw: c }
  })
}
