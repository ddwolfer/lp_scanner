// scanner/notify/summary.ts — SPEC §13 格式，純函式
export interface SummaryInput {
  date: string; weekdayZh: string; poolsScanned: number; candidates: number
  top: { label: string; feePct: string; rawApr: number; tvlUsd: number; traderCount: number | null }[]
  changes: { label: string; kind: 'dropped' | 'added'; reason?: string }[]
  positions: string[]
}
const usd = (n: number) => '$' + Math.round(n).toLocaleString('en-US')
export function formatDailySummary(i: SummaryInput): string {
  const lines = [`📊 LP 掃描 ${i.date} (${i.weekdayZh})`, `掃描 ${i.poolsScanned} 池，候選 ${i.candidates}`, '', 'Top 5 (P1：原始 APR = 24h 手續費 × 365 / TVL)']
  i.top.slice(0, 5).forEach((t, n) => lines.push(`${n + 1}. ${t.label} ${t.feePct}  原始 APR ${Math.round(t.rawApr * 100)}%  TVL ${usd(t.tvlUsd)}  交易者 ${t.traderCount ?? '—'}`))
  if (!i.top.length) lines.push('（今日無候選）')
  lines.push('', '⚠️ 異動')
  if (!i.changes.length) lines.push('- 無')
  for (const c of i.changes) lines.push(c.kind === 'dropped' ? `- ${c.label} 掉出候選: ${c.reason ?? ''}`.trimEnd() : `- ${c.label} 新進候選`)
  lines.push('', '💼 我的頭寸', ...(i.positions.length ? i.positions.map(p => `- ${p}`) : ['- 無']))
  return lines.join('\n')
}
