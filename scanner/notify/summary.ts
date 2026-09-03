// scanner/notify/summary.ts — SPEC §13 格式，純函式
export interface SummaryInput {
  date: string; weekdayZh: string; poolsScanned: number; candidates: number; sortKey: string
  top: { label: string; feePct: string; netApr: number | null; inRangePct: number | null; traderCount: number | null }[]
  changes: { label: string; kind: 'dropped' | 'added'; reason?: string }[]
  positions: string[]
}
/** 'd1000.r25' → '投入 $1000, ±25%'；'d1000.rvol' → '投入 $1000, vol' */
export function describeSortKey(k: string): string {
  const [d, r] = k.split('.'); const dep = '$' + d.replace('d', ''); const rng = r === 'rvol' ? 'vol' : '±' + r.replace('r', '') + '%'
  return `投入 ${dep}, ${rng}`
}
const pct = (v: number | null) => v === null ? '—' : Math.round(v * 100) + '%'
export function formatDailySummary(i: SummaryInput): string {
  const lines = [`📊 LP 掃描 ${i.date} (${i.weekdayZh})`, `掃描 ${i.poolsScanned} 池，候選 ${i.candidates}`, '', `Top 5 (${describeSortKey(i.sortKey)})`]
  i.top.slice(0, 5).forEach((t, n) => lines.push(`${n + 1}. ${t.label} ${t.feePct}  net APR ${pct(t.netApr)}  在區間 ${pct(t.inRangePct)}  交易者 ${t.traderCount ?? '—'}`))
  if (!i.top.length) lines.push('（今日無候選）')
  lines.push('', '⚠️ 異動')
  if (!i.changes.length) lines.push('- 無')
  for (const c of i.changes) lines.push(c.kind === 'dropped' ? `- ${c.label} 掉出候選: ${c.reason ?? ''}`.trimEnd() : `- ${c.label} 新進候選`)
  lines.push('', '💼 我的頭寸', ...(i.positions.length ? i.positions.map(p => `- ${p}`) : ['- 無']))
  return lines.join('\n')
}
