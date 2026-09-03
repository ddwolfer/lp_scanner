import { it, expect, vi } from 'vitest'
import { fetchTokenPairs } from '../scanner/sources/dexscreener.js'
import { ApiUsage } from '../scanner/sources/usage.js'
it('正規化 DexScreener pair', async () => {
  const f = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ([{ dexId: 'uniswap', labels: ['v4'], pairAddress: '0xB6A8', baseToken: { address: '0x98E7', symbol: 'SOFI' }, quoteToken: { address: '0x5FC5', symbol: 'USDG' }, liquidity: { usd: 20118.99 }, volume: { h24: 81472.42 }, priceUsd: '17.42' }]) }) as any
  const p = await fetchTokenPairs({ usage: new ApiUsage(), fetchImpl: f, minIntervalMs: 0 }, '0x98E7')
  expect(f.mock.calls[0][0]).toBe('https://api.dexscreener.com/token-pairs/v1/robinhood/0x98e7')
  expect(p[0]).toEqual({ pairId: '0xb6a8', dexId: 'uniswap', labels: ['v4'], baseToken: { address: '0x98e7', symbol: 'SOFI' }, quoteToken: { address: '0x5fc5', symbol: 'USDG' }, liquidityUsd: 20118.99, volume24hUsd: 81472.42, priceUsd: 17.42 })
})
