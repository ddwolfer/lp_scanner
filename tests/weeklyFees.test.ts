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
  expect(cur.byPos).toEqual([{ id: 1, label: 'MSTR', usd: 4 }, { id: 2, label: 'SPY', usd: 1.5 }])
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
