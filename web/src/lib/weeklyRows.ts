// web/src/lib/weeklyRows.ts — 每週手續費「頭寸」表的分組與每交易日換算，純函式（D78）
export type WPos = { id: number; label: string; usd: number; symbol: string; closed: boolean; tdUsd: number; tdUsdCap: number; tdCapHours: number; gappy: boolean }
export type WWeek = { tradingDays: number; byPos: WPos[]; openSymbols: string[] }
export interface Row {
  key: string; label: string; closed: boolean; gappy: boolean
  cur: number | null; prev: number | null; delta: number | null   // 每交易日貢獻（$/日）：交易日手續費 ÷ 該週交易日數，所有列加起來 = 標題的交易日平均
  perK: number | null                                              // 這週每千元每天：費 ÷ (本金×小時 ÷ 24) × 1000，只用有本金時數的資料
  children: Row[]
}
type Agg = { cur: { td: number; feeCap: number; capH: number } | null; prev: number | null; gappy: boolean }
const perDay = (sum: number, days: number | undefined) => (days && days > 0 ? sum / days : null)

/** 前一週不存在或沒有交易日 → prev / delta 為 null（畫面顯示「—」，不當成 0）。 */
export function groupWeekRows(cur: WWeek, prev?: WWeek): { rows: Row[]; curAvg: number | null; prevAvg: number | null } {
  const curDays = cur.tradingDays, prevDays = prev?.tradingDays ?? 0
  const prevBy = new Map((prev?.byPos ?? []).map(p => [p.id, p]))
  const ids = [...new Set([...cur.byPos.map(p => p.id), ...(prev?.byPos ?? []).map(p => p.id)])]
  const curBy = new Map(cur.byPos.map(p => [p.id, p]))
  const open = new Set(cur.openSymbols)
  const mkRow = (key: string, label: string, closed: boolean, a: Agg, children: Row[]): Row => {
    const c = curDays > 0 ? (a.cur ? a.cur.td : 0) / curDays : null
    const p = prevDays > 0 && a.prev !== null ? a.prev / prevDays : null
    return { key, label, closed, gappy: a.gappy, cur: c, prev: p, delta: c !== null && p !== null ? c - p : null,
      perK: a.cur && a.cur.capH > 0 ? a.cur.feeCap / (a.cur.capH / 24) * 1000 : null, children }
  }
  const posRow = (id: number): Row => {
    const c = curBy.get(id), p = prevBy.get(id), any = (c ?? p)!
    return mkRow(`p${id}`, any.label, any.closed, { cur: c ? { td: c.tdUsd, feeCap: c.tdUsdCap, capH: c.tdCapHours } : null, prev: prev ? (p?.tdUsd ?? 0) : null, gappy: !!(c?.gappy || p?.gappy) }, [])
  }
  const groupRow = (key: string, label: string, members: number[], closed: boolean): Row => {
    const kids = members.map(posRow).sort(byCur)
    let td = 0, feeCap = 0, capH = 0, pv = 0, hasCur = false
    for (const id of members) { const c = curBy.get(id); if (c) { hasCur = true; td += c.tdUsd; feeCap += c.tdUsdCap; capH += c.tdCapHours } pv += prevBy.get(id)?.tdUsd ?? 0 }
    const r = mkRow(key, label, closed, { cur: hasCur ? { td, feeCap, capH } : null, prev: prev ? pv : null, gappy: kids.some(k => k.gappy) }, kids)
    return r
  }
  const bySym = new Map<string, number[]>(); const closedIds: number[] = []
  for (const id of ids) { const p = (curBy.get(id) ?? prevBy.get(id))!; if (open.has(p.symbol)) bySym.set(p.symbol, [...(bySym.get(p.symbol) ?? []), id]); else closedIds.push(id) }
  const rows: Row[] = []
  for (const [sym, members] of bySym) {
    if (members.length === 1) rows.push(posRow(members[0]))
    else rows.push(groupRow(`s${sym}`, `${sym} ×${members.length}`, members, false))
  }
  rows.sort(byCur)
  if (closedIds.length) rows.push(groupRow('closed', `已關閉合計 ×${closedIds.length}`, closedIds, true))
  const sumTd = (w?: WWeek) => (w?.byPos ?? []).reduce((a, p) => a + p.tdUsd, 0)
  return { rows, curAvg: perDay(sumTd(cur), curDays), prevAvg: prev ? perDay(sumTd(prev), prevDays) : null }
}
function byCur(a: Row, b: Row) { return (b.cur ?? -Infinity) - (a.cur ?? -Infinity) || (b.prev ?? -Infinity) - (a.prev ?? -Infinity) }
