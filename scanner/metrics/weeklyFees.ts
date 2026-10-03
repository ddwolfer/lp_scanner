// scanner/metrics/weeklyFees.ts — 每週手續費彙整（D68），純函式。dashboard「每週手續費」用
import { isUsTradingUtcDay, snapshotToUtcDay } from './poolSwitch.js'

export interface DailyFee { date: string; usd: number; capitalUsd?: number }   // date = 快照日（台北）；usd = 與前一筆快照之間的已賺手續費；capitalUsd = 當時投入（沒有就用目前投入）
export interface PosFees { id: number; label: string; depositUsd: number; dailyFees: DailyFee[] }
export interface WeekDay { usDay: string; weekday: string; total: number; byPos: { id: number; label: string; usd: number }[] }
export interface Week {
  weekStart: string                // 美股週一（UTC 日期）
  days: WeekDay[]                  // 週一到週五，有資料的才列
  weekend: number                  // 週六、週日的合計
  total: number
  capital: number                  // 這週單日「有收入的頭寸投入合計」的最大值（換池時舊新頭寸不重複算）
  byPos: { id: number; label: string; usd: number }[]   // 以頭寸 id 區分，標籤只用來顯示（Codex review）
}
const WD = ['日', '一', '二', '三', '四', '五', '六']
const mondayOf = (ymd: string) => { const d = new Date(ymd + 'T00:00:00Z'); const w = (d.getUTCDay() + 6) % 7; return new Date(d.getTime() - w * 86400000).toISOString().slice(0, 10) }

/** 快照日 S 對應 UTC S−1 的美股交易時段；依該 UTC 日的週一分週，週末另計 */
export function weeklyFees(list: PosFees[]): Week[] {
  const weeks = new Map<string, Week>()
  const cap = new Map<string, Map<string, Map<number, number>>>()   // 週 → 日 → 頭寸 → 投入
  for (const p of list) for (const f of p.dailyFees) {
    const usDay = snapshotToUtcDay(f.date); const ws = mondayOf(usDay)
    const w = weeks.get(ws) ?? { weekStart: ws, days: [], weekend: 0, total: 0, capital: 0, byPos: [] }; weeks.set(ws, w)
    if (f.usd > 0) { if (!cap.has(ws)) cap.set(ws, new Map()); const dm = cap.get(ws)!; if (!dm.has(usDay)) dm.set(usDay, new Map()); dm.get(usDay)!.set(p.id, f.capitalUsd ?? p.depositUsd) }
    w.total += f.usd
    const bp = w.byPos.find(x => x.id === p.id); if (bp) bp.usd += f.usd; else w.byPos.push({ id: p.id, label: p.label, usd: f.usd })
    if (!isUsTradingUtcDay(usDay)) { w.weekend += f.usd; continue }
    let d = w.days.find(x => x.usDay === usDay)
    if (!d) { d = { usDay, weekday: WD[new Date(usDay + 'T00:00:00Z').getUTCDay()], total: 0, byPos: [] }; w.days.push(d) }
    d.total += f.usd; const dp = d.byPos.find(x => x.id === p.id); if (dp) dp.usd += f.usd; else d.byPos.push({ id: p.id, label: p.label, usd: f.usd })
  }
  for (const [ws, w] of weeks) { w.days.sort((a, b) => a.usDay.localeCompare(b.usDay)); w.byPos.sort((a, b) => b.usd - a.usd); w.capital = Math.max(0, ...[...(cap.get(ws)?.values() ?? [])].map(m => [...m.values()].reduce((a, b) => a + b, 0))) }
  return [...weeks.values()].sort((a, b) => b.weekStart.localeCompare(a.weekStart))
}
