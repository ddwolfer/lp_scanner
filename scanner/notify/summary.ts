// scanner/notify/summary.ts — SPEC §13 格式，純函式
export interface SummaryInput {
  date: string; weekdayZh: string; poolsScanned: number; candidates: number; sortKey: string
  top: { label: string; feePct: string; netApr: number | null; inRangePct: number | null; traderCount: number | null }[]
  changes: { label: string; kind: 'dropped' | 'added'; reason?: string }[]
  positions: string[]
  dashboardUrl?: string
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
  // 異動段不再列出（dashboard 的昨→今箭頭有），只留 Top 5 + 頭寸 + 連結
  if (i.positions.length) lines.push('', '💼 我的頭寸', ...i.positions.flatMap(p => p.startsWith('Σ') ? ['', p] : p.startsWith('  ') || p.startsWith('年化') || p.startsWith('錢包') || p.startsWith('⚠️ 錢包') ? [p] : [`- ${p}`]))   // 合計行（D66）前空一行；合計、年化與縮排提示行（D65）不加 bullet
  if (i.dashboardUrl) lines.push('', `📈 ${i.dashboardUrl}`)
  return lines.join('\n')
}

/** D75：只有頭寸的日報（週末或外出時，不跑完整掃描）。positions 與 formatDailySummary 同格式：頭寸行加 bullet，Σ 前空一行 */
export function formatPositionsOnly(i: { date: string; weekdayZh: string; positions: string[]; note?: string; dashboardUrl?: string }): string {
  const lines = [`📊 LP 頭寸日報 ${i.date} (${i.weekdayZh})`, ...(i.note ? [i.note] : []), '', '💼 我的頭寸',
    ...i.positions.flatMap(p => p.startsWith('Σ') ? ['', p] : p.startsWith('  ') || p.startsWith('年化') || p.startsWith('錢包') || p.startsWith('⚠️ 錢包') ? [p] : [`- ${p}`])]
  if (i.dashboardUrl) lines.push('', `📈 ${i.dashboardUrl}`)
  return lines.join('\n')
}
