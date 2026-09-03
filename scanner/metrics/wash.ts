// scanner/metrics/wash.ts — 沿用 analyze-pool.mjs 的定義（SPEC §6.2），純函式
export interface WashSwap { trader: string; ts: number; dir: 'buy' | 'sell'; volumeUsd: number }
export interface WashMetrics { traderCount: number; top1Share: number; pingpongRatio: number; lpTraderOverlap: number; lpOverlapVolumeShare: number; topTraders: { addr: string; n: number; buy: number; sell: number; share: number }[]; hourly: Record<string, number> }
export function analyzeWash(swaps: WashSwap[], lpAddrs: Set<string>): WashMetrics {
  if (!swaps.length) return { traderCount: 0, top1Share: 0, pingpongRatio: 0, lpTraderOverlap: 0, lpOverlapVolumeShare: 0, topTraders: [], hourly: {} }
  const by = new Map<string, { n: number; buy: number; sell: number; vol: number }>()
  let total = 0
  for (const s of swaps) { const t = by.get(s.trader) ?? { n: 0, buy: 0, sell: 0, vol: 0 }; t.n++; s.dir === 'buy' ? t.buy++ : t.sell++; t.vol += s.volumeUsd; total += s.volumeUsd; by.set(s.trader, t) }
  const sorted = [...by.entries()].sort((a, b) => b[1].vol - a[1].vol)
  const share = (v: number) => total > 0 ? v / total : 0
  // 對打：同地址相鄰兩筆方向相反且間隔 < 10 分鐘
  const rows = [...swaps].sort((a, b) => a.ts - b.ts); const last = new Map<string, WashSwap>(); let pp = 0
  for (const r of rows) { const p = last.get(r.trader); if (p && p.dir !== r.dir && r.ts - p.ts < 600) pp++; last.set(r.trader, r) }
  const hourly: Record<string, number> = {}
  for (const r of rows) { const h = new Date(r.ts * 1000).toISOString().slice(0, 13); hourly[h] = (hourly[h] ?? 0) + 1 }
  const overlap = sorted.filter(([a]) => lpAddrs.has(a))
  return { traderCount: by.size, top1Share: share(sorted[0][1].vol), pingpongRatio: pp / rows.length, lpTraderOverlap: overlap.length,
    lpOverlapVolumeShare: share(overlap.reduce((s, [, t]) => s + t.vol, 0)),
    topTraders: sorted.slice(0, 5).map(([addr, t]) => ({ addr, n: t.n, buy: t.buy, sell: t.sell, share: share(t.vol) })), hourly }
}
