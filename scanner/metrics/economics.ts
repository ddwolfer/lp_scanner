// scanner/metrics/economics.ts — 成交持續性、生命週期成本、容量（DECISIONS D37），純函式
import { liquidityForDeposit, L_HUMAN_TO_RAW } from './lp-math.js'

/** 最近 N 小時成交速率 ÷ 全天平均速率。>1 = 還在熱，<1 = 冷卻中。全天無量回 null */
export function volumePersistence(hourlyVolumes: number[], recentHours: number): number | null {
  const day = hourlyVolumes.slice(-24); if (!day.length) return null
  const avg = day.reduce((a, b) => a + b, 0) / day.length; if (avg <= 0) return null
  const rec = day.slice(-recentHours); const recAvg = rec.reduce((a, b) => a + b, 0) / rec.length
  return recAvg / avg
}
export interface LifecycleCost { swapInUsd: number; swapOutUsd: number; gasUsd: number; totalUsd: number; breakevenDays: number | null }
/** 完整進出成本：進場換一半（D/2 × 費率）、出場換回一半、四筆交易 gas（swap、mint、burn/collect、swap）。回本天數 = 成本 ÷ 每日手續費估 */
export function lifecycleCost(depositUsd: number, feePpm: number | null, dailyFeeUsd: number | null, gasUsdPerTx = 0.6, txs = 4): LifecycleCost {
  const fee = (feePpm ?? 0) / 1e6
  const swapInUsd = depositUsd / 2 * fee, swapOutUsd = depositUsd / 2 * fee, gasUsd = gasUsdPerTx * txs
  const totalUsd = swapInUsd + swapOutUsd + gasUsd
  return { swapInUsd, swapOutUsd, gasUsd, totalUsd, breakevenDays: dailyFeeUsd && dailyFeeUsd > 0 ? totalUsd / dailyFeeUsd : null }
}
/** 在此區間投入多少美元時，自己會佔到 active liquidity 的 targetShare（預設 10%）。超過就是在稀釋自己 */
export function capacityUsd(poolLiquidityRaw: bigint | string, price: number, R: number, targetShare = 0.10): number | null {
  const Lpool = Number(poolLiquidityRaw); if (!(Lpool > 0) || !(price > 0)) return null
  const lPerDollar = liquidityForDeposit(1, price, price * (1 - R), price * (1 + R)) * L_HUMAN_TO_RAW
  return (targetShare / (1 - targetShare)) * Lpool / lPerDollar
}
