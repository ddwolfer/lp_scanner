// web/src/lib/positionsView.ts — 頭寸頁的篩選與日誌收合，純函式（D77）
export type PosView = 'open' | 'closed' | 'all'
export const POS_VIEWS: [PosView, string][] = [['open', '持有中'], ['closed', '已關閉'], ['all', '全部']]
export const POS_VIEW_KEY = 'lp.positions.view'

/** localStorage 讀到的值不合法（含 null、舊格式）一律退回「持有中」 */
export const parseView = (v: unknown): PosView => (v === 'open' || v === 'closed' || v === 'all' ? v : 'open')

const isClosed = (p: { closed_at?: string | null }) => !!p.closed_at
export function filterPositions<T extends { closed_at?: string | null }>(list: T[], view: PosView): T[] {
  if (view === 'all') return list
  return list.filter(p => (view === 'closed') === isClosed(p))
}
export function countByView(list: { closed_at?: string | null }[]): Record<PosView, number> {
  const closed = list.filter(isClosed).length
  return { open: list.length - closed, closed, all: list.length }
}

/** 收合時只留時間最新的一則；展開時照原順序（伺服器依 ts 由舊到新）全部顯示。hidden = 收合時藏起來的則數 */
export function journalPreview<T extends { ts: string }>(journal: T[] | null | undefined, expanded: boolean): { shown: T[]; hidden: number } {
  const all = journal ?? []
  if (expanded || all.length <= 1) return { shown: all, hidden: 0 }
  const latest = all.reduce((a, b) => (b.ts >= a.ts ? b : a))
  return { shown: [latest], hidden: all.length - 1 }
}
