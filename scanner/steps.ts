// scanner/steps.ts — DB 寫入步驟，可單元測試（不打網路）
import type Database from 'better-sqlite3'
import { ADDR, USDG_DECIMALS } from '../config/chain.js'
import type { RhAsset } from './sources/robinhood.js'
import type { DiscoveredPool } from './sources/uniswapV4.js'
import type { HourlyRow } from './metrics/hourly.js'

export function upsertTokens(db: Database.Database, assets: RhAsset[], now: string) {
  const st = db.prepare(`INSERT INTO tokens(address,symbol,name,decimals,kind,rh_asset_id,rh_status,all_day_tradable,current_multiplier,raw,first_seen)
    VALUES (@address,@symbol,@name,@decimals,@kind,@rh_asset_id,@rh_status,@all_day_tradable,@current_multiplier,@raw,@first_seen)
    ON CONFLICT(address) DO UPDATE SET symbol=excluded.symbol,name=excluded.name,rh_status=excluded.rh_status,all_day_tradable=excluded.all_day_tradable,current_multiplier=excluded.current_multiplier,raw=excluded.raw`)
  db.transaction(() => {
    st.run({ address: ADDR.usdg, symbol: 'USDG', name: 'Global Dollar', decimals: USDG_DECIMALS, kind: 'stable', rh_asset_id: null, rh_status: null, all_day_tradable: null, current_multiplier: null, raw: null, first_seen: now })
    for (const a of assets) st.run({ address: a.address, symbol: a.tokenSymbol, name: a.tokenName, decimals: a.tokenDecimals, kind: 'stock', rh_asset_id: a.id, rh_status: a.status,
      all_day_tradable: a.allDayTradable ? 'tradable' : 'not_tradable', current_multiplier: a.currentMultiplier, raw: JSON.stringify(a.raw), first_seen: now })
  })()
}
/** 只寫「股票 × USDG」池（DECISIONS C1）。blockTs: createdBlock(string) → ISO。回傳新寫入數 */
export function isStockUsdgPool(p: { currency0: string; currency1: string }, stockSet: Set<string>): 'token0' | 'token1' | null {
  if (p.currency1 === ADDR.usdg && stockSet.has(p.currency0)) return 'token0'
  if (p.currency0 === ADDR.usdg && stockSet.has(p.currency1)) return 'token1'
  return null
}
export function upsertPools(db: Database.Database, pools: DiscoveredPool[], stockSet: Set<string>, blockTs: Map<string, string>): number {
  const st = db.prepare(`INSERT OR IGNORE INTO pools(pool_id,protocol,token0,token1,fee_ppm,tick_spacing,hooks,created_block,created_at,quote_kind,stock_is_token0)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
  let n = 0
  db.transaction(() => {
    for (const p of pools) {
      const side = isStockUsdgPool(p, stockSet); if (!side) continue
      const r = st.run(p.poolId, 'v4', p.currency0, p.currency1, p.feePpm, p.tickSpacing, p.hooks, Number(p.createdBlock), blockTs.get(p.createdBlock.toString()) ?? null, 'usdg', side === 'token0' ? 1 : 0)
      n += r.changes
    }
  })()
  return n
}
export function writeHourly(db: Database.Database, poolId: string, rows: HourlyRow[]) {
  const st = db.prepare(`INSERT OR REPLACE INTO pool_hourly(pool_id,ts,price_usd,volume_usd,fees_usd,tvl_usd,liquidity,swap_count) VALUES (?,?,?,?,?,NULL,?,?)`)
  db.transaction(() => { for (const r of rows) st.run(poolId, r.ts, r.priceUsd, r.volumeUsd, r.feesUsd, r.liquidity, r.swapCount) })()
}
export interface SnapshotRow {
  pool_id: string; date: string; is_weekday: number; tvl_usd: number | null; volume_24h_usd: number; fees_24h_usd: number
  price_usd: number | null; price_ref_usd: number | null; price_dev_pct: number | null; swap_count: number
  age_days: number | null; vol7_avg_usd: number; vol7_cv: number; raw_apr: number | null; flags: string[]; excluded: number
}
export function writeSnapshot(db: Database.Database, r: SnapshotRow) {
  db.prepare(`INSERT OR REPLACE INTO pool_snapshots(pool_id,date,is_weekday,tvl_usd,volume_24h_usd,fees_24h_usd,price_usd,price_ref_usd,price_dev_pct,swap_count,age_days,vol7_avg_usd,vol7_cv,raw_apr,flags,excluded)
    VALUES (@pool_id,@date,@is_weekday,@tvl_usd,@volume_24h_usd,@fees_24h_usd,@price_usd,@price_ref_usd,@price_dev_pct,@swap_count,@age_days,@vol7_avg_usd,@vol7_cv,@raw_apr,@flags,@excluded)`)
    .run({ ...r, flags: JSON.stringify(r.flags) })
}
export function previousCandidates(db: Database.Database, date: string): Set<string> {
  const prev = db.prepare('SELECT MAX(date) d FROM pool_snapshots WHERE date < ?').get(date) as { d: string | null }
  if (!prev?.d) return new Set()
  return new Set((db.prepare('SELECT pool_id FROM pool_snapshots WHERE date=? AND excluded=0').all(prev.d) as { pool_id: string }[]).map(r => r.pool_id))
}
export function recentVolumes(db: Database.Database, poolId: string, beforeDate: string, n = 6): number[] {
  return (db.prepare('SELECT volume_24h_usd v FROM pool_snapshots WHERE pool_id=? AND date<? ORDER BY date DESC LIMIT ?').all(poolId, beforeDate, n) as { v: number | null }[]).map(r => r.v ?? 0).reverse()
}
export function pruneHourly(db: Database.Database, keepDays = 45) {
  db.prepare('DELETE FROM pool_hourly WHERE ts < ?').run(Math.floor(Date.now() / 1000) - keepDays * 86400)
}
