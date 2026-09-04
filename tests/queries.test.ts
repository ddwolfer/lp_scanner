import { it, expect } from 'vitest'
import { openDb } from '../db/index.js'
import { getDates, getOverview, getPool, createPosition, closePosition, listPositions, addJournal, listJournal, exportPositions } from '../server/queries.js'
import { readFileSync, rmSync } from 'node:fs'
import { writeSnapshot, writeHourly, updateSim } from '../scanner/steps.js'
function seed() {
  const db = openDb(':memory:')
  db.prepare(`INSERT INTO tokens(address,symbol,kind) VALUES ('0xsofi','SOFI','stock'),('0xusdg','USDG','stable')`).run()
  db.prepare(`INSERT INTO pools(pool_id,protocol,token0,token1,fee_ppm,hooks,stock_is_token0,created_at) VALUES ('0x1','v4','0xsofi','0xusdg',30000,'0x0',1,'2026-08-01'),('0x2','v4','0xusdg','0xsofi',30000,'0x0',0,'2026-08-01')`).run()
  const base = { is_weekday: 1, tvl_usd: 10000, volume_24h_usd: 100, fees_24h_usd: 3, price_usd: 10, price_ref_usd: 10, price_dev_pct: 0, swap_count: 5, age_days: 30, vol7_avg_usd: 100, vol7_cv: 0, raw_apr: 0.1, flags: [] as string[], excluded: 0 }
  for (const [pid, d, sc] of [['0x1', '2026-09-01', 0.9], ['0x2', '2026-09-01', 0.5], ['0x1', '2026-09-02', 0.4], ['0x2', '2026-09-02', 0.8]] as const) {
    writeSnapshot(db, { ...base, pool_id: pid, date: d }); updateSim(db, pid, d, { meta: {} } as any, sc, [])
  }
  return db
}
it('getDates / getOverview 排名與昨日排名', () => {
  const db = seed()
  expect(getDates(db)).toEqual(['2026-09-02', '2026-09-01'])
  const o = getOverview(db, '2026-09-02'); const p1 = o.find(r => r.pool_id === '0x1')!, p2 = o.find(r => r.pool_id === '0x2')!
  expect(p1).toMatchObject({ symbol: 'SOFI', rank_today: 2, rank_prev: 1 }); expect(p2).toMatchObject({ rank_today: 1, rank_prev: 2 })
})
it('getPool 含快照與曲線；找不到回 null', () => {
  const db = seed()
  writeHourly(db, '0x1', [0, 1, 2].map(i => ({ ts: 3600 * i, priceUsd: 10, volumeUsd: 1, feesUsd: 0.1, liquidity: '1', swapCount: 1 })))
  const r = getPool(db, '0x1')!
  expect(r.pool.symbol).toBe('SOFI'); expect(r.snapshots).toHaveLength(2); expect(r.curves!.r25).toHaveLength(3)
  expect(getPool(db, '0xnope')).toBeNull()
})
it('頭寸建立、估算、關閉', () => {
  const db = seed()
  writeHourly(db, '0x1', [0, 1, 2].map(i => ({ ts: 1_700_000_000 + 3600 * i, priceUsd: 10, volumeUsd: 100, feesUsd: 1, liquidity: '1', swapCount: 1 })))
  const id = createPosition(db, { pool_id: '0x1', label: 'test', range_lower: 7.5, range_upper: 12.5, deposit_usd: 1000, opened_at: new Date(1_700_000_000 * 1000).toISOString() })
  const [p] = listPositions(db)
  expect(p.id).toBe(id); expect(p.est!.in_range).toBe(true); expect(p.est!.fees_cum_usd).toBeGreaterThan(0); expect(p.curve).toHaveLength(3)
  closePosition(db, id, { closed_at: '2026-09-02T00:00:00Z', fees_final_usd: 5, value_final_usd: 990 })
  expect(listPositions(db)[0].final).toEqual({ value_usd: 990, fees_cum_usd: 5 })
})

it('日誌與 JSON 匯出', () => {
  const db = seed()
  const id = createPosition(db, { pool_id: '0x1', label: 'j', range_lower: 7.5, range_upper: 12.5, deposit_usd: 1000, opened_at: '2026-09-01T00:00:00Z' })
  addJournal(db, id, 'open', '看報告排第一，區間 ±25%', { rank: 1 })
  expect(listJournal(db, id)[0]).toMatchObject({ kind: 'open', data: { rank: 1 } })
  const dir = '/private/tmp/claude-501/-Users-pochenkuo-AI-lp-scanner/3221afde-47cf-42bb-8108-dd8ee7c30d12/scratchpad/export-test'
  const files = exportPositions(db, dir)
  expect(files).toHaveLength(1)
  const j = JSON.parse(readFileSync(files[0], 'utf8'))
  expect(j.label).toBe('j'); expect(j.journal).toHaveLength(1); expect(j.range_usd).toEqual([7.5, 12.5])
  rmSync(dir, { recursive: true, force: true })
})
