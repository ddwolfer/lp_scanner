// scanner/metrics/score.ts — SPEC §8.3，權重與 sort_key 來自 config/scoring.json
import type { Scoring } from '../../config/chain.js'
import type { SimJson, SimResult } from './simulate.js'
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
export function getSimField(sim: SimJson | null, sortKey: string, field: keyof SimResult): number | null {
  if (!sim) return null
  const [d, r] = sortKey.split('.') as [keyof SimJson, string]
  const set = sim[d] as any; const res: SimResult | undefined = set?.[r]
  return res ? res[field] : null
}
export interface ScoreInput { poolId: string; sim: SimJson | null; vol7Cv: number; traderCount: number | null; priceDevPct: number | null; allDayTradable: boolean }
/** rank_norm = 在未排除池中的百分位 rank/(n−1)（D20）；無參考價視為最差偏離（D21） */
export function scorePools(rows: ScoreInput[], s: Scoring): Map<string, number> {
  const withSim = rows.filter(r => getSimField(r.sim, s.sort_key, 'net_apr') !== null)
  const sorted = [...withSim].sort((a, b) => getSimField(a.sim, s.sort_key, 'net_apr')! - getSimField(b.sim, s.sort_key, 'net_apr')!)
  const n = sorted.length; const rank = new Map(sorted.map((r, i) => [r.poolId, n > 1 ? i / (n - 1) : 1]))
  const w = s.weights; const out = new Map<string, number>()
  for (const r of withSim) {
    const inRange = getSimField(r.sim, s.sort_key, 'in_range_pct') ?? 0
    const dev = r.priceDevPct === null ? 0.05 : Math.abs(r.priceDevPct)
    out.set(r.poolId,
      w.net_apr * rank.get(r.poolId)! +
      w.in_range_pct * inRange +
      w.vol7_cv * (1 - clamp(r.vol7Cv, 0, 2) / 2) +
      w.trader_count * clamp((r.traderCount ?? 0) / 50, 0, 1) +
      w.price_dev * (1 - clamp(dev, 0, 0.05) / 0.05) +
      w.all_day_tradable * (r.allDayTradable ? 1 : 0))
  }
  return out
}
