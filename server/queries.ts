// server/queries.ts — dashboard 用的唯讀查詢（頭寸登錄除外），可用 :memory: 測試
import type Database from 'better-sqlite3'
import { simulateHourly, type SimHour } from '../scanner/metrics/simulate.js'
import { loadHourly } from '../scanner/steps.js'
import { rvolRange } from '../scanner/metrics/volatility.js'

const POOL_JOIN = `FROM pool_snapshots s JOIN pools p ON p.pool_id = s.pool_id
  JOIN tokens t ON t.address = CASE WHEN p.stock_is_token0 = 1 THEN p.token0 ELSE p.token1 END`
const parse = (v: string | null) => (v ? JSON.parse(v) : null)

export function getDates(db: Database.Database): string[] {
  return (db.prepare('SELECT DISTINCT date FROM pool_snapshots ORDER BY date DESC').all() as { date: string }[]).map(r => r.date)
}
export interface OverviewRow {
  pool_id: string; symbol: string; protocol: string; fee_ppm: number | null; hooks: string; age_days: number | null
  tvl_usd: number | null; volume_24h_usd: number; fees_24h_usd: number; vol7_avg_usd: number; vol7_cv: number
  trader_count: number | null; top1_share: number | null; price_usd: number | null; price_ref_usd: number | null; price_dev_pct: number | null
  raw_apr: number | null; score: number | null; excluded: number; flags: string[]; sim: any; all_day_tradable: string | null
  rank_today: number | null; rank_prev: number | null
}
function rankMap(db: Database.Database, date: string): Map<string, number> {
  const rows = db.prepare('SELECT pool_id FROM pool_snapshots WHERE date=? AND excluded=0 AND score IS NOT NULL ORDER BY score DESC').all(date) as { pool_id: string }[]
  return new Map(rows.map((r, i) => [r.pool_id, i + 1]))
}
export function getOverview(db: Database.Database, date: string): OverviewRow[] {
  const prevDate = (db.prepare('SELECT MAX(date) d FROM pool_snapshots WHERE date < ?').get(date) as { d: string | null }).d
  const today = rankMap(db, date); const prev = prevDate ? rankMap(db, prevDate) : new Map<string, number>()
  const rows = db.prepare(`SELECT s.pool_id, t.symbol, p.protocol, p.fee_ppm, p.hooks, s.age_days, s.tvl_usd, s.volume_24h_usd, s.fees_24h_usd, s.vol7_avg_usd, s.vol7_cv,
      s.trader_count, s.top1_share, s.price_usd, s.price_ref_usd, s.price_dev_pct, s.raw_apr, s.score, s.excluded, s.flags, s.sim, t.all_day_tradable ${POOL_JOIN} WHERE s.date=?`).all(date) as any[]
  return rows.map(r => ({ ...r, flags: parse(r.flags) ?? [], sim: parse(r.sim), rank_today: today.get(r.pool_id) ?? null, rank_prev: prev.get(r.pool_id) ?? null }))
}
export function getPool(db: Database.Database, poolId: string) {
  const pool = db.prepare(`SELECT p.*, t.symbol, t.name AS token_name, t.rh_status, t.all_day_tradable, t.current_multiplier, t.address AS stock_address FROM pools p
    JOIN tokens t ON t.address = CASE WHEN p.stock_is_token0 = 1 THEN p.token0 ELSE p.token1 END WHERE p.pool_id=?`).get(poolId) as any
  if (!pool) return null
  const snapshots = (db.prepare('SELECT * FROM pool_snapshots WHERE pool_id=? ORDER BY date DESC LIMIT 30').all(poolId) as any[]).reverse()
    .map(s => ({ ...s, flags: parse(s.flags) ?? [], sim: parse(s.sim), wash_detail: parse(s.wash_detail) }))
  const latest = snapshots[snapshots.length - 1] ?? null
  const hourly = db.prepare('SELECT ts, price_usd, volume_usd, fees_usd, liquidity, swap_count FROM pool_hourly WHERE pool_id=? ORDER BY ts DESC LIMIT 720').all(poolId).reverse()
  const simHours: SimHour[] = loadHourly(db, poolId)
  const rvolR = latest?.sim?.meta?.rvol_R ?? rvolRange(null).R
  const curve = (R: number) => simulateHourly(simHours, 1000, R).map(r => ({ ts: r.row.ts, net: r.cumFees + r.valueH - 1000, inRange: r.inRange }))
  const curves = simHours.length ? { r10: curve(0.10), r25: curve(0.25), rvol: curve(rvolR) } : null
  const corporateActions = db.prepare('SELECT * FROM corporate_actions WHERE token=? ORDER BY effective_at DESC').all(pool.stock_address)
  return { pool, snapshots, hourly, curves, corporateActions, latest }
}
export interface PositionInput { pool_id: string; label: string; range_lower: number; range_upper: number; deposit_usd: number; opened_at: string; notes?: string }
export function createPosition(db: Database.Database, i: PositionInput): number {
  return Number(db.prepare(`INSERT INTO positions(pool_id,label,range_lower,range_upper,deposit_usd,opened_at,notes) VALUES (?,?,?,?,?,?,?)`)
    .run(i.pool_id, i.label, i.range_lower, i.range_upper, i.deposit_usd, i.opened_at, i.notes ?? null).lastInsertRowid)
}
export function closePosition(db: Database.Database, id: number, c: { closed_at: string; fees_final_usd: number; value_final_usd: number }) {
  db.prepare('UPDATE positions SET closed_at=? WHERE id=?').run(c.closed_at, id)
  db.prepare(`INSERT OR REPLACE INTO position_snapshots(position_id,date,value_usd,fees_cum_usd,in_range,gas_cum_usd) VALUES (?,?,?,?,NULL,NULL)`).run(id, c.closed_at.slice(0, 10), c.value_final_usd, c.fees_final_usd)
}
/** 頭寸卡片：現值與累積費以最新池價、pool_hourly 從 opened_at 起模擬估算（P5 前的暫代，DECISIONS D27） */
export function listPositions(db: Database.Database) {
  const rows = db.prepare(`SELECT ps.*, t.symbol, p.fee_ppm FROM positions ps JOIN pools p ON p.pool_id=ps.pool_id
    JOIN tokens t ON t.address = CASE WHEN p.stock_is_token0 = 1 THEN p.token0 ELSE p.token1 END ORDER BY ps.id DESC`).all() as any[]
  return rows.map(r => {
    const from = Date.parse(r.opened_at) / 1000; const to = r.closed_at ? Date.parse(r.closed_at) / 1000 : Infinity
    const hours = loadHourly(db, r.pool_id, 24 * 45).filter(h => h.ts >= from && h.ts <= to)
    const P0 = hours[0]?.priceUsd
    const R = P0 ? (r.range_upper - r.range_lower) / (2 * P0) : 0.25
    const est = hours.length ? simulateHourly(hours, r.deposit_usd, R) : []
    const last = est[est.length - 1]
    const snaps = db.prepare('SELECT * FROM position_snapshots WHERE position_id=? ORDER BY date').all(r.id) as any[]
    const finalSnap = r.closed_at ? snaps[snaps.length - 1] : null
    return { ...r, est: last ? { value_usd: last.valueH, fees_cum_usd: last.cumFees, in_range: last.inRange, net_usd: last.valueH + last.cumFees - r.deposit_usd, price: last.row.priceUsd, hours: est.length } : null,
      curve: est.map(e => ({ ts: e.row.ts, net: e.valueH + e.cumFees - r.deposit_usd })), final: finalSnap ? { value_usd: finalSnap.value_usd, fees_cum_usd: finalSnap.fees_cum_usd } : null }
  })
}
