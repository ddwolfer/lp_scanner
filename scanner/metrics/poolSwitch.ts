// scanner/metrics/poolSwitch.ts — 頭寸「是否該換池」提示（D65 → D67），純函式。只提示、不動作（SPEC §10）
// D67：不再用全池「費/TVL」比（那假設你的每塊錢都賺到池子平均，實測 Fables 池高估兩倍以上），
// 改用「你這個頭寸的真實區間與金額」在各池逐小時重放，只比美股交易日、兩邊都有資料的同一批日子。

/** 一個池在「你的區間」下每個交易日的模擬手續費（UTC 日期 → 美元），只含資料完整的日子 */
export type DailyReplay = Map<string, number>
export interface AltPool {
  poolId: string; label: string; hookKind: 'none' | 'fee_only'
  ageDays: number | null; tvlNow: number | null; tvlMin7: number | null; tvlMax7: number | null
  daily: DailyReplay
}
export interface SwitchCfg { ratio: number; days: number; min_extra_usd: number; min_age_days: number; tvl_multiple: number; tvl_stability: number; cold_usd_per_day: number; cold_min_days: number }
export interface SwitchInput {
  held: DailyReplay; alts: AltPool[]; depositUsd: number
  weekdayPace: number | null      // 實收：最近幾個交易日的平均已賺手續費（週末排除）；null = 資料不足
  tradingDaysHeld: number         // 有實收資料的交易日數
  inRange: boolean; cfg: SwitchCfg
}
export type SwitchVerdict = 'consider' | 'watch' | 'stay' | 'cold' | 'no_data'
export interface AltResult { poolId: string; label: string; heldPerDay: number; altPerDay: number; extraPerDay: number; daysAbove: number; commonDays: number; reasons: string[] }
export interface SwitchHint { verdict: SwitchVerdict; heldDays: number; best: AltResult | null; altsPending: number }

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
/** 替代池不夠穩的原因；空陣列 = 穩，可以說「考慮換」 */
export function stabilityReasons(a: AltPool, depositUsd: number, cfg: SwitchCfg): string[] {
  const r: string[] = []
  if (a.hookKind !== 'none') r.push('hook')
  if (a.ageDays === null || a.ageDays < cfg.min_age_days) r.push('新池')
  if (a.tvlNow === null || a.tvlNow < depositUsd * cfg.tvl_multiple) r.push('TVL小')
  if (a.tvlMin7 === null || a.tvlMax7 === null || a.tvlMax7 <= 0 || a.tvlMin7 < a.tvlMax7 * cfg.tvl_stability) r.push('TVL不穩')
  return r
}
export function compareAlt(held: DailyReplay, a: AltPool, depositUsd: number, cfg: SwitchCfg): AltResult | null {
  const common = [...held.keys()].filter(d => a.daily.has(d)).sort()
  if (common.length < cfg.days) return null
  const h = common.map(d => held.get(d) as number), x = common.map(d => a.daily.get(d) as number)
  const daysAbove = common.filter((_, i) => x[i] > 0 && x[i] >= cfg.ratio * h[i]).length
  const heldPerDay = mean(h), altPerDay = mean(x)
  return { poolId: a.poolId, label: a.label, heldPerDay, altPerDay, extraPerDay: altPerDay - heldPerDay, daysAbove, commonDays: common.length, reasons: stabilityReasons(a, depositUsd, cfg) }
}
export function switchHint(i: SwitchInput): SwitchHint {
  const heldDays = i.held.size
  if (heldDays < i.cfg.days) return { verdict: 'no_data', heldDays, best: null, altsPending: 0 }
  const results = i.alts.map(a => compareAlt(i.held, a, i.depositUsd, i.cfg))
  const altsPending = results.filter(r => r === null).length
  const ok = results.filter((r): r is AltResult => r !== null)
  // 候選：同一批交易日裡至少 cfg.days 天 ≥ ratio 倍，且平均每天多 ≥ min_extra_usd
  const cand = ok.filter(r => r.daysAbove >= i.cfg.days && r.extraPerDay >= i.cfg.min_extra_usd).sort((a, b) => b.extraPerDay - a.extraPerDay)
  const stable = cand.filter(r => !r.reasons.length)
  if (stable.length) return { verdict: 'consider', heldDays, best: stable[0], altsPending }
  if (cand.length) return { verdict: 'watch', heldDays, best: cand[0], altsPending }
  const best = [...ok].sort((a, b) => b.extraPerDay - a.extraPerDay)[0] ?? null
  const cold = i.inRange && i.weekdayPace !== null && i.tradingDaysHeld >= i.cfg.cold_min_days && i.weekdayPace < i.cfg.cold_usd_per_day
  if (cold) return { verdict: altsPending ? 'no_data' : 'cold', heldDays, best, altsPending }   // 還有比不了的池時不下「冷」的結論
  return { verdict: 'stay', heldDays, best, altsPending }
}
/** 日報 / 卡片用的短字 */
export function formatSwitchHint(h: SwitchHint | null | undefined): string {
  if (!h) return ''
  const extra = (r: AltResult) => `你的區間重放多 $${r.extraPerDay.toFixed(2)}/日`
  if (h.verdict === 'consider' && h.best) return `⚖️ 考慮換 → ${h.best.label}（${extra(h.best)}）`
  if (h.verdict === 'watch' && h.best) return `⚖️ 觀察 → ${h.best.label}⚠️${h.best.reasons.join('·')}（${extra(h.best)}）`
  if (h.verdict === 'cold') return '⚖️ 量已冷'
  if (h.verdict === 'no_data') return '⚖️ 待累積'
  return '⚖️ 留'
}

// ---- 輸入資料的組裝（純函式，queries.ts 呼叫）----
import { simulateWithCapital, type SimHour } from './simulate.js'
/** UTC 週一到週五（Robinhood 24/5 在 EDT 時剛好是 UTC 週一 00:00 到週六 00:00） */
export const isUsTradingUtcDay = (ymd: string) => { const w = new Date(ymd + 'T00:00:00Z').getUTCDay(); return w >= 1 && w <= 5 }
const utcDay = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10)
/** 快照日 S（台北）大致涵蓋 UTC 的 S−1 那一天（07:30 台北 = 前一天 23:30 UTC） */
export const snapshotToUtcDay = (snapDate: string) => new Date(Date.parse(snapDate + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10)
/** 用頭寸的區間與金額在一個池的逐小時資料上重放，回傳「交易日 → 當天模擬手續費」。只保留 validUtcDays 裡的日子 */
export function replayDaily(hours: SimHour[], capital: number, Pl: number, Pu: number, validUtcDays: Set<string>): DailyReplay {
  const rows = simulateWithCapital(hours, capital, Pl, Pu, [])
  const out: DailyReplay = new Map(); let prev = 0
  rows.forEach(r => { const d = utcDay(r.ts); const fee = r.cumFees - prev; prev = r.cumFees
    if (validUtcDays.has(d) && isUsTradingUtcDay(d)) out.set(d, (out.get(d) ?? 0) + fee) })
  for (const d of validUtcDays) if (isUsTradingUtcDay(d) && !out.has(d)) out.set(d, 0)   // 資料完整但整天沒成交 = 有效的 0
  return out
}
/** 實收費速（只算交易日）：相鄰兩天快照的已賺差，快照日 S 對應 UTC S−1 是交易日才算；回傳最近 n 個的平均與總交易日數 */
export function weekdayPace(snaps: { date: string; earned: number }[], n = 5): { pace: number | null; days: number } {
  const diffs: number[] = []
  for (let k = 1; k < snaps.length; k++) {
    const a = snaps[k - 1], b = snaps[k]
    if (Date.parse(b.date) - Date.parse(a.date) !== 86400000) continue
    if (!isUsTradingUtcDay(snapshotToUtcDay(b.date))) continue
    diffs.push(b.earned - a.earned)
  }
  const last = diffs.slice(-n)
  return { pace: last.length >= 3 ? last.reduce((x, y) => x + y, 0) / last.length : null, days: diffs.length }
}
