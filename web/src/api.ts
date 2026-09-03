export type SimResult = { fees_usd: number; value_end_usd: number; il_usd: number; net_usd: number; net_pct: number; net_apr: number; in_range_hours: number; in_range_pct: number; exits: number; hours: number }
export type SimJson = { meta: { hours: number; sigma7: number | null; rvol_R: number }; d200: any; d1000: any; d5000: any }
export type Row = {
  pool_id: string; symbol: string; protocol: string; fee_ppm: number | null; hooks: string; age_days: number | null
  tvl_usd: number | null; volume_24h_usd: number; fees_24h_usd: number; vol7_avg_usd: number; vol7_cv: number
  trader_count: number | null; top1_share: number | null; price_usd: number | null; price_ref_usd: number | null; price_dev_pct: number | null
  raw_apr: number | null; score: number | null; excluded: number; flags: string[]; sim: SimJson | null; all_day_tradable: string | null
  rank_today: number | null; rank_prev: number | null
}
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { headers: { 'content-type': 'application/json' }, ...init })
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`)
  return r.json()
}
export const ZERO = '0x0000000000000000000000000000000000000000'
export const fmtUsd = (v: number | null | undefined, d = 0) => v === null || v === undefined ? '—' : '$' + v.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d })
export const fmtPct = (v: number | null | undefined, d = 0) => v === null || v === undefined ? '—' : (v * 100).toFixed(d) + '%'
export const fmtNum = (v: number | null | undefined, d = 2) => v === null || v === undefined ? '—' : v.toFixed(d)
export const simOf = (r: Row, D: string, R: string): SimResult | null => r.sim?.[D as 'd1000']?.[R] ?? null
