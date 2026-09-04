import { it, expect } from 'vitest'
import { decodePoolCreated } from '../scanner/sources/uniswapV3.js'
it('decodePoolCreated → DiscoveredPool(v3)', () => {
  const d = decodePoolCreated({ args: { token0: '0xAAA', token1: '0x5FC5', fee: 10000, tickSpacing: 200, pool: '0xPOOL' }, blockNumber: 5n } as any)
  expect(d).toMatchObject({ protocol: 'v3', poolId: '0xpool', currency0: '0xaaa', feePpm: 10000, tickSpacing: 200, hooks: '0x0000000000000000000000000000000000000000', createdBlock: 5n })
})
