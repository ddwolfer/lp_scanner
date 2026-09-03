import { it, expect } from 'vitest'
import { openDb, getMeta, setMeta } from '../db/index.js'
it('建表後可以寫入 tokens 與 pools', () => {
  const db = openDb(':memory:')
  db.prepare(`INSERT INTO tokens(address,symbol,decimals,kind) VALUES (?,?,?,?)`).run('0xabc', 'SOFI', 18, 'stock'); db.prepare(`INSERT INTO tokens(address,symbol,decimals,kind) VALUES (?,?,?,?)`).run('0xusdg', 'USDG', 6, 'stable')
  db.prepare(`INSERT INTO pools(pool_id,protocol,token0,token1,fee_ppm,tick_spacing,hooks,quote_kind,stock_is_token0)
              VALUES (?,?,?,?,?,?,?,?,?)`).run('0x01', 'v4', '0xabc', '0xusdg', 30000, 60, '0x0000000000000000000000000000000000000000', 'usdg', 1)
  expect(db.prepare('SELECT COUNT(*) c FROM pools').get()).toEqual({ c: 1 })
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all().map((r: any) => r.name)
  expect(tables).toEqual(expect.arrayContaining(['tokens','pools','pool_snapshots','pool_hourly','corporate_actions','positions','position_snapshots','scan_runs','meta']))
})
it('openDb 可重複呼叫，meta 可讀寫', () => {
  const db = openDb(':memory:'); expect(() => openDb(':memory:')).not.toThrow()
  setMeta(db, 'k', '1'); setMeta(db, 'k', '2'); expect(getMeta(db, 'k')).toBe('2'); expect(getMeta(db, 'x')).toBeUndefined(); db.close()
})
