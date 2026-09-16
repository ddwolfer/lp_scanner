// scanner/metrics/hourly.ts — 純函式：Swap log → 每小時列
// 手續費 = 輸入側金額 × LP 實得費率（扣掉協議費，D60；原為 USDG 側 × 交易者總費，D11）
import { hourBucket } from '../time.js'
import { lpFeePpm, type ProtocolFee } from './protocolFee.js'
import { stockPriceUsd } from './price.js'
import { USDG_DECIMALS } from '../../config/chain.js'
import type { SwapLog } from '../sources/uniswapV4.js'
export interface HourlyRow { ts: number; priceUsd: number | null; volumeUsd: number; feesUsd: number; liquidity: string | null; swapCount: number; protocolFeeUnknown?: boolean }
export interface HourlyOpts { protocolFee?: ProtocolFee | null; staticFeePpm?: number | null; inputIsNegative?: boolean }
/** inputIsNegative：v4 事件是使用者視角（付出為負），v3 是池視角（池收到為正）→ v3 傳 false（D60） */
export function aggregateHourly(swaps: SwapLog[], blockTs: (b: bigint) => number, stockIsToken0: boolean, fromTs: number, toTs: number, opts: HourlyOpts = {}): HourlyRow[] {
  const { protocolFee = null, staticFeePpm = null, inputIsNegative = true } = opts
  const buckets = new Map<number, HourlyRow>()
  for (let t = hourBucket(fromTs); t < toTs; t += 3600) buckets.set(t, { ts: t, priceUsd: null, volumeUsd: 0, feesUsd: 0, liquidity: null, swapCount: 0 })
  for (const s of swaps) {
    const row = buckets.get(hourBucket(blockTs(s.blockNumber))); if (!row) continue
    const usdgAmt = stockIsToken0 ? s.amount1 : s.amount0, stockAmt = stockIsToken0 ? s.amount0 : s.amount1
    const vol = Number(usdgAmt < 0n ? -usdgAmt : usdgAmt) / 10 ** USDG_DECIMALS
    // 手續費收在輸入側。USDG 是輸入 → 金額就是基數；股票是輸入 → USDG 是扣完費的輸出，除以 (1−總費) 還原，
    // 這樣不必乘池價（用交易後的 sqrtPrice 換算大單會有偏差）（D60）
    const usdgIsInput = inputIsNegative ? usdgAmt < 0n : usdgAmt > 0n
    const feeBase = usdgIsInput ? vol : vol / Math.max(0.5, 1 - s.fee / 1e6)
    const token0Amt = stockIsToken0 ? stockAmt : usdgAmt
    const zeroForOne = inputIsNegative ? token0Amt < 0n : token0Amt > 0n
    const lpPpm = lpFeePpm(s.fee, zeroForOne, protocolFee, staticFeePpm)
    row.volumeUsd += vol; row.feesUsd += feeBase * (lpPpm ?? s.fee) / 1e6; row.swapCount++
    if (lpPpm === null) row.protocolFeeUnknown = true
    row.priceUsd = stockPriceUsd(s.sqrtPriceX96, stockIsToken0); row.liquidity = s.liquidity.toString()
  }
  const rows = [...buckets.values()].sort((a, b) => a.ts - b.ts)
  let lastPrice: number | null = null, lastLiq: string | null = null
  for (const r of rows) {
    if (r.priceUsd === null) r.priceUsd = lastPrice; else lastPrice = r.priceUsd
    if (r.liquidity === null) r.liquidity = lastLiq; else lastLiq = r.liquidity
  }
  return rows
}
