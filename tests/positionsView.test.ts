import { describe, it, expect } from 'vitest'
import { parseView, filterPositions, countByView, journalPreview } from '../web/src/lib/positionsView.js'

const list = [{ id: 1, closed_at: null }, { id: 2, closed_at: '2026-10-12T10:57:25Z' }, { id: 3 }, { id: 4, closed_at: '' }]
describe('頭寸頁篩選與日誌收合（D77）', () => {
  it('parseView 不合法的值退回 open', () => {
    expect(parseView('closed')).toBe('closed'); expect(parseView('all')).toBe('all')
    expect(parseView(null)).toBe('open'); expect(parseView('two')).toBe('open'); expect(parseView(undefined)).toBe('open')
  })
  it('filterPositions 以 closed_at 判斷，空字串與缺欄位視為持有中', () => {
    expect(filterPositions(list, 'open').map(p => p.id)).toEqual([1, 3, 4])
    expect(filterPositions(list, 'closed').map(p => p.id)).toEqual([2])
    expect(filterPositions(list, 'all')).toBe(list)
  })
  it('countByView', () => expect(countByView(list)).toEqual({ open: 3, closed: 1, all: 4 }))
  it('journalPreview 收合只留最新一則，展開全部照原順序', () => {
    const j = [{ id: 'a', ts: '2026-10-01T00:00:00Z' }, { id: 'b', ts: '2026-10-09T00:00:00Z' }, { id: 'c', ts: '2026-10-05T00:00:00Z' }]
    expect(journalPreview(j, false)).toEqual({ shown: [j[1]], hidden: 2 })
    expect(journalPreview(j, true)).toEqual({ shown: j, hidden: 0 })
    expect(journalPreview([j[0]], false)).toEqual({ shown: [j[0]], hidden: 0 })
    expect(journalPreview(undefined, false)).toEqual({ shown: [], hidden: 0 })
  })
})
