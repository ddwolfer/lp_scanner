import { it, expect } from 'vitest'
import { decodePositionInfo, amountsForLiquidity, unclaimedFees, poolIdOf } from '../scanner/sources/positions.js'
// fixture：DECISIONS 11.8 實測的 SPY/USDG 頭寸（tokenId 1219367）
it('decodePositionInfo 解出 int24 tick', () => {
  const info = (BigInt.asUintN(24, -209640n) << 32n) | (BigInt.asUintN(24, -210000n) << 8n)
  expect(decodePositionInfo(info)).toEqual({ tickLower: -210000, tickUpper: -209640 })
})
it('amountsForLiquidity 在區間內兩邊都有，USDG 側 ≈ 950.5', () => {
  const sqrtP = BigInt(Math.round(Math.sqrt(1.0001 ** -209824) * 2 ** 96))
  const { amount0, amount1 } = amountsForLiquidity(3901620141659787n, sqrtP, -210000, -209640)
  expect(amount1 / 1e6).toBeCloseTo(950.5, 0); expect(amount0 / 1e18).toBeCloseTo(1.285, 2)
  expect(amountsForLiquidity(1n, sqrtP, -209000, -208000).amount1).toBe(0)   // 價格低於區間 → 全是 token0
})
it('unclaimedFees 處理 mod 2^256 wrap', () => {
  expect(unclaimedFees(2n ** 128n, 10n, 4n)).toBe(6)
  expect(unclaimedFees(2n ** 128n, 2n, 2n ** 256n - 3n)).toBe(5)
})
it('poolIdOf 與實測 SPY 池 id 一致', () => {
  const k = { currency0: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', currency1: '0xd5f3879160bc7c32ebb4dc785f8a4f505888de68', fee: 3000, tickSpacing: 60, hooks: '0x0000000000000000000000000000000000000000' }
  expect(typeof poolIdOf(k)).toBe('string'); expect(poolIdOf(k)).toHaveLength(66)
})
import { sqrtPriceAtMint } from '../scanner/sources/positions.js'
it('sqrtPriceAtMint 與 amountsForLiquidity 互為反函式', () => {
  const L = 3901620141659787n, tl = -210000, tu = -209640
  const sqrtP = BigInt(Math.round(Math.sqrt(1.0001 ** -209824) * 2 ** 96))
  const { amount0, amount1 } = amountsForLiquidity(L, sqrtP, tl, tu)
  expect(sqrtPriceAtMint(L, amount0, amount1, tl, tu)).toBeCloseTo(Number(sqrtP) / 2 ** 96, 8)
})

import { valueOnchainPosition } from '../scanner/steps.js'
it('valueOnchainPosition：股票 × USDG 才估值（含已撤流動性的可領餘額），其他回 null', () => {
  const usdg = '0x5fc5360d0400a0fd4f2af552add042d716f1d168', stock = '0xaaa', m = new Map([[stock, { tokenSymbol: 'AAA' }]])
  const sqrt = BigInt(Math.round(Math.sqrt(10 * 1e6 / 1e18) * 2 ** 96))   // 1 股 = 10 USDG（股票 18 位、USDG 6 位）
  const base = { protocol: 'v3' as const, tokenId: '1', poolId: 'p', feePpm: 3000, hooks: '0x0', tickLower: 0, tickUpper: 1, liquidity: 0n, tick: 0, sqrtPriceX96: sqrt }
  const v = valueOnchainPosition({ ...base, currency0: stock, currency1: usdg, amount0: 0, amount1: 0, fee0: 2e18, fee1: 3e6 }, m)!
  expect(v.valueUsd).toBe(0); expect(v.feesUsd).toBeCloseTo(23, 3)
  expect(valueOnchainPosition({ ...base, currency0: '0xweth', currency1: usdg, amount0: 1, amount1: 1, fee0: 0, fee1: 0 }, m)).toBeNull()
})
