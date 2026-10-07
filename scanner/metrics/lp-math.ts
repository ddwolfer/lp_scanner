// scanner/metrics/lp-math.ts — Uniswap v3/v4 集中流動性公式，純函式。X = 股票代幣，Y = USDG，P = X 以 Y 計價
// 區間內：x = L(1/√P − 1/√Pu)，y = L(√P − √Pl)，V = L(2√P − √Pl − P/√Pu)
// L_raw = L_human × 1e12（股票 18 decimals、USDG 6 decimals；推導見 docs/superpowers/plans/2026-09-03-p2-simulation.md Task 1）
export const L_HUMAN_TO_RAW = 1e12
export function liquidityForDeposit(D: number, P0: number, Pl: number, Pu: number): number {
  const s0 = Math.sqrt(P0), sl = Math.sqrt(Pl), su = Math.sqrt(Pu)
  // D71：開倉價在區間外時只會存單一邊。原公式 2√P0 − √Pl − P0/√Pu 只在區間內成立，價格在上方時會高估流動性（10/8 SPCX 148–158 @167.6 高估約 2.5%）
  if (P0 >= Pu) return D / (su - sl)                    // 全部 USDG：價值 = L(√Pu − √Pl)
  if (P0 <= Pl) return D / (P0 * (1 / sl - 1 / su))      // 全部股票：價值 = P0 · L(1/√Pl − 1/√Pu)
  return D / (2 * s0 - sl - P0 / su)
}
export function positionAmounts(L: number, P: number, Pl: number, Pu: number): { x: number; y: number } {
  const sl = Math.sqrt(Pl), su = Math.sqrt(Pu)
  if (P <= Pl) return { x: L * (1 / sl - 1 / su), y: 0 }
  if (P >= Pu) return { x: 0, y: L * (su - sl) }
  const s = Math.sqrt(P)
  return { x: L * (1 / s - 1 / su), y: L * (s - sl) }
}
export function positionValue(L: number, P: number, Pl: number, Pu: number): number {
  const { x, y } = positionAmounts(L, P, Pl, Pu)
  return x * P + y
}
