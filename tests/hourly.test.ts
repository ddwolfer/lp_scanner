import { it, expect } from 'vitest'
import { aggregateHourly } from '../scanner/metrics/hourly.js'
const sqrt = (p: number) => BigInt(Math.round(Math.sqrt(p * 1e-12) * 2 ** 96)) // 股票 token0
const sw = (block: bigint, usdg: number, price: number, fee = 30000) => ({ blockNumber: block, txHash: '0x', logIndex: 0, sender: '0x', amount0: -1n, amount1: BigInt(Math.round(usdg * 1e6)), sqrtPriceX96: sqrt(price), liquidity: 123n, tick: 0, fee })
it('每小時一列，量與費用正確，空小時沿用前價', () => {
  const rows = aggregateHourly([sw(1n, 100, 17), sw(2n, 50, 18)], b => (b === 1n ? 3600 : 3600 + 60), true, 3600, 3 * 3600, { protocolFee: { ppm0: 0, ppm1: 0 } })
  expect(rows).toHaveLength(2)
    // 這兩筆的輸入是股票（amount0 為負）、USDG 是扣完費的輸出，所以費基要還原：150/(1−3%)×3% = 4.639（D60）
  expect(rows[0]).toEqual({ ts: 3600, priceUsd: expect.closeTo(18, 3), volumeUsd: 150, feesUsd: expect.closeTo(4.639, 3), liquidity: '123', swapCount: 2 })
  expect(rows[1]).toEqual({ ts: 7200, priceUsd: expect.closeTo(18, 3), volumeUsd: 0, feesUsd: 0, liquidity: '123', swapCount: 0 })
})

it('USDG 是輸入時費基就是 USDG 金額，且要扣掉協議費（D60）', () => {
  const usdgIn = (block: bigint, usdg: number, price: number, fee: number) => ({ blockNumber: block, txHash: '0x', logIndex: 0, sender: '0x',
    amount0: 1n, amount1: -BigInt(Math.round(usdg * 1e6)), sqrtPriceX96: sqrt(price), liquidity: 123n, tick: 0, fee })
  const noPf = aggregateHourly([usdgIn(1n, 1000, 18, 2899)], () => 3600, true, 3600, 2 * 3600, { protocolFee: { ppm0: 0, ppm1: 0 } })
  expect(noPf[0].feesUsd).toBeCloseTo(2.899, 4)   // 沒扣協議費：高估
  const withPf = aggregateHourly([usdgIn(1n, 1000, 18, 2899)], () => 3600, true, 3600, 2 * 3600, { protocolFee: { ppm0: 400, ppm1: 400 }, staticFeePpm: 2500 })
  expect(withPf[0].feesUsd).toBeCloseTo(2.499, 4)   // 扣掉 400ppm 協議費後的 LP 實得
  expect(withPf[0].feesUsd / noPf[0].feesUsd).toBeCloseTo(0.862, 3)   // 舊算法高估約 16%
})
