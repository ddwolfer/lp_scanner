import { it, expect } from 'vitest'
import { simulate, simulateAll } from '../scanner/metrics/simulate.js'
import { liquidityForDeposit, L_HUMAN_TO_RAW } from '../scanner/metrics/lp-math.js'
const H = (prices: number[], feesEach = 10, liq: number | null = 1e18) => prices.map((p, i) => ({ ts: 3600 * i, priceUsd: p, feesUsd: feesEach, liquidity: liq === null ? null : String(liq) }))
it('§7.4-1 價格不動 → IL = 0，fees = 累積手續費 × 份額', () => {
  const hours = H(Array(48).fill(100), 10, 1e18)
  const r = simulate(hours, 1000, 0.25)
  const L = liquidityForDeposit(1000, 100, 75, 125); const share = L * L_HUMAN_TO_RAW / (1e18 + L * L_HUMAN_TO_RAW)
  expect(r.il_usd).toBeCloseTo(0, 6)
  expect(r.fees_usd).toBeCloseTo(48 * 10 * share, 6)
  expect(r.in_range_pct).toBe(1); expect(r.exits).toBe(0); expect(r.hours).toBe(48)
  expect(r.net_apr).toBeCloseTo(r.net_pct * 365 / 2, 9)
})
it('§7.4-2 單邊漲 30%、R = 10% → 期末 100% USDG，突破後 in_range = 0', () => {
  const prices = Array.from({ length: 24 }, (_, i) => 100 * (1 + 0.30 * i / 23))
  const r = simulate(H(prices), 1000, 0.10)
  const L = liquidityForDeposit(1000, 100, 90, 110)
  expect(r.value_end_usd).toBeCloseTo(L * (Math.sqrt(110) - Math.sqrt(90)), 4)
  expect(r.exits).toBe(1)
  const above = prices.filter(p => p > 110).length
  expect(r.in_range_hours).toBe(24 - above)
})
it('§7.4-3 對稱漲跌回到原點 → value_end ≈ D（誤差 < 1%）', () => {
  const prices = [100, 110, 120, 110, 100, 90, 80, 90, 100]
  const r = simulate(H(prices, 0), 1000, 0.25)
  expect(Math.abs(r.value_end_usd - 1000) / 1000).toBeLessThan(0.01)
  expect(r.il_usd).toBeCloseTo(0, 6)
})
it('空資料與 liquidity null', () => {
  expect(simulate([], 1000, 0.25).net_usd).toBe(0)
  expect(simulate(H([100, 100], 10, null), 1000, 0.25).fees_usd).toBe(0)
})
it('simulateAll 產生 9 組並在 sigma null 時標 rvol_fallback', () => {
  const { sim, flags } = simulateAll(H(Array(30).fill(100)), null)
  expect(Object.keys(sim.d1000)).toEqual(['r10', 'r25', 'rvol'])
  expect(sim.d1000.rvol).toEqual(sim.d1000.r25); expect(flags).toContain('rvol_fallback')
  expect(sim.d5000.r10.fees_usd).toBeGreaterThan(sim.d200.r10.fees_usd)
})

it('D39 修剪：單一小時暴利被砍掉，top_hour_share 反映集中度', () => {
  const hours = H(Array(40).fill(100), 1, 1e18); hours[3] = { ...hours[3], feesUsd: 1000 }   // 一小時暴量
  const r = simulate(hours, 1000, 0.25)
  expect(r.trimmed_hours).toBe(2)
  expect(r.top_hour_share).toBeGreaterThan(0.9)
  expect(r.fees_trimmed_usd).toBeLessThan(r.fees_usd * 0.1)
  expect(r.net_apr_trimmed).toBeLessThan(r.net_apr)
})
