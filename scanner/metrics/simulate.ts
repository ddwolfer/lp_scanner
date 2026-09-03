// scanner/metrics/simulate.ts — SPEC §7 模擬淨收益，純函式
// 份額：L_raw = L × 1e12，share = L_raw / (L_pool + L_raw)，L_pool 來自 v4 Swap 事件（DECISIONS D1 / D18）
// IL：相對「初始持有量 (x0, y0) 不動」的差額（DECISIONS D19）
import { liquidityForDeposit, positionAmounts, positionValue, L_HUMAN_TO_RAW } from './lp-math.js'
import { rvolRange } from './volatility.js'
export interface SimHour { ts: number; priceUsd: number; feesUsd: number; liquidity: string | null }
export interface SimResult { fees_usd: number; value_end_usd: number; il_usd: number; net_usd: number; net_pct: number; net_apr: number; in_range_hours: number; in_range_pct: number; exits: number; hours: number }
export interface SimHourRow { row: SimHour; inRange: boolean; share: number; feeH: number; valueH: number; cumFees: number }
export const DEPOSITS = [200, 1000, 5000] as const
export type RangeSet = { r10: SimResult; r25: SimResult; rvol: SimResult }
export type SimJson = { meta: { share_method: 'liquidity'; hours: number; sigma7: number | null; rvol_R: number }; d200: RangeSet; d1000: RangeSet; d5000: RangeSet }

export function simulateHourly(hours: SimHour[], D: number, R: number): SimHourRow[] {
  if (!hours.length) return []
  const P0 = hours[0].priceUsd, Pl = P0 * (1 - R), Pu = P0 * (1 + R)
  const L = liquidityForDeposit(D, P0, Pl, Pu); const Lraw = L * L_HUMAN_TO_RAW
  let cum = 0
  return hours.map(row => {
    const inRange = row.priceUsd >= Pl && row.priceUsd <= Pu
    const Lpool = row.liquidity === null ? null : Number(row.liquidity)
    const share = inRange && Lpool !== null ? Lraw / (Lpool + Lraw) : 0
    const feeH = share * row.feesUsd; cum += feeH
    return { row, inRange, share, feeH, valueH: positionValue(L, row.priceUsd, Pl, Pu), cumFees: cum }
  })
}
const zero = (): SimResult => ({ fees_usd: 0, value_end_usd: 0, il_usd: 0, net_usd: 0, net_pct: 0, net_apr: 0, in_range_hours: 0, in_range_pct: 0, exits: 0, hours: 0 })
export function simulate(hours: SimHour[], D: number, R: number): SimResult {
  const rows = simulateHourly(hours, D, R); if (!rows.length) return zero()
  const P0 = hours[0].priceUsd, Pl = P0 * (1 - R), Pu = P0 * (1 + R)
  const L = liquidityForDeposit(D, P0, Pl, Pu); const { x: x0, y: y0 } = positionAmounts(L, P0, Pl, Pu)
  const last = rows[rows.length - 1]; const Pend = last.row.priceUsd
  let exits = 0; for (let i = 1; i < rows.length; i++) if (rows[i - 1].inRange && !rows[i].inRange) exits++
  const inRangeHours = rows.filter(r => r.inRange).length
  const fees = last.cumFees, valueEnd = last.valueH
  const net = fees + valueEnd - D, netPct = net / D
  return { fees_usd: fees, value_end_usd: valueEnd, il_usd: valueEnd - (x0 * Pend + y0), net_usd: net, net_pct: netPct,
    net_apr: netPct * 365 / (rows.length / 24), in_range_hours: inRangeHours, in_range_pct: inRangeHours / rows.length, exits, hours: rows.length }
}
export function simulateAll(hours: SimHour[], sigma: number | null): { sim: SimJson; flags: string[] } {
  const { R: rvolR, fallback } = rvolRange(sigma)
  const set = (D: number): RangeSet => ({ r10: simulate(hours, D, 0.10), r25: simulate(hours, D, 0.25), rvol: simulate(hours, D, rvolR) })
  return { sim: { meta: { share_method: 'liquidity', hours: hours.length, sigma7: sigma, rvol_R: rvolR }, d200: set(200), d1000: set(1000), d5000: set(5000) }, flags: fallback ? ['rvol_fallback'] : [] }
}
