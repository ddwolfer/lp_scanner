import { it, expect } from 'vitest'
import { openDb } from '../db/index.js'
import { getDates, getOverview, getPool, createPosition, closePosition, listPositions, addJournal, listJournal, exportPositions, weekendWindow, poolSeries } from '../server/queries.js'
import { shouldWriteSnapshot } from '../scanner/positionsStage.js'
import { writePositionSnapshot } from '../scanner/steps.js'
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

it('weekendWindow：UTC 週六 00:00 起 48 小時', () => {
  const w = weekendWindow(new Date('2026-09-07T01:45:00Z'))   // 週一
  expect(new Date(w.from * 1000).toISOString()).toBe('2026-09-05T00:00:00.000Z')
  expect((w.to - w.from) / 3600).toBe(48)
  expect(new Date(weekendWindow(new Date('2026-09-05T10:00:00Z')).from * 1000).toISOString()).toBe('2026-09-05T00:00:00.000Z')   // 週六當天
  expect(new Date(weekendWindow(new Date('2026-09-04T10:00:00Z')).from * 1000).toISOString()).toBe('2026-08-29T00:00:00.000Z')   // 週五 → 上週六
})

it('D61 保本線：領費由快照歸零自動偵測，日誌有精確值就用日誌；加減倉標記', () => {
  const db = openDb(':memory:')
  db.prepare(`INSERT INTO tokens(address,symbol,name,decimals,kind) VALUES ('0xstock','MSTR','MSTR',18,'stock'),('0x5fc5360d0400a0fd4f2af552add042d716f1d168','USDG','USDG',6,'stable')`).run()
  db.prepare(`INSERT INTO pools(pool_id,protocol,token0,token1,fee_ppm,tick_spacing,hooks,quote_kind,stock_is_token0) VALUES ('0xp','v4','0xstock','0x5fc5360d0400a0fd4f2af552add042d716f1d168',2500,25,'0x0000000000000000000000000000000000000000','usdg',1)`).run()
  const notes = JSON.stringify({ source: 'onchain', tokenId: '1', liquidity: (0.05 * 1e12).toString(), liquidity_changes: [{ at: '2026-09-11T15:05:00Z', from: '1', to: '2' }] })
  const id = Number(db.prepare(`INSERT INTO positions(pool_id,label,range_lower,range_upper,deposit_usd,opened_at,notes) VALUES ('0xp','MSTR #1',115,175,1000,'2026-09-04T13:00:00Z',?)`).run(notes).lastInsertRowid)
  const snap = db.prepare(`INSERT INTO position_snapshots(position_id,date,value_usd,fees_cum_usd,in_range) VALUES (?,?,?,?,1)`)
  snap.run(id, '2026-09-10', 990, 10.96); snap.run(id, '2026-09-11', 1400, 0); snap.run(id, '2026-09-18', 1408, 21.81)   // 9/11 歸零 = 領過
  db.prepare(`INSERT INTO position_journal(position_id,ts,kind,text,data) VALUES (?, '2026-09-11T15:05:00Z','collect','x',?)`).run(id, JSON.stringify({ fees_collected_usd: 15.19 }))
  for (let h = 0; h < 48; h++) db.prepare(`INSERT INTO pool_hourly(pool_id,ts,price_usd,volume_usd,fees_usd,liquidity,swap_count) VALUES ('0xp',?,130,1000,3,'1000000000000000',5)`).run(Date.parse('2026-09-17T00:00:00Z') / 1000 + h * 3600)
  const p = listPositions(db).find(x => x.id === id)!
  expect(p.breakeven).not.toBeNull()
  expect(p.breakeven.feesEarnedUsd).toBeCloseTo(21.81 + 15.19, 6)   // 日誌精確值取代快照差額 10.96
  expect(p.breakeven.paceUsdPerDay).toBeCloseTo((21.81 + 15.19 - (0 + 15.19)) / 7, 6)
  expect(p.breakeven.capitalChanged).toBe(true)
  expect(p.breakeven.feesReinvestedUsd).toBeCloseTo(15.19, 6)   // 9/11 領回的費與加倉同日 → 再投入，保本線只扣 21.81
  expect(p.breakeven.lower.feesEarnedUsd).toBeCloseTo(21.81, 6)
  expect(p.breakeven.lower.toCoverUsd).toBeGreaterThan(0)
  // 減倉日的領取不算再投入：把那次改成減倉，且日誌沒有明寫 → 15.19 全算提走
  db.prepare(`UPDATE positions SET notes=json_set(notes,'$.liquidity_changes',json('[{"at":"2026-09-11T15:05:00Z","from":"2","to":"1"}]')) WHERE id=?`).run(id)
  expect(listPositions(db).find(x => x.id === id)!.breakeven.feesReinvestedUsd).toBe(0)
  db.prepare(`UPDATE positions SET notes=json_set(notes,'$.liquidity_changes',json('[{"at":"2026-09-11T15:05:00Z","from":"1","to":"2"}]')) WHERE id=?`).run(id)
  // 日誌明寫 reinvested_usd 時以它為準
  db.prepare(`INSERT INTO position_journal(position_id,ts,kind,text,data) VALUES (?, '2026-09-11T15:06:00Z','adjust','x',?)`).run(id, JSON.stringify({ reinvested_usd: 7.64 }))
  expect(listPositions(db).find(x => x.id === id)!.breakeven.feesReinvestedUsd).toBeCloseTo(7.64, 6)
  db.prepare(`DELETE FROM position_journal WHERE kind='adjust'`).run()
  // 未領費因股價跌而變小（10.96 → 9.5）不算領取
  snap.run(id, '2026-09-19', 1300, 20.0)
  const q = listPositions(db).find(x => x.id === id)!
  expect(q.breakeven.feesEarnedUsd).toBeCloseTo(20.0 + 15.19, 6)
  // 沒有日誌時退回快照差額
  db.prepare('DELETE FROM position_journal').run()
  expect(listPositions(db).find(x => x.id === id)!.breakeven.feesEarnedUsd).toBeCloseTo(20.0 + 10.96, 6)   // 最新快照已是 9/19 的 20.0
})

it('D65：費率低於下限而被排除的池，頭寸模擬與換池提示仍可用；沒抓 swap 的日子不算費率 0', () => {
  const db = seed()
  db.prepare(`INSERT INTO pools(pool_id,protocol,token0,token1,fee_ppm,hooks,stock_is_token0,created_at,hook_kind) VALUES ('0x3','v3','0xsofi','0xusdg',500,'0x0',1,'2026-08-01','none')`).run()
  db.prepare(`UPDATE pools SET hook_kind='none'`).run()   // seed 的 hooks='0x0' 不是零地址，沒有 hook_kind 會被當成流動性 hook
  const base = { is_weekday: 1, tvl_usd: 100000, volume_24h_usd: 0, fees_24h_usd: 0, price_usd: 10, price_ref_usd: 10, price_dev_pct: 0, swap_count: 0, age_days: 30, vol7_avg_usd: 0, vol7_cv: 0, raw_apr: 0, excluded: 1 }
  const dates = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']
  // 前兩天沒抓（舊快照沒旗標 / 新快照有旗標），後兩天抓到 $230/日（0.23%/日）；持有的 0x1 池同期 0.03%/日
  writeSnapshot(db, { ...base, pool_id: '0x3', date: dates[0], flags: ['fee_out_of_range'] })
  writeSnapshot(db, { ...base, pool_id: '0x3', date: dates[1], flags: ['fee_out_of_range', 'swap_not_fetched'] })
  for (const d of dates.slice(2)) writeSnapshot(db, { ...base, pool_id: '0x3', date: d, flags: ['fee_out_of_range'], fees_24h_usd: 230, volume_24h_usd: 500000, swap_count: 900 })
  writeSnapshot(db, { ...base, pool_id: '0x3', date: '2026-09-30', flags: ['fee_out_of_range'] })   // 旗標上線後「抓了但沒成交」→ 有效的零收益日
  writeSnapshot(db, { ...base, pool_id: '0x3', date: '2026-10-01', flags: ['fee_out_of_range', 'protocol_fee_unknown'], fees_24h_usd: 300, swap_count: 10 })   // 總費口徑，不能比
  for (const d of dates) writeSnapshot(db, { ...base, pool_id: '0x1', date: d, flags: [], excluded: 0, tvl_usd: 10000, fees_24h_usd: 3, swap_count: 5 })
  writeHourly(db, '0x3', [0, 1, 2].map(i => ({ ts: 1_700_000_000 + 3600 * i, priceUsd: 10, volumeUsd: 100, feesUsd: 1, liquidity: '1', swapCount: 1 })))
  createPosition(db, { pool_id: '0x3', label: 'lowfee', range_lower: 7.5, range_upper: 12.5, deposit_usd: 1000, opened_at: new Date(1_700_000_000 * 1000).toISOString() })
  const [p] = listPositions(db)
  expect(p.est!.fees_cum_usd).toBeGreaterThan(0)                       // 排除池的 hourly 照樣進頭寸模擬
  const s = poolSeries(db, '0x3', 7, 5000)
  expect(s.held!.days.map(d => d.date)).toEqual(['2026-09-30', '2026-10-01'])   // 只取最新快照日往回 7 個日曆日，不是最近 7 筆
  expect(s.held!.days.map(d => d.ok)).toEqual([true, false])
  expect(poolSeries(db, '0x3', 40, 5000).held!.days.map(d => d.ok)).toEqual([false, false, true, true, true, false])
  expect(p.switchHint!.heldDays).toBe(1); expect(p.switchHint!.verdict).toBe('no_data')   // 視窗內自己只有 1 個資料完整的交易日
})
it('D67：換池提示用頭寸區間在兩池逐小時重放，只比交易日；穩定且多賺 → 考慮換', () => {
  const db = seed()
  db.prepare(`UPDATE pools SET hook_kind='none'`).run()
  const base = { is_weekday: 1, tvl_usd: 1_000_000, volume_24h_usd: 1000, fees_24h_usd: 3, price_usd: 10, price_ref_usd: 10, price_dev_pct: 0, swap_count: 5, age_days: 50, vol7_avg_usd: 0, vol7_cv: 0, raw_apr: 0, excluded: 0, flags: [] as string[] }
  for (const d of ['2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27']) for (const pid of ['0x1', '0x2']) writeSnapshot(db, { ...base, pool_id: pid, date: d })
  // UTC 09-22（二）到 09-26（六）每天 3 小時；0x2 每小時費是 0x1 的兩倍；週六那天不算
  const hrs = (fee: number) => ['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26'].flatMap(d => [1, 2, 3].map(h => ({ ts: Date.parse(`${d}T0${h}:00:00Z`) / 1000, priceUsd: 10, volumeUsd: 100, feesUsd: fee, liquidity: '1', swapCount: 1 })))
  writeHourly(db, '0x1', hrs(1)); writeHourly(db, '0x2', hrs(2))
  createPosition(db, { pool_id: '0x1', label: 'held', range_lower: 7.5, range_upper: 12.5, deposit_usd: 1000, opened_at: '2026-09-20T00:00:00Z' })
  const h = listPositions(db)[0].switchHint!
  expect(h.heldDays).toBe(4)                                  // 快照 09-23..09-26 → UTC 09-22..09-25 交易日；09-27 快照對應週六
  expect(h.verdict).toBe('consider'); expect(h.best!.poolId).toBe('0x2')
  expect(h.best!.altPerDay / h.best!.heldPerDay).toBeCloseTo(2, 2); expect(h.best!.reasons).toEqual([])
})

it('D66：feesLastDay 取最近兩筆快照的已賺差（領過的加回）；只有一筆從開倉算；shouldWriteSnapshot 的 if_missing/force', () => {
  const db = seed()
  const id = createPosition(db, { pool_id: '0x1', label: 'fee', range_lower: 7.5, range_upper: 12.5, deposit_usd: 1000, opened_at: '2026-09-01T10:00:00Z' })
  db.prepare(`UPDATE positions SET notes=? WHERE id=?`).run(JSON.stringify({ source: 'onchain', tokenId: '1' }), id)
  db.prepare(`INSERT INTO position_snapshots(position_id,date,value_usd,fees_cum_usd,in_range,taken_at) VALUES (?,?,?,?,1,?)`).run(id, '2026-09-02', 1000, 4, '2026-09-01T22:00:00Z')
  let [p] = listPositions(db)
  expect(p.feesLastDay).toMatchObject({ usd: 4, hours: 12, from: '2026-09-01T10:00:00Z' })
  db.prepare(`INSERT INTO position_snapshots(position_id,date,value_usd,fees_cum_usd,in_range,taken_at) VALUES (?,?,?,?,1,?)`).run(id, '2026-09-03', 1000, 6.5, '2026-09-02T22:00:00Z')
  ;[p] = listPositions(db)
  expect(p.feesLastDay!.usd).toBeCloseTo(2.5); expect(p.feesLastDay!.hours).toBe(24)
  // 9/3 領了 $6.5（未領歸零），9/4 快照未領 $1.2 → 昨日費 = (1.2 + 6.5) − 6.5 = 1.2
  addJournal(db, id, 'collect', '領費', { usd: 6.5 })
  db.prepare(`UPDATE position_journal SET ts=? WHERE position_id=?`).run('2026-09-03T05:00:00Z', id)
  db.prepare(`INSERT INTO position_snapshots(position_id,date,value_usd,fees_cum_usd,in_range,taken_at) VALUES (?,?,?,?,1,?)`).run(id, '2026-09-04', 1000, 1.2, '2026-09-03T22:00:00Z')
  ;[p] = listPositions(db)
  expect(p.feesLastDay!.usd).toBeCloseTo(1.2)
  expect(shouldWriteSnapshot(db, id, '2026-09-04', false, 'if_missing')).toBe(false)
  expect(shouldWriteSnapshot(db, id, '2026-09-05', false, 'if_missing')).toBe(true)
  expect(shouldWriteSnapshot(db, id, '2026-09-04', false, 'force')).toBe(true)
  expect(shouldWriteSnapshot(db, id, '2026-09-04', true, 'if_missing')).toBe(true)
  writePositionSnapshot(db, id, '2026-09-05', { valueUsd: 1, feesUsd: 1, inRange: true })
  expect(db.prepare('SELECT taken_at FROM position_snapshots WHERE position_id=? AND date=?').get(id, '2026-09-05')).toBeTruthy()
})

it('dailyFees 的 capHours 在加倉時點切段；liveBasis 用現在的投入', () => {
  const db = seed()
  const id = createPosition(db, { pool_id: '0x1', label: 'cap', range_lower: 7.5, range_upper: 12.5, deposit_usd: 10000, opened_at: '2026-09-01T00:00:00Z' })
  db.prepare(`UPDATE positions SET notes=? WHERE id=?`).run(JSON.stringify({ source: 'onchain', tokenId: '9' }), id)
  addJournal(db, id, 'adjust', '加倉', { cash_added_usd: 9000 }); db.prepare(`UPDATE position_journal SET ts=? WHERE position_id=?`).run('2026-09-01T23:00:00Z', id)
  db.prepare(`INSERT INTO position_snapshots(position_id,date,value_usd,fees_cum_usd,in_range,taken_at) VALUES (?,?,?,?,1,?)`).run(id, '2026-09-02', 10000, 3, '2026-09-02T00:00:00Z')
  const p = listPositions(db)[0] as any
  expect(p.dailyFees[0].capHours).toBeCloseTo(1000 * 23 + 10000 * 1)
  expect(p.liveBasis.capital_usd).toBe(10000)
})
