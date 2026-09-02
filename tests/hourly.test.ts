import { it, expect } from 'vitest'
import { aggregateHourly } from '../scanner/metrics/hourly.js'
const sqrt = (p: number) => BigInt(Math.round(Math.sqrt(p * 1e-12) * 2 ** 96)) // 股票 token0
const sw = (block: bigint, usdg: number, price: number, fee = 30000) => ({ blockNumber: block, txHash: '0x', logIndex: 0, sender: '0x', amount0: -1n, amount1: BigInt(Math.round(usdg * 1e6)), sqrtPriceX96: sqrt(price), liquidity: 123n, tick: 0, fee })
it('每小時一列，量與費用正確，空小時沿用前價', () => {
  const rows = aggregateHourly([sw(1n, 100, 17), sw(2n, 50, 18)], b => (b === 1n ? 3600 : 3600 + 60), true, 3600, 3 * 3600)
  expect(rows).toHaveLength(2)
  expect(rows[0]).toEqual({ ts: 3600, priceUsd: expect.closeTo(18, 3), volumeUsd: 150, feesUsd: 4.5, liquidity: '123', swapCount: 2 })
  expect(rows[1]).toEqual({ ts: 7200, priceUsd: expect.closeTo(18, 3), volumeUsd: 0, feesUsd: 0, liquidity: '123', swapCount: 0 })
})
