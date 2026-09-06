// scanner/metrics/derived.ts — §6.2 衍生指標，純函式
export function ageDays(createdAt: string, today: string): number {
  return Math.floor((Date.parse(today + 'T00:00:00Z') - Date.parse(createdAt.slice(0, 10) + 'T00:00:00Z')) / 86_400_000)
}
/** 樣本 < 3 個時 cv 回 null（顯示「—」，評分視為中性 1.0），避免用兩天資料算變異 */
export function vol7(volumes: number[]): { avg: number; cv: number | null; shortHistory: boolean } {
  const v = volumes.slice(-7); if (!v.length) return { avg: 0, cv: null, shortHistory: true }
  const avg = v.reduce((a, b) => a + b, 0) / v.length
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - avg) ** 2, 0) / v.length)
  return { avg, cv: v.length >= 3 && avg > 0 ? sd / avg : v.length >= 3 ? 0 : null, shortHistory: v.length < 7 }
}
/** 池價 × currentMultiplier 後與 Robinhood mid 比（DECISIONS D2） */
export function priceDevPct(poolPrice: number, refMid: number | null, multiplier: number): number | null {
  if (refMid === null || !(refMid > 0)) return null
  return (poolPrice * multiplier - refMid) / refMid
}
