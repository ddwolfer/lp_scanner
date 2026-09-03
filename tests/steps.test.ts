import { it, expect } from 'vitest'
import { openDb } from '../db/index.js'
import { upsertTokens, upsertPools, writeSnapshot, previousCandidates, recentVolumes } from '../scanner/steps.js'
const asset = { id: 'a1', tokenSymbol: 'SOFI', tokenName: 'SoFi', address: '0xsofi', currentMultiplier: '1', pendingMultiplier: '', status: 'ASSET_STATUS_ACTIVE', allDayTradable: true, tokenDecimals: 18, raw: {} }
const usdg = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
const zero = '0x0000000000000000000000000000000000000000'
it('upsertTokens 寫入股票與 USDG，重複呼叫更新', () => {
  const db = openDb(':memory:'); upsertTokens(db, [asset], '2026-09-03'); upsertTokens(db, [{ ...asset, status: 'X' }], '2026-09-04')
  expect(db.prepare('SELECT kind, rh_status, first_seen FROM tokens WHERE address=?').get('0xsofi')).toEqual({ kind: 'stock', rh_status: 'X', first_seen: '2026-09-03' })
  expect((db.prepare(`SELECT kind FROM tokens WHERE kind='stable'`).get() as any).kind).toBe('stable')
})
it('upsertPools 只收股票×USDG，記 stock_is_token0', () => {
  const db = openDb(':memory:'); upsertTokens(db, [asset], '2026-09-03')
  const n = upsertPools(db, [
    { poolId: '0x1', currency0: '0xsofi', currency1: usdg, feeRaw: 30000, feePpm: 30000, tickSpacing: 60, hooks: zero, createdBlock: 10n },
    { poolId: '0x2', currency0: '0xmeme', currency1: usdg, feeRaw: 30000, feePpm: 30000, tickSpacing: 60, hooks: zero, createdBlock: 11n },
    { poolId: '0x3', currency0: usdg, currency1: '0xsofi', feeRaw: 30000, feePpm: 30000, tickSpacing: 60, hooks: zero, createdBlock: 12n },
  ], new Set(['0xsofi']), new Map([['10', '2026-09-01T00:00:00Z']]))
  expect(n).toBe(2)
  expect(db.prepare('SELECT stock_is_token0, created_at FROM pools WHERE pool_id=?').get('0x1')).toEqual({ stock_is_token0: 1, created_at: '2026-09-01T00:00:00Z' })
  expect((db.prepare('SELECT stock_is_token0 s FROM pools WHERE pool_id=?').get('0x3') as any).s).toBe(0)
})
const snap = (pool_id: string, date: string, flags: string[], vol = 0) => ({ pool_id, date, is_weekday: 1, tvl_usd: 1, volume_24h_usd: vol, fees_24h_usd: 0, price_usd: null, price_ref_usd: null, price_dev_pct: null, swap_count: 0, age_days: 1, vol7_avg_usd: 0, vol7_cv: 0, raw_apr: 0, flags, excluded: flags.length ? 1 : 0 })
it('previousCandidates 回前一日未排除池；recentVolumes 依日期升冪', () => {
  const db = openDb(':memory:')
  db.prepare(`INSERT INTO pools(pool_id,protocol) VALUES ('0x1','v4'),('0x2','v4')`).run()
  writeSnapshot(db, snap('0x1', '2026-09-01', [], 10)); writeSnapshot(db, snap('0x1', '2026-09-02', [], 20)); writeSnapshot(db, snap('0x2', '2026-09-02', ['too_new']))
  expect(previousCandidates(db, '2026-09-03')).toEqual(new Set(['0x1']))
  expect(recentVolumes(db, '0x1', '2026-09-03')).toEqual([10, 20])
})
import { loadHourly, updateSim, writeHourly } from '../scanner/steps.js'
it('loadHourly 丟掉開頭 null 價並升冪；updateSim 回寫', () => {
  const db = openDb(':memory:'); db.prepare(`INSERT INTO pools(pool_id,protocol) VALUES ('0x1','v4')`).run()
  writeHourly(db, '0x1', [{ ts: 3600, priceUsd: null, volumeUsd: 0, feesUsd: 0, liquidity: null, swapCount: 0 }, { ts: 7200, priceUsd: 10, volumeUsd: 1, feesUsd: 0.1, liquidity: '5', swapCount: 1 }, { ts: 10800, priceUsd: 11, volumeUsd: 0, feesUsd: 0, liquidity: '5', swapCount: 0 }])
  expect(loadHourly(db, '0x1')).toEqual([{ ts: 7200, priceUsd: 10, feesUsd: 0.1, liquidity: '5' }, { ts: 10800, priceUsd: 11, feesUsd: 0, liquidity: '5' }])
  writeSnapshot(db, snap('0x1', '2026-09-03', []))
  updateSim(db, '0x1', '2026-09-03', { meta: {} } as any, 0.5, ['rvol_fallback'])
  expect(db.prepare('SELECT score, flags, sim FROM pool_snapshots WHERE pool_id=? AND date=?').get('0x1', '2026-09-03')).toEqual({ score: 0.5, flags: '["rvol_fallback"]', sim: '{"meta":{}}' })
})
