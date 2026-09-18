import { describe, it, expect } from 'vitest'
import { exitBreakeven } from '../scanner/metrics/economics.js'
describe('exitBreakeven（D61）', () => {
  const base = { D: 5000, P0: 100, Pl: 98, Pu: 102, swapFeeRate: 0.004, gasPerTx: 2, txs: 2 }
  it('文中範例：5000、±2%、APR 5000% → 要補 ≈108.5、約 3.8 小時', () => {
    const hourly = 50 * 5000 / 8760 * 0.996   // 28.42/小時
    const be = exitBreakeven({ ...base, dailyFeeUsd: hourly * 24 })
    expect(be.lower.toCoverUsd).toBeCloseTo(108.5, 0)
    expect(be.lower.days! * 24).toBeCloseTo(3.82, 1)
  })
  it('進場磨損只算買進的幣側（現價貼近上緣 → 幾乎全是 USDG → 幣少）', () => {
    const sym = exitBreakeven({ ...base, dailyFeeUsd: 100 }), nearTop = exitBreakeven({ ...base, Pl: 90, Pu: 100.5, dailyFeeUsd: 100 })
    expect(nearTop.lower.entrySwapUsd).toBeLessThan(sym.lower.entrySwapUsd)
  })
  it('漲穿上緣時全是 USDG，出場不必換幣，通常不虧', () => {
    const be = exitBreakeven({ ...base, dailyFeeUsd: 100 })
    expect(be.upper.exitSwapUsd).toBe(0); expect(be.upper.covered).toBe(true); expect(be.upper.days).toBe(0)
  })
  it('沒有費速 → days 為 null，但金額照算', () => {
    const be = exitBreakeven({ ...base, dailyFeeUsd: 0 })
    expect(be.lower.days).toBeNull(); expect(be.lower.toCoverUsd).toBeGreaterThan(0)
  })
  it('持倉中：已賺的費扣掉、進場成本改用已發生成本；賺夠了就 covered、不出現負天數', () => {
    const live = exitBreakeven({ ...base, dailyFeeUsd: 100, live: { feesEarnedUsd: 50, costsIncurredUsd: 3 } })
    expect(live.lower.entrySwapUsd).toBe(3); expect(live.lower.toCoverUsd).toBeCloseTo(exitBreakeven({ ...base, dailyFeeUsd: 100 }).lower.toCoverUsd - 50 + 3 - exitBreakeven({ ...base, dailyFeeUsd: 100 }).lower.entrySwapUsd, 6)
    const rich = exitBreakeven({ ...base, dailyFeeUsd: 100, live: { feesEarnedUsd: 10000 } })
    expect(rich.lower.covered).toBe(true); expect(rich.lower.days).toBe(0)
  })
  it('給真實流動性 L 時以它為準（加減倉後 D 與 L 不再對應）', () => {
    const a = exitBreakeven({ ...base, dailyFeeUsd: 100 }); const b = exitBreakeven({ ...base, dailyFeeUsd: 100, L: a.L * 2 })
    expect(b.lower.valueAtBound).toBeCloseTo(a.lower.valueAtBound * 2, 6)
  })
})
