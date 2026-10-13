import { describe, it, expect } from 'vitest'
import { groupWeekRows, type WPos } from '../web/src/lib/weeklyRows.js'

const pos = (o: Partial<WPos> & { id: number; symbol: string }): WPos => ({ label: `${o.symbol} #${o.id}`, usd: o.tdUsd ?? 0, closed: false, tdUsd: 0, tdUsdCap: 0, tdCapHours: 0, gappy: false, ...o })
describe('每週手續費頭寸表分組（D78）', () => {
  const prev = { tradingDays: 5, openSymbols: ['MSTR', 'TSLA', 'TSM'], byPos: [
    pos({ id: 1, symbol: 'MSTR', tdUsd: 10, closed: true, label: 'MSTR #1445' }),   // 搬池前的舊倉
    pos({ id: 2, symbol: 'MSTR', tdUsd: 5 }),
    pos({ id: 3, symbol: 'SPY', tdUsd: 4.75, closed: true }),
    pos({ id: 4, symbol: 'TSLA', tdUsd: 2 }),
  ] }
  const cur = { tradingDays: 1, openSymbols: ['MSTR', 'TSLA', 'TSM'], byPos: [
    pos({ id: 2, symbol: 'MSTR', tdUsd: 1.87, tdUsdCap: 1.87, tdCapHours: 1500 * 24 }),
    pos({ id: 5, symbol: 'MSTR', tdUsd: 1.72, tdUsdCap: 1.72, tdCapHours: 1600 * 24, gappy: true }),   // 搬池後的新倉
    pos({ id: 6, symbol: 'TSM', tdUsd: 1.61, tdUsdCap: 1.61, tdCapHours: 2400 * 24, label: 'TSM #8427' }),
    pos({ id: 4, symbol: 'TSLA', tdUsd: 0.5 }),
  ] }
  const { rows, curAvg, prevAvg } = groupWeekRows(cur, prev)
  it('同幣種合併、單一頭寸直接顯示名稱、已關閉幣種歸到最後一列', () => {
    expect(rows.map(r => r.label)).toEqual(['MSTR ×3', 'TSM #8427', 'TSLA #4', '已關閉合計 ×1'])
    expect(rows[0].children.map(c => c.label)).toEqual(['MSTR #2', 'MSTR #5', 'MSTR #1445'])
    expect(rows[3].children.map(c => c.label)).toEqual(['SPY #3'])
  })
  it('每交易日貢獻用全週共同分母，所有列加起來等於標題平均', () => {
    expect(rows[0].cur).toBeCloseTo(3.59); expect(rows[0].prev).toBeCloseTo(3); expect(rows[0].delta).toBeCloseTo(0.59)   // 搬池前後接得起來
    const sumCur = rows.reduce((a, r) => a + (r.cur ?? 0), 0), sumPrev = rows.reduce((a, r) => a + (r.prev ?? 0), 0)
    expect(sumCur).toBeCloseTo(curAvg!); expect(sumPrev).toBeCloseTo(prevAvg!); expect(prevAvg).toBeCloseTo(21.75 / 5)
  })
  it('每千元用本金時數，分組先加總再相除；沒有本金時數為 null', () => {
    expect(rows[0].perK).toBeCloseTo((1.87 + 1.72) / 3100 * 1000)
    expect(rows[1].perK).toBeCloseTo(1.61 / 2.4)
    expect(rows[2].perK).toBeNull()
    expect(rows[0].gappy).toBe(true)
  })
  it('只有前一週有資料的列這週記 0；這週新開的頭寸前一週記 0；沒有前一週時 prev/delta 為 null', () => {
    const tsm = rows[1]; expect(tsm.prev).toBe(0); expect(tsm.delta).toBeCloseTo(1.61)
    expect(rows[3].cur).toBe(0)
    const solo = groupWeekRows(cur)
    expect(solo.prevAvg).toBeNull(); expect(solo.rows.every(r => r.prev === null && r.delta === null)).toBe(true)
    const empty = groupWeekRows({ ...cur, tradingDays: 0 }, prev)
    expect(empty.curAvg).toBeNull(); expect(empty.rows[0].cur).toBeNull(); expect(empty.rows[0].delta).toBeNull()
  })
})
