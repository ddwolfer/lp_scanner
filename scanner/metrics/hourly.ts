// scanner/metrics/hourly.ts — 純函式：Swap log → 每小時列
// 手續費以 USDG 側成交量 × fee/1e6 近似（DECISIONS D11）
import { hourBucket } from '../time.js'
import { stockPriceUsd } from './price.js'
import { USDG_DECIMALS } from '../../config/chain.js'
import type { SwapLog } from '../sources/uniswapV4.js'
export interface HourlyRow { ts: number; priceUsd: number | null; volumeUsd: number; feesUsd: number; liquidity: string | null; swapCount: number }
export function aggregateHourly(swaps: SwapLog[], blockTs: (b: bigint) => number, stockIsToken0: boolean, fromTs: number, toTs: number): HourlyRow[] {
  const buckets = new Map<number, HourlyRow>()
  for (let t = hourBucket(fromTs); t < toTs; t += 3600) buckets.set(t, { ts: t, priceUsd: null, volumeUsd: 0, feesUsd: 0, liquidity: null, swapCount: 0 })
  for (const s of swaps) {
    const row = buckets.get(hourBucket(blockTs(s.blockNumber))); if (!row) continue
    const usdgAmt = stockIsToken0 ? s.amount1 : s.amount0
    const vol = Number(usdgAmt < 0n ? -usdgAmt : usdgAmt) / 10 ** USDG_DECIMALS
    row.volumeUsd += vol; row.feesUsd += vol * s.fee / 1e6; row.swapCount++
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
