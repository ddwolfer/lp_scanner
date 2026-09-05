export type SimResult = { fees_usd: number; value_end_usd: number; il_usd: number; net_usd: number; net_pct: number; net_apr: number; in_range_hours: number; in_range_pct: number; exits: number; hours: number; fees_trimmed_usd?: number; net_trimmed_usd?: number; net_apr_trimmed?: number; top_hour_share?: number; trimmed_hours?: number }
export type SimJson = { meta: { hours: number; sigma7: number | null; rvol_R: number }; d200: any; d1000: any; d5000: any }
export type Row = {
  pool_id: string; symbol: string; protocol: string; fee_ppm: number | null; fee_ppm_observed: number | null; hooks: string; hook_kind: 'none' | 'fee_only' | 'liquidity' | null; hook_flags: string[]; age_days: number | null
  tvl_usd: number | null; volume_24h_usd: number; fees_24h_usd: number; vol7_avg_usd: number; vol7_cv: number
  trader_count: number | null; top1_share: number | null; price_usd: number | null; price_ref_usd: number | null; price_dev_pct: number | null
  raw_apr: number | null; score: number | null; excluded: number; flags: string[]; sim: SimJson | null; all_day_tradable: string | null
  vol_6h_usd: number | null; heat_6h: number | null
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

export const HOOK_ZH: Record<string, string> = { beforeInitialize: '初始化前', afterInitialize: '初始化後', beforeAddLiquidity: '加流動性前', afterAddLiquidity: '加流動性後', beforeRemoveLiquidity: '移除流動性前', afterRemoveLiquidity: '移除流動性後', beforeSwap: '交易前', afterSwap: '交易後', beforeDonate: '捐款前', afterDonate: '捐款後', beforeSwapReturnsDelta: '交易前改帳', afterSwapReturnsDelta: '交易後改帳', afterAddLiquidityReturnsDelta: '加流動性改帳', afterRemoveLiquidityReturnsDelta: '移除流動性改帳' }
export const HOOK_GROUPS: { zh: string; keys: string[]; note: string }[] = [
  { zh: '交易類（只能改費率或拒絕交易）', keys: ['beforeInitialize', 'afterInitialize', 'beforeSwap', 'afterSwap'], note: '碰不到本金' },
  { zh: '流動性類（可擋你進出）', keys: ['beforeAddLiquidity', 'afterAddLiquidity', 'beforeRemoveLiquidity', 'afterRemoveLiquidity', 'beforeDonate', 'afterDonate'], note: '有任一項即排除' },
  { zh: '改帳類（可拿走金額）', keys: ['beforeSwapReturnsDelta', 'afterSwapReturnsDelta', 'afterAddLiquidityReturnsDelta', 'afterRemoveLiquidityReturnsDelta'], note: '有任一項即排除' },
]
export const feeLabel = (fee_ppm: number | null, observed: number | null) => fee_ppm !== null ? (fee_ppm / 1e4).toFixed(2) + '%' : observed !== null ? '~' + (observed / 1e4).toFixed(2) + '%' : '動態'
