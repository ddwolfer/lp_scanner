import { it, expect } from 'vitest'
import { hookInfo, median } from '../scanner/metrics/hooks.js'
it('零地址 → none', () => { expect(hookInfo('0x0000000000000000000000000000000000000000')).toEqual({ kind: 'none', flags: [] }) })
it('GLD 主池 hook …a080 → 只有 initialize/beforeSwap → fee_only', () => {
  expect(hookInfo('0xb608a78761f179f7c56f15e7d13921b92f00a080')).toEqual({ kind: 'fee_only', flags: ['beforeInitialize', 'beforeSwap'] })
})
it('PONS hook …a880 → 含 beforeAddLiquidity → liquidity', () => {
  const h = hookInfo('0x1191Ac2561817686EFE4296B37BA5a5419Eaa880'); expect(h.kind).toBe('liquidity'); expect(h.flags).toContain('beforeAddLiquidity')
})
it('…45c7 → 改帳位 → liquidity', () => { expect(hookInfo('0xda480d75634ff885203225f6db37126d8ef245c7').kind).toBe('liquidity') })
it('median', () => { expect(median([3, 1, 2])).toBe(2); expect(median([1, 2, 3, 4])).toBe(2.5); expect(median([])).toBeNull() })
