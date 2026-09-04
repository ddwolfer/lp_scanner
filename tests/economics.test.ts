import { it, expect } from 'vitest'
import { volumePersistence, lifecycleCost, capacityUsd } from '../scanner/metrics/economics.js'
import { liquidityForDeposit, L_HUMAN_TO_RAW } from '../scanner/metrics/lp-math.js'
it('volumePersistence：最近 6 小時是全天平均的兩倍 → 2', () => {
  const v = [...Array(18).fill(10), ...Array(6).fill(40)]   // avg = (180+240)/24 = 17.5, recent = 40
  expect(volumePersistence(v, 6)).toBeCloseTo(40 / 17.5, 9)
  expect(volumePersistence(Array(24).fill(0), 6)).toBeNull()
})
it('lifecycleCost：$1000 在 0.25% 池，四筆 gas → 成本與回本天數', () => {
  const c = lifecycleCost(1000, 2500, 8, 0.6, 4)
  expect(c.swapInUsd).toBeCloseTo(1.25, 9); expect(c.gasUsd).toBeCloseTo(2.4, 9); expect(c.totalUsd).toBeCloseTo(4.9, 9); expect(c.breakevenDays).toBeCloseTo(4.9 / 8, 9)
  expect(lifecycleCost(100, 2500, 0).breakevenDays).toBeNull()
})
it('capacityUsd：投入 = 容量時份額剛好 10%', () => {
  const price = 100, R = 0.25, Lpool = 10n ** 18n
  const cap = capacityUsd(Lpool, price, R, 0.10)!
  const Lraw = liquidityForDeposit(cap, price, 75, 125) * L_HUMAN_TO_RAW
  expect(Lraw / (Number(Lpool) + Lraw)).toBeCloseTo(0.10, 6)
  expect(capacityUsd(0n, price, R)).toBeNull()
})
