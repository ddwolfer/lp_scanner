// scanner/metrics/price.ts — 純函式（DECISIONS D4）
import { STOCK_DECIMALS, USDG_DECIMALS } from '../../config/chain.js'
/** token0 以 token1 計價，已調整 decimals：price = (sqrtP / 2^96)^2 × 10^(d0 − d1) */
export function sqrtPriceX96ToPrice(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number {
  const s = Number(sqrtPriceX96) / 2 ** 96
  return s * s * 10 ** (decimals0 - decimals1)
}
/** 股票代幣（18）對 USDG（6）的美元價，不論股票在哪一邊 */
export function stockPriceUsd(sqrtPriceX96: bigint, stockIsToken0: boolean): number {
  return stockIsToken0
    ? sqrtPriceX96ToPrice(sqrtPriceX96, STOCK_DECIMALS, USDG_DECIMALS)
    : 1 / sqrtPriceX96ToPrice(sqrtPriceX96, USDG_DECIMALS, STOCK_DECIMALS)
}
