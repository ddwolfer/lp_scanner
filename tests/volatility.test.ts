import { it, expect } from 'vitest'
import { weeklySigma, rvolRange } from '../scanner/metrics/volatility.js'
it('價格不動 σ = 0；不足 5 天回 null', () => {
  expect(weeklySigma(Array(168).fill(10))).toBe(0)
  expect(weeklySigma(Array(100).fill(10))).toBeNull()
})
it('每小時 ±1% 交替 → 週波動率 ≈ ln(1.01) × √168', () => {
  const p: number[] = [100]; for (let i = 1; i < 168; i++) p.push(p[i - 1] * (i % 2 ? 1.01 : 1 / 1.01))
  expect(weeklySigma(p)).toBeCloseTo(Math.log(1.01) * Math.sqrt(168), 2)
})
it('rvolRange 夾在 [0.05, 0.40]，null 退回 0.25', () => {
  expect(rvolRange(0.01)).toEqual({ R: 0.05, fallback: false })
  expect(rvolRange(0.10)).toEqual({ R: 0.20, fallback: false })
  expect(rvolRange(0.50)).toEqual({ R: 0.40, fallback: false })
  expect(rvolRange(null)).toEqual({ R: 0.25, fallback: true })
})
