import { it, expect } from 'vitest'
import { sqrtPriceX96ToPrice, stockPriceUsd } from '../scanner/metrics/price.js'
const Q96 = 2n ** 96n
it('sqrtPrice = 1 且 decimals 相同 → 1', () => { expect(sqrtPriceX96ToPrice(Q96, 18, 18)).toBeCloseTo(1, 12) })
it('股票(18) / USDG(6)：price raw = 17.4e-12 → 17.4 USD', () => {
  const raw = 17.4e-12; const sqrt = BigInt(Math.round(Math.sqrt(raw) * 2 ** 96))
  expect(stockPriceUsd(sqrt, true)).toBeCloseTo(17.4, 3)
})
it('股票是 token1 時取倒數', () => {
  const raw = 1 / 17.4e-12; const sqrt = BigInt(Math.round(Math.sqrt(raw) * 2 ** 96))
  expect(stockPriceUsd(sqrt, false)).toBeCloseTo(17.4, 3)
})
