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
  updateSim(db, '0x1', '2026-09-03', { meta: {} } as any, 0.5, ['rvol_fallback', 'rvol_fallback'])
  expect(db.prepare('SELECT score, flags, sim FROM pool_snapshots WHERE pool_id=? AND date=?').get('0x1', '2026-09-03')).toEqual({ score: 0.5, flags: '["rvol_fallback"]', sim: '{"meta":{}}' })
})
import { syncPositions, writePositionSnapshot } from '../scanner/steps.js'
it('syncPositions 建立/更新鏈上頭寸並估值', () => {
  const db = openDb(':memory:'); upsertTokens(db, [asset], '2026-09-04')
  db.prepare(`INSERT INTO pools(pool_id,protocol,token0,token1,fee_ppm,hooks,stock_is_token0) VALUES ('0xp','v4','0xsofi',?,3000,'0x0',1)`).run(usdg)
  const sqrtP = BigInt(Math.round(Math.sqrt(1.0001 ** -209824) * 2 ** 96))   // 股票是 token0（18）、USDG token1（6）：raw 價 × 1e12 ≈ 772.5
  const pos = { tokenId: '1219367', poolId: '0xp', currency0: '0xsofi', currency1: usdg, feePpm: 3000, hooks: '0x0', tickLower: -210000, tickUpper: -209640, liquidity: 3901620141659787n, tick: -209824, sqrtPriceX96: sqrtP, amount0: 1.285e18, amount1: 950.5e6, fee0: 0.0116e18, fee1: 8.29e6 }
  const v = syncPositions(db, [pos], new Map([['0xsofi', { tokenSymbol: 'SOFI' }]]), '2026-09-04T00:00:00Z')
  expect(v).toHaveLength(1); expect(v[0].isNew).toBe(true); expect(v[0].inRange).toBe(true)
  expect(v[0].priceUsd).toBeCloseTo(772.5, 0); expect(v[0].valueUsd).toBeCloseTo(950.5 + 1.285 * 772.5, 0); expect(v[0].feesUsd).toBeCloseTo(8.29 + 0.0116 * 772.5, 0)
  expect(v[0].rangeLower).toBeCloseTo(759.05, 0); expect(v[0].rangeUpper).toBeCloseTo(786.87, 0)
  writePositionSnapshot(db, v[0].positionId, '2026-09-04', v[0])
  const again = syncPositions(db, [{ ...pos, liquidity: 0n }], new Map([['0xsofi', { tokenSymbol: 'SOFI' }]]), '2026-09-05T00:00:00Z')
  expect(again[0].isNew).toBe(false); expect(again[0].closed).toBe(true)
  expect((db.prepare('SELECT closed_at FROM positions').get() as any).closed_at).toBe('2026-09-05T00:00:00Z')
})
