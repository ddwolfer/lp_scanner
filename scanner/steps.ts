// scanner/steps.ts — DB 寫入步驟，可單元測試（不打網路）
import type Database from 'better-sqlite3'
import { ADDR, USDG_DECIMALS } from '../config/chain.js'
import type { RhAsset } from './sources/robinhood.js'
import type { DiscoveredPool } from './sources/uniswapV4.js'
import type { HourlyRow } from './metrics/hourly.js'
import { hookInfo } from './metrics/hooks.js'

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
  const st = db.prepare(`INSERT OR IGNORE INTO pools(pool_id,protocol,token0,token1,fee_ppm,tick_spacing,hooks,created_block,created_at,quote_kind,stock_is_token0,hook_kind,hook_flags)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  let n = 0
  db.transaction(() => {
    for (const p of pools) {
      const side = isStockUsdgPool(p, stockSet); if (!side) continue
      const h = hookInfo(p.hooks)
      const r = st.run(p.poolId, p.protocol ?? 'v4', p.currency0, p.currency1, p.feePpm, p.tickSpacing, p.hooks, Number(p.createdBlock), blockTs.get(p.createdBlock.toString()) ?? null, 'usdg', side === 'token0' ? 1 : 0, h.kind, JSON.stringify(h.flags))
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
  price_usd: number | null; price_ref_usd: number | null; price_dev_pct: number | null; swap_count: number; fee_ppm_observed?: number | null
  age_days: number | null; vol7_avg_usd: number; vol7_cv: number; raw_apr: number | null; flags: string[]; excluded: number
}
export function writeSnapshot(db: Database.Database, r: SnapshotRow) {
  db.prepare(`INSERT OR REPLACE INTO pool_snapshots(pool_id,date,is_weekday,tvl_usd,volume_24h_usd,fees_24h_usd,price_usd,price_ref_usd,price_dev_pct,swap_count,fee_ppm_observed,age_days,vol7_avg_usd,vol7_cv,raw_apr,flags,excluded)
    VALUES (@pool_id,@date,@is_weekday,@tvl_usd,@volume_24h_usd,@fees_24h_usd,@price_usd,@price_ref_usd,@price_dev_pct,@swap_count,@fee_ppm_observed,@age_days,@vol7_avg_usd,@vol7_cv,@raw_apr,@flags,@excluded)`)
    .run({ fee_ppm_observed: null, ...r, flags: JSON.stringify(r.flags) })
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

import type { SimHour, SimJson } from './metrics/simulate.js'
/** 最近 maxHours 小時（預設 30 天）升冪；丟掉開頭無價格的列，之後無價格以前值填補 */
export function loadHourly(db: Database.Database, poolId: string, maxHours = 720): SimHour[] {
  const rows = (db.prepare('SELECT ts, price_usd, fees_usd, liquidity FROM pool_hourly WHERE pool_id=? ORDER BY ts DESC LIMIT ?').all(poolId, maxHours) as any[]).reverse()
  const out: SimHour[] = []; let last: number | null = null
  for (const r of rows) {
    if (r.price_usd === null && last === null) continue
    if (r.price_usd !== null) last = r.price_usd
    out.push({ ts: r.ts, priceUsd: last!, feesUsd: r.fees_usd ?? 0, liquidity: r.liquidity ?? null })
  }
  return out
}
export function updateSim(db: Database.Database, poolId: string, date: string, sim: SimJson, score: number | null, flags: string[]) {
  db.prepare('UPDATE pool_snapshots SET sim=?, score=?, flags=? WHERE pool_id=? AND date=?').run(JSON.stringify(sim), score, JSON.stringify([...new Set(flags)]), poolId, date)
}

import type { WashMetrics } from './metrics/wash.js'
export function updateWash(db: Database.Database, poolId: string, date: string, m: WashMetrics, flags: string[], excluded: number, sampled: boolean) {
  db.prepare(`UPDATE pool_snapshots SET trader_count=?, top1_share=?, pingpong_ratio=?, lp_trader_overlap=?, lp_overlap_volume_share=?, wash_detail=?, flags=?, excluded=? WHERE pool_id=? AND date=?`)
    .run(m.traderCount, m.top1Share, m.pingpongRatio, m.lpTraderOverlap, m.lpOverlapVolumeShare, JSON.stringify({ topTraders: m.topTraders, hourly: m.hourly, sampled }), JSON.stringify([...new Set(flags)]), excluded, poolId, date)
}

import type { OnchainPosition } from './sources/positions.js'
import { stockPriceUsd } from './metrics/price.js'
import { STOCK_DECIMALS } from '../config/chain.js'
export interface PositionValuation { positionId: number; tokenId: string; poolId: string; label: string; valueUsd: number; feesUsd: number; inRange: boolean; priceUsd: number; rangeLower: number; rangeUpper: number; isNew: boolean; closed: boolean }
/** 鏈上頭寸同步進 positions 表（notes JSON 記 tokenId），並回傳估值供寫快照與摘要 */
export function syncPositions(db: Database.Database, list: OnchainPosition[], stockByAddr: Map<string, { tokenSymbol: string }>, nowIso: string): PositionValuation[] {
  const out: PositionValuation[] = []
  const seenTokenIds = new Set<string>()
  const find = db.prepare(`SELECT * FROM positions WHERE json_extract(notes, '$.tokenId') = ? AND COALESCE(json_extract(notes, '$.protocol'), 'v4') = ?`)
  for (const p of list) {
    seenTokenIds.add(p.tokenId)
    const stockIs0 = p.currency1 === ADDR.usdg && stockByAddr.has(p.currency0), stockIs1 = p.currency0 === ADDR.usdg && stockByAddr.has(p.currency1)
    if (!stockIs0 && !stockIs1) continue   // 非股票 × USDG 池，不追蹤
    const stockAddr = stockIs0 ? p.currency0 : p.currency1; const sym = stockByAddr.get(stockAddr)!.tokenSymbol
    const price = stockPriceUsd(p.sqrtPriceX96, stockIs0)
    const tickP = (t: number) => { const raw = 1.0001 ** t; const p0 = raw * 10 ** ((stockIs0 ? STOCK_DECIMALS : USDG_DECIMALS) - (stockIs0 ? USDG_DECIMALS : STOCK_DECIMALS)); return stockIs0 ? p0 : 1 / p0 }
    const [lo, hi] = [tickP(p.tickLower), tickP(p.tickUpper)].sort((a, b) => a - b)
    const stockAmt = (stockIs0 ? p.amount0 : p.amount1) / 10 ** STOCK_DECIMALS, usdgAmt = (stockIs0 ? p.amount1 : p.amount0) / 10 ** USDG_DECIMALS
    const stockFee = (stockIs0 ? p.fee0 : p.fee1) / 10 ** STOCK_DECIMALS, usdgFee = (stockIs0 ? p.fee1 : p.fee0) / 10 ** USDG_DECIMALS
    const valueUsd = stockAmt * price + usdgAmt, feesUsd = stockFee * price + usdgFee
    const inRange = p.tick >= p.tickLower && p.tick < p.tickUpper
    let row = find.get(p.tokenId, p.protocol ?? 'v4') as any; let isNew = false
    if (!row && p.liquidity === 0n) continue   // 第一次看到就已關閉的舊頭寸：歷史不可知，不建立
    if (!row) {
      isNew = true
      const notes = JSON.stringify({ source: 'onchain', protocol: p.protocol ?? 'v4', tokenId: p.tokenId, deposit_estimated: true, tickLower: p.tickLower, tickUpper: p.tickUpper })
      const id = Number(db.prepare(`INSERT INTO positions(pool_id,label,range_lower,range_upper,deposit_usd,opened_at,notes) VALUES (?,?,?,?,?,?,?)`)
        .run(p.poolId, `${sym} ${p.protocol === 'v3' ? 'v3 ' : ''}#${p.tokenId.slice(-4)}`, lo, hi, valueUsd + feesUsd, nowIso, notes).lastInsertRowid)
      row = { id, pool_id: p.poolId, label: `${sym} ${p.protocol === 'v3' ? 'v3 ' : ''}#${p.tokenId.slice(-4)}`, range_lower: lo, range_upper: hi, closed_at: null }
    }
    const closed = p.liquidity === 0n
    if (closed && !row.closed_at) db.prepare('UPDATE positions SET closed_at=? WHERE id=?').run(nowIso, row.id)
    if (!closed && row.closed_at) db.prepare('UPDATE positions SET closed_at=NULL WHERE id=?').run(row.id)
    out.push({ positionId: row.id, tokenId: p.tokenId, poolId: p.poolId, label: row.label, valueUsd, feesUsd, inRange, priceUsd: price, rangeLower: row.range_lower, rangeUpper: row.range_upper, isNew, closed })
  }
  return out
}
export function writePositionSnapshot(db: Database.Database, positionId: number, date: string, v: { valueUsd: number; feesUsd: number; inRange: boolean }) {
  db.prepare(`INSERT OR REPLACE INTO position_snapshots(position_id,date,value_usd,fees_cum_usd,in_range,gas_cum_usd) VALUES (?,?,?,?,?,NULL)`).run(positionId, date, v.valueUsd, v.feesUsd, v.inRange ? 1 : 0)
}

export function setPositionOrigin(db: Database.Database, id: number, openedAtIso: string, depositUsd: number, extraNotes: Record<string, unknown>) {
  const row = db.prepare('SELECT notes FROM positions WHERE id=?').get(id) as { notes: string | null }
  const notes = { ...(row?.notes ? JSON.parse(row.notes) : {}), ...extraNotes, deposit_estimated: false }
  db.prepare('UPDATE positions SET opened_at=?, deposit_usd=?, notes=? WHERE id=?').run(openedAtIso, depositUsd, JSON.stringify(notes), id)
}
export function lastKnownTvl(db: Database.Database, poolId: string, beforeDate: string): number | null {
  const r = db.prepare('SELECT tvl_usd FROM pool_snapshots WHERE pool_id=? AND date<? AND tvl_usd IS NOT NULL ORDER BY date DESC LIMIT 1').get(poolId, beforeDate) as { tvl_usd: number } | undefined
  return r?.tvl_usd ?? null
}

/** 既有池補上 hook 分類（一次性；新池在 upsertPools 就有） */
export function backfillHookInfo(db: Database.Database): number {
  const rows = db.prepare('SELECT pool_id, hooks FROM pools WHERE hook_kind IS NULL').all() as { pool_id: string; hooks: string }[]
  const st = db.prepare('UPDATE pools SET hook_kind=?, hook_flags=? WHERE pool_id=?')
  db.transaction(() => { for (const r of rows) { const h = hookInfo(r.hooks); st.run(h.kind, JSON.stringify(h.flags), r.pool_id) } })()
  return rows.length
}
