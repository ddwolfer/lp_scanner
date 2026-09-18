// scanner/metrics/economics.ts — 成交持續性、生命週期成本、容量（DECISIONS D37），純函式
import { liquidityForDeposit, positionAmounts, positionValue, L_HUMAN_TO_RAW } from './lp-math.js'

/** 最近 N 小時成交速率 ÷ 全天平均速率。>1 = 還在熱，<1 = 冷卻中。全天無量回 null */
export function volumePersistence(hourlyVolumes: number[], recentHours: number): number | null {
  const day = hourlyVolumes.slice(-24); if (!day.length) return null
  const avg = day.reduce((a, b) => a + b, 0) / day.length; if (avg <= 0) return null
  const rec = day.slice(-recentHours); const recAvg = rec.reduce((a, b) => a + b, 0) / rec.length
  return recAvg / avg
}
export interface LifecycleCost { swapInUsd: number; swapOutUsd: number; gasUsd: number; totalUsd: number; breakevenDays: number | null }
/** 完整進出成本：進場換一半（D/2 × 費率）、出場換回一半、四筆交易 gas（swap、mint、burn/collect、swap）。回本天數 = 成本 ÷ 每日手續費估 */
/** 粗估的整趟成本（總覽用，不知道區間與方向時的近似：進出各換一半）。有區間時請用 exitBreakeven。gas 由呼叫端傳（config economics.gas_usd_per_tx），不在此設預設（D61） */
export function lifecycleCost(depositUsd: number, feePpm: number | null, dailyFeeUsd: number | null, gasUsdPerTx: number, txs: number): LifecycleCost {
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

// ---- D61：出區間「要補多少、要收多久」。借自 blockbloomer 的保本計算器，換成集中流動性的精確持倉量。
export interface BreakevenSide { bound: number; valueAtBound: number; paperLoss: number; entrySwapUsd: number; exitSwapUsd: number; gasUsd: number; feesEarnedUsd: number; toCoverUsd: number; days: number | null; covered: boolean }
export interface BreakevenInput {
  D: number; P0: number; Pl: number; Pu: number
  L?: number                    // 真實流動性（人類單位）；不給就以 D 在 P0 開倉反推
  dailyFeeUsd: number | null    // 費速；null 或 0 → days 為 null
  swapFeeRate: number           // 每次換幣的比例成本（交易者總費 + 滑價）
  gasPerTx: number; txs: number
  live?: { feesEarnedUsd: number; costsIncurredUsd?: number }   // 持倉中：進場成本已發生、已賺的費要扣掉
}
function side(i: BreakevenInput, L: number, bound: number): BreakevenSide {
  const valueAtBound = positionValue(L, bound, i.Pl, i.Pu)
  const coinAtBound = positionAmounts(L, bound, i.Pl, i.Pu).x            // 上緣時 x=0 → 不必換幣（Codex review）
  const exitSwapUsd = coinAtBound * bound * i.swapFeeRate
  const entrySwapUsd = i.live ? (i.live.costsIncurredUsd ?? 0) : positionAmounts(L, i.P0, i.Pl, i.Pu).x * i.P0 * i.swapFeeRate   // 進場只對「買進的幣側」收（Codex review）
  const gasUsd = i.gasPerTx * i.txs
  const feesEarnedUsd = i.live?.feesEarnedUsd ?? 0
  const paperLoss = i.D - valueAtBound
  const toCoverUsd = Math.max(0, paperLoss + entrySwapUsd + exitSwapUsd + gasUsd - feesEarnedUsd)
  return { bound, valueAtBound, paperLoss, entrySwapUsd, exitSwapUsd, gasUsd, feesEarnedUsd, toCoverUsd, days: toCoverUsd === 0 ? 0 : (i.dailyFeeUsd && i.dailyFeeUsd > 0 ? toCoverUsd / i.dailyFeeUsd : null), covered: toCoverUsd === 0 }
}
export function exitBreakeven(i: BreakevenInput): { lower: BreakevenSide; upper: BreakevenSide; L: number } {
  const L = i.L ?? liquidityForDeposit(i.D, i.P0, i.Pl, i.Pu)
  return { lower: side(i, L, i.Pl), upper: side(i, L, i.Pu), L }
}
