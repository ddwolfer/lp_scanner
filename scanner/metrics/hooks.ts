// scanner/metrics/hooks.ts — 由 v4 hook 地址最後 14 bit 解出它可介入的時機（部署時固定，不可變）。純函式（DECISIONS D36）
export const HOOK_BITS: { bit: number; key: string; zh: string; group: 'swap' | 'liquidity' | 'delta' }[] = [
  { bit: 13, key: 'beforeInitialize', zh: '初始化前', group: 'swap' },
  { bit: 12, key: 'afterInitialize', zh: '初始化後', group: 'swap' },
  { bit: 11, key: 'beforeAddLiquidity', zh: '加流動性前', group: 'liquidity' },
  { bit: 10, key: 'afterAddLiquidity', zh: '加流動性後', group: 'liquidity' },
  { bit: 9, key: 'beforeRemoveLiquidity', zh: '移除流動性前', group: 'liquidity' },
  { bit: 8, key: 'afterRemoveLiquidity', zh: '移除流動性後', group: 'liquidity' },
  { bit: 7, key: 'beforeSwap', zh: '交易前', group: 'swap' },
  { bit: 6, key: 'afterSwap', zh: '交易後', group: 'swap' },
  { bit: 5, key: 'beforeDonate', zh: '捐款前', group: 'liquidity' },
  { bit: 4, key: 'afterDonate', zh: '捐款後', group: 'liquidity' },
  { bit: 3, key: 'beforeSwapReturnsDelta', zh: '交易前改帳（可拿走金額）', group: 'delta' },
  { bit: 2, key: 'afterSwapReturnsDelta', zh: '交易後改帳（可拿走金額）', group: 'delta' },
  { bit: 1, key: 'afterAddLiquidityReturnsDelta', zh: '加流動性改帳', group: 'delta' },
  { bit: 0, key: 'afterRemoveLiquidityReturnsDelta', zh: '移除流動性改帳', group: 'delta' },
]
export type HookKind = 'none' | 'fee_only' | 'liquidity'
export interface HookInfo { kind: HookKind; flags: string[] }
export function hookInfo(address: string): HookInfo {
  const a = address.toLowerCase()
  if (/^0x0{40}$/.test(a)) return { kind: 'none', flags: [] }
  const low = parseInt(a.slice(-4), 16) & 0x3fff
  const flags = HOOK_BITS.filter(b => low & (1 << b.bit)).map(b => b.key)
  const touchesFunds = HOOK_BITS.some(b => (low & (1 << b.bit)) && b.group !== 'swap')
  return { kind: touchesFunds ? 'liquidity' : 'fee_only', flags }
}
export function median(xs: number[]): number | null {
  if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
