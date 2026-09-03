// scanner/metrics/volatility.ts — §7.1 σ₇（週波動率），純函式
export function weeklySigma(prices: (number | null)[]): number | null {
  const p = prices.slice(-168).filter((v): v is number => v !== null && v > 0)
  if (p.length < 120) return null
  const r: number[] = []; for (let i = 1; i < p.length; i++) r.push(Math.log(p[i] / p[i - 1]))
  const m = r.reduce((a, b) => a + b, 0) / r.length
  const sd = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / r.length)
  return sd * Math.sqrt(24 * 7)
}
export function rvolRange(sigma: number | null): { R: number; fallback: boolean } {
  if (sigma === null) return { R: 0.25, fallback: true }
  return { R: Math.min(0.40, Math.max(0.05, 2 * sigma)), fallback: false }
}
