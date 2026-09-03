import { it, expect } from 'vitest'
import { liquidityForDeposit, positionAmounts, positionValue } from '../scanner/metrics/lp-math.js'
const P0 = 100, Pl = 75, Pu = 125, D = 1000
const L = liquidityForDeposit(D, P0, Pl, Pu)
it('在 P0 的市值 = D，且兩邊價值接近各半', () => {
  expect(positionValue(L, P0, Pl, Pu)).toBeCloseTo(D, 6)
  const { x, y } = positionAmounts(L, P0, Pl, Pu)
  expect(x * P0).toBeGreaterThan(400); expect(y).toBeGreaterThan(400)
})
it('低於 Pl 全是股票，高於 Pu 全是 USDG', () => {
  expect(positionAmounts(L, 50, Pl, Pu).y).toBe(0)
  expect(positionAmounts(L, 200, Pl, Pu).x).toBe(0)
  expect(positionValue(L, 200, Pl, Pu)).toBeCloseTo(positionValue(L, Pu, Pl, Pu), 6)
})
it('市值低於持有對照（IL ≥ 0）', () => {
  const { x: x0, y: y0 } = positionAmounts(L, P0, Pl, Pu)
  for (const P of [60, 80, 100, 120, 140]) expect(positionValue(L, P, Pl, Pu)).toBeLessThanOrEqual(x0 * P + y0 + 1e-9)
})
