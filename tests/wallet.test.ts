import { expect, it } from 'vitest'
import { openDb } from '../db/index.js'
import { walletValue, MULTICALL3 } from '../scanner/sources/wallet.js'
it('walletValue 用指定的 Multicall3 地址在快照區塊讀所有白名單代幣；沒價格列入 missing', async () => {
  const db = openDb(':memory:')
  db.prepare(`INSERT INTO tokens(address,symbol,kind) VALUES ('0xaaa0000000000000000000000000000000000001','AAA','stock'),('0xbbb0000000000000000000000000000000000002','BBB','stock'),('0x5fc5360d0400a0fd4f2af552add042d716f1d168','USDG','stable')`).run()
  db.prepare(`INSERT INTO pools(pool_id,protocol,token0,token1,fee_ppm,hooks,stock_is_token0) VALUES ('p1','v4','0xaaa0000000000000000000000000000000000001','0x5fc5360d0400a0fd4f2af552add042d716f1d168',3000,'0x0',1)`).run()
  db.prepare(`INSERT INTO pool_snapshots(pool_id,date,price_usd,volume_24h_usd,flags,excluded) VALUES ('p1','2026-10-07',10,1,'[]',0)`).run()
  let seen: any = null
  const rpc: any = { call: (f: any) => f(), client: { multicall: async (o: any) => { seen = o; return [5_000_000n, 2n * 10n ** 18n, 10n ** 18n] } } }
  const w = await walletValue(rpc, db, '0x18a080b0e02eb2017c860d9444c504fcfd29454f', 123n)
  expect(seen.multicallAddress).toBe(MULTICALL3); expect(seen.blockNumber).toBe(123n); expect(seen.contracts).toHaveLength(3)   // USDG + 兩個白名單股票
  expect(w.usd).toBeCloseTo(5 + 20); expect(w.missing).toEqual(['BBB'])
})

import { alchemyCall } from '../scanner/sources/wallet.js'
import { ApiUsage } from '../scanner/sources/usage.js'
it('alchemyCall：POST、遇 429 重試、計入 alchemy 用量', async () => {
  let n = 0; const usage = new ApiUsage()
  const f: any = async (_u: string, init: any) => { n++; expect(init.method).toBe('POST'); return n === 1 ? { ok: false, status: 429 } : { ok: true, status: 200, json: async () => ({ result: '0x10' }) } }
  expect(await alchemyCall('k', usage, f)('eth_blockNumber', [])).toBe('0x10')
  expect(n).toBe(2); expect(usage.toJSON().alchemy).toBe(2)
})

it('walletValue：multicall 失敗直接丟出，不回傳部分餘額', async () => {
  const db = openDb(':memory:')
  const rpc: any = { call: (f: any) => f(), client: { multicall: async () => { throw new Error('HTTP 429') } } }
  await expect(walletValue(rpc, db, '0x18a080b0e02eb2017c860d9444c504fcfd29454f', 1n)).rejects.toThrow('429')
})
