import { it, expect } from 'vitest'
import { ageDays, vol7, priceDevPct } from '../scanner/metrics/derived.js'
it('ageDays', () => { expect(ageDays('2026-08-27', '2026-09-03')).toBe(7) })
it('vol7 平均與 CV，不足 7 天標記', () => {
  const r = vol7([100, 100, 100]); expect(r).toEqual({ avg: 100, cv: 0, shortHistory: true })
  expect(vol7([100, 300]).cv).toBeNull()   // D41：< 3 個樣本不算 CV
  const r2 = vol7([0, 200, 0, 200, 0, 200, 0]); expect(r2.avg).toBeCloseTo(85.714, 2); expect(r2.shortHistory).toBe(false); expect(r2.cv).toBeGreaterThan(1)
})
it('priceDevPct 乘 multiplier；無參考價 → null', () => {
  expect(priceDevPct(17.4, 17.905, 1)).toBeCloseTo((17.4 - 17.905) / 17.905, 9)
  expect(priceDevPct(8.7, 17.4, 2)).toBeCloseTo(0, 9)
  expect(priceDevPct(1, null, 1)).toBeNull()
})
