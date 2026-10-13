// scanner/metrics/weeklyFees.ts — 每週手續費彙整（D68），純函式。dashboard「每週手續費」用
import { isUsTradingUtcDay, snapshotToUtcDay } from './poolSwitch.js'

export interface DailyFee { date: string; usd: number; capitalUsd?: number; hours?: number; capHours?: number }   // date = 快照日（台北）；usd = 與前一筆快照之間的已賺手續費；capitalUsd = 當時投入（沒有就用目前投入）
export interface PosFees { id: number; label: string; depositUsd: number; dailyFees: DailyFee[]; symbol?: string; closed?: boolean }   // symbol、closed：D78 依幣種分組用
export interface WeekDay { usDay: string; weekday: string; total: number; byPos: { id: number; label: string; usd: number }[] }
export interface Week {
  weekStart: string                // 美股週一（UTC 日期）
  days: WeekDay[]                  // 週一到週五，有資料的才列
  weekend: number                  // 週六、週日的合計
  total: number
  capital: number                  // 這週單日「有收入的頭寸投入合計」的最大值（換池時舊新頭寸不重複算）
  byPos: WeekPos[]                 // 以頭寸 id 區分，標籤只用來顯示（Codex review）
  tradingDays: number              // D78：這週有資料的美股交易日數（= days.length），每交易日貢獻的共同分母
  openSymbols: string[]            // D78：目前還有持有中頭寸的幣種（依完整頭寸清單，不只看這週有沒有資料）
}
/** D78：tdUsd = 交易日手續費（不含週末）；tdUsdCap / tdCapHours = 有本金時數的那些交易日的費與本金×小時，算每千元用；gappy = 有快照區間超過 30 小時（跨日補抓）。 */
export interface WeekPos { id: number; label: string; usd: number; symbol: string; closed: boolean; tdUsd: number; tdUsdCap: number; tdCapHours: number; gappy: boolean }
const WD = ['日', '一', '二', '三', '四', '五', '六']
const mondayOf = (ymd: string) => { const d = new Date(ymd + 'T00:00:00Z'); const w = (d.getUTCDay() + 6) % 7; return new Date(d.getTime() - w * 86400000).toISOString().slice(0, 10) }

/** 快照日 S 對應 UTC S−1 的美股交易時段；依該 UTC 日的週一分週，週末另計 */
export function weeklyFees(list: PosFees[]): Week[] {
  const weeks = new Map<string, Week>()
  const openSymbols = [...new Set(list.filter(p => !p.closed).map(p => p.symbol ?? p.label))].sort()
  const cap = new Map<string, Map<string, Map<number, number>>>()   // 週 → 日 → 頭寸 → 投入
  for (const p of list) for (const f of p.dailyFees) {
    const usDay = snapshotToUtcDay(f.date); const ws = mondayOf(usDay)
    const w = weeks.get(ws) ?? { weekStart: ws, days: [], weekend: 0, total: 0, capital: 0, byPos: [], tradingDays: 0, openSymbols }; weeks.set(ws, w)
    if (f.usd > 0) { if (!cap.has(ws)) cap.set(ws, new Map()); const dm = cap.get(ws)!; if (!dm.has(usDay)) dm.set(usDay, new Map()); dm.get(usDay)!.set(p.id, f.capitalUsd ?? p.depositUsd) }
    w.total += f.usd
    let bp = w.byPos.find(x => x.id === p.id)
    if (!bp) { bp = { id: p.id, label: p.label, usd: 0, symbol: p.symbol ?? p.label, closed: !!p.closed, tdUsd: 0, tdUsdCap: 0, tdCapHours: 0, gappy: false }; w.byPos.push(bp) }
    bp.usd += f.usd
    if (!isUsTradingUtcDay(usDay)) { w.weekend += f.usd; continue }
    bp.tdUsd += f.usd
    if (f.capHours !== undefined && f.capHours > 0) { bp.tdUsdCap += f.usd; bp.tdCapHours += f.capHours }
    if ((f.hours ?? 0) > 30) bp.gappy = true
    let d = w.days.find(x => x.usDay === usDay)
    if (!d) { d = { usDay, weekday: WD[new Date(usDay + 'T00:00:00Z').getUTCDay()], total: 0, byPos: [] }; w.days.push(d) }
    d.total += f.usd; const dp = d.byPos.find(x => x.id === p.id); if (dp) dp.usd += f.usd; else d.byPos.push({ id: p.id, label: p.label, usd: f.usd })
  }
  for (const [ws, w] of weeks) { w.days.sort((a, b) => a.usDay.localeCompare(b.usDay)); w.byPos.sort((a, b) => b.usd - a.usd); w.tradingDays = w.days.length; w.capital = Math.max(0, ...[...(cap.get(ws)?.values() ?? [])].map(m => [...m.values()].reduce((a, b) => a + b, 0))) }
  return [...weeks.values()].sort((a, b) => b.weekStart.localeCompare(a.weekStart))
}

/** D69：兩筆快照之間新賺的手續費。兩筆都有代幣數量且沒有領取（兩邊數量都沒減少）→ 用數量增量以後一筆的股價估值，
 *  不會把「舊的未領股票因股價漲跌」算成收入；否則退回美元差（含領取金額加回）。 */
export interface FeeSnap { fees_cum_usd: number; fees_stock: number | null; fees_usdg: number | null; price_usd: number | null; collected: number }
export function feeDelta(prev: FeeSnap | null, cur: FeeSnap): number {
  if (!prev) return cur.fees_cum_usd + cur.collected
  const eps = 1e-12
  if (prev.fees_stock !== null && prev.fees_usdg !== null && cur.fees_stock !== null && cur.fees_usdg !== null && cur.price_usd !== null
      && cur.fees_stock >= prev.fees_stock - eps && cur.fees_usdg >= prev.fees_usdg - eps && cur.collected === prev.collected)
    return (cur.fees_stock - prev.fees_stock) * cur.price_usd + (cur.fees_usdg - prev.fees_usdg)
  return (cur.fees_cum_usd + cur.collected) - (prev.fees_cum_usd + prev.collected)
}
