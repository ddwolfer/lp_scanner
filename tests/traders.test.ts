import { it, expect, vi } from 'vitest'
import { resolveTxFrom, makeTraderRpc } from '../scanner/sources/traders.js'
import { ApiUsage } from '../scanner/sources/usage.js'
it('resolveTxFrom 去重並 lowercase', async () => {
  const getTransaction = vi.fn(async ({ hash }: any) => ({ from: '0xABC' + hash.slice(-1) }))
  const rpc = { call: (fn: any) => fn(), client: { getTransaction } } as any
  const m = await resolveTxFrom(rpc, ['0x1', '0x1', '0x2'])
  expect(getTransaction).toHaveBeenCalledTimes(2)
  expect(m.get('0x1')).toBe('0xabc1'); expect(m.get('0x2')).toBe('0xabc2')
})
it('makeTraderRpc 依 key 決定來源', () => {
  expect(makeTraderRpc(new ApiUsage(), 'k').isAlchemy).toBe(true)
  expect(makeTraderRpc(new ApiUsage(), undefined).isAlchemy).toBe(false)
})
