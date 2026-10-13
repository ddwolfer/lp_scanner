import { expect, it } from 'vitest'
import { weeklyFees } from '../scanner/metrics/weeklyFees.js'
it('weeklyFees：快照日換成美股交易日、按週一分週、週末另計、各頭寸合計', () => {
  const weeks = weeklyFees([
    { id: 1, label: 'MSTR', depositUsd: 1000, dailyFees: [
      { date: '2026-09-26', usd: 2 },   // UTC 09-25 週五
      { date: '2026-09-27', usd: 0.2 }, // UTC 09-26 週六
      { date: '2026-09-28', usd: 0.3 }, // UTC 09-27 週日
      { date: '2026-09-29', usd: 3 },   // UTC 09-28 週一 → 新的一週
      { date: '2026-09-30', usd: 1 } ] },
    { id: 2, label: 'SPY', depositUsd: 2000, dailyFees: [{ date: '2026-09-29', usd: 1.5 }] },
  ])
  expect(weeks.map(w => w.weekStart)).toEqual(['2026-09-28', '2026-09-21'])
  const [cur, prev] = weeks
  expect(cur.days.map(d => [d.usDay, d.weekday, d.total])).toEqual([['2026-09-28', '一', 4.5], ['2026-09-29', '二', 1]])
  expect(cur.total).toBeCloseTo(5.5); expect(cur.weekend).toBe(0); expect(cur.capital).toBe(3000)   // 週一兩個都有收入
  expect(weeklyFees([{ id: 1, label: 'old', depositUsd: 1000, dailyFees: [{ date: '2026-09-29', usd: 2 }] }, { id: 2, label: 'new', depositUsd: 1000, dailyFees: [{ date: '2026-09-29', usd: 0 }, { date: '2026-09-30', usd: 2 }] }])[0].capital).toBe(1000)   // 換池：同一天不重複
  expect(cur.byPos.map(({ id, label, usd }) => ({ id, label, usd }))).toEqual([{ id: 1, label: 'MSTR', usd: 4 }, { id: 2, label: 'SPY', usd: 1.5 }])
  expect(prev.days.map(d => d.usDay)).toEqual(['2026-09-25']); expect(prev.weekend).toBeCloseTo(0.5); expect(prev.total).toBeCloseTo(2.5)
})

it('weeklyFees：同名頭寸用 id 分開；歷史週用當時的投入', () => {
  const w = weeklyFees([
    { id: 1, label: 'MSTR #1', depositUsd: 3000, dailyFees: [{ date: '2026-09-22', usd: 1, capitalUsd: 1000 }] },   // 後來加倉到 3000
    { id: 2, label: 'MSTR #1', depositUsd: 500, dailyFees: [{ date: '2026-09-22', usd: 2 }] },
  ])[0]
  expect(w.byPos.map(x => x.id)).toEqual([2, 1]); expect(w.days[0].byPos).toHaveLength(2)
  expect(w.capital).toBe(1500)
})

import { feeDelta } from '../scanner/metrics/weeklyFees.js'
it('feeDelta：有代幣數量時只算新增數量，舊的未領股票漲價不算收入；領取後退回美元差', () => {
  const a = { fees_cum_usd: 100, fees_stock: 1, fees_usdg: 0, price_usd: 100, collected: 0 }
  expect(feeDelta(a, { fees_cum_usd: 110, fees_stock: 1, fees_usdg: 0, price_usd: 110, collected: 0 })).toBe(0)        // 只是股價漲
  expect(feeDelta(a, { fees_cum_usd: 112.2, fees_stock: 1.02, fees_usdg: 0, price_usd: 110, collected: 0 })).toBeCloseTo(2.2)
  expect(feeDelta(a, { fees_cum_usd: 3, fees_stock: 0.01, fees_usdg: 2, price_usd: 100, collected: 100 })).toBeCloseTo(3)   // 領走 $100 → 美元差 (3+100)−100
  expect(feeDelta({ ...a, fees_stock: null }, { fees_cum_usd: 105, fees_stock: 1, fees_usdg: 0, price_usd: 105, collected: 0 })).toBe(5)   // 舊快照沒數量 → 美元差
  expect(feeDelta(null, { fees_cum_usd: 4, fees_stock: null, fees_usdg: null, price_usd: null, collected: 1 })).toBe(5)
})

it('weeklyFees D78：交易日費不含週末、本金時數、跨日補抓、目前持有中的幣種', () => {
  const [cur, prev] = weeklyFees([
    { id: 1, label: 'MSTR #1', symbol: 'MSTR', closed: false, depositUsd: 1000, dailyFees: [
      { date: '2026-09-27', usd: 0.4, hours: 24, capHours: 24000 },         // UTC 09-26 週六 → 週末
      { date: '2026-09-29', usd: 3, hours: 48, capHours: 48000 },           // 週一，跨日補抓
      { date: '2026-09-30', usd: 1, hours: 24 } ] },                        // 沒有本金時數 → 不進每千元
    { id: 2, label: 'SPY #1', symbol: 'SPY', closed: true, depositUsd: 2000, dailyFees: [{ date: '2026-09-29', usd: 1.5, hours: 24, capHours: 48000 }] },
  ])
  expect(cur.tradingDays).toBe(2); expect(cur.openSymbols).toEqual(['MSTR'])
  const m = cur.byPos.find(x => x.id === 1)!
  expect(m).toMatchObject({ symbol: 'MSTR', closed: false, tdUsd: 4, tdUsdCap: 3, tdCapHours: 48000, gappy: true })
  expect(cur.byPos.find(x => x.id === 2)).toMatchObject({ symbol: 'SPY', closed: true, tdUsd: 1.5, gappy: false })
  expect(prev.byPos[0]).toMatchObject({ usd: 0.4, tdUsd: 0, tdCapHours: 0 }); expect(prev.tradingDays).toBe(0)
})
