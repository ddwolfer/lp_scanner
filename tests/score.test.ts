import { it, expect } from 'vitest'
import { scorePools, getSimField } from '../scanner/metrics/score.js'
import { loadScoring } from '../config/chain.js'
const mk = (apr: number, inr: number) => ({ meta: { share_method: 'liquidity', hours: 24, sigma7: null, rvol_R: 0.25 },
  d200: null as any, d5000: null as any, d1000: { r10: null as any, rvol: null as any, r25: { fees_usd: 0, value_end_usd: 0, il_usd: 0, net_usd: 0, net_pct: 0, net_apr: apr, net_apr_trimmed: apr, in_range_hours: 0, in_range_pct: inr, exits: 0, hours: 24 } } })
it('getSimField 依 sort_key 取值', () => { expect(getSimField(mk(1.5, 0.9) as any, 'd1000.r25', 'net_apr')).toBe(1.5); expect(getSimField(null, 'd1000.r25', 'net_apr')).toBeNull() })
it('分數落在 [0,1]，各項符合權重', () => {
  const s = loadScoring()
  const rows = [
    { poolId: 'a', sim: mk(2.0, 1.0) as any, vol7Cv: 0, traderCount: 50, priceDevPct: 0, allDayTradable: true },
    { poolId: 'b', sim: mk(1.0, 0.5) as any, vol7Cv: 2, traderCount: 0, priceDevPct: 0.05, allDayTradable: false },
    { poolId: 'c', sim: null, vol7Cv: 0, traderCount: 0, priceDevPct: 0, allDayTradable: false },
  ]
  const m = scorePools(rows, s)
  expect(m.get('a')).toBeCloseTo(1, 9)
  expect(m.get('b')).toBeCloseTo(0.20 * 0.5, 9)
  expect(m.has('c')).toBe(false)
})
