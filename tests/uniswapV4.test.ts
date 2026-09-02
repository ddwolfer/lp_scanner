import { it, expect } from 'vitest'
import { decodeInitialize } from '../scanner/sources/uniswapV4.js'
import { DYNAMIC_FEE_FLAG } from '../config/chain.js'
const base = { args: { id: '0xAB', currency0: '0x98E7', currency1: '0x5FC5', fee: 32900, tickSpacing: 60, hooks: '0x0000000000000000000000000000000000000000', sqrtPriceX96: 1n, tick: 0 }, blockNumber: 100n } as any
it('固定費率 → feePpm', () => { expect(decodeInitialize(base)).toMatchObject({ poolId: '0xab', currency0: '0x98e7', currency1: '0x5fc5', feePpm: 32900, createdBlock: 100n }) })
it('動態費率 flag → feePpm null', () => { expect(decodeInitialize({ ...base, args: { ...base.args, fee: DYNAMIC_FEE_FLAG } }).feePpm).toBeNull() })
