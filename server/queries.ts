// server/queries.ts — dashboard 用的唯讀查詢（頭寸登錄除外），可用 :memory: 測試
import type Database from 'better-sqlite3'
import { mkdirSync, writeFileSync } from 'node:fs'
import { simulateHourly, simulateWithCapital, type SimHour } from '../scanner/metrics/simulate.js'
import { loadHourly } from '../scanner/steps.js'
import { rvolRange } from '../scanner/metrics/volatility.js'
import { lifecycleCost, capacityUsd, volumePersistence, exitBreakeven } from '../scanner/metrics/economics.js'
import { L_HUMAN_TO_RAW } from '../scanner/metrics/lp-math.js'
import { taipeiDate } from '../scanner/time.js'
import { loadScoring } from '../config/chain.js'
import { feeDelta } from '../scanner/metrics/weeklyFees.js'
import { switchHint, replayDaily, replayStats, weekdayPace, snapshotToUtcDay, type SwitchHint, type AltPool } from '../scanner/metrics/poolSwitch.js'
/** 一個池最近幾天的快照摘要（D65/D67）：ok=false 的日子（沒抓、抓失敗、總費口徑）不能拿來比 */
export interface PoolSeries { poolId: string; label: string; swapFeeRate: number; hookKind: 'none' | 'fee_only' | 'liquidity'; createdAt: string | null; days: { date: string; feesUsd: number; tvlUsd: number | null; ok: boolean }[] }

const POOL_JOIN = `FROM pool_snapshots s JOIN pools p ON p.pool_id = s.pool_id
  JOIN tokens t ON t.address = CASE WHEN p.stock_is_token0 = 1 THEN p.token0 ELSE p.token1 END`
const parse = (v: string | null) => (v ? JSON.parse(v) : null)

export function getDates(db: Database.Database): string[] {
  return (db.prepare('SELECT DISTINCT date FROM pool_snapshots ORDER BY date DESC').all() as { date: string }[]).map(r => r.date)
}
export interface OverviewRow {
  pool_id: string; symbol: string; protocol: string; fee_ppm: number | null; fee_ppm_observed: number | null; hooks: string; hook_kind: string | null; hook_flags: string[]; age_days: number | null
  tvl_usd: number | null; volume_24h_usd: number; fees_24h_usd: number; vol7_avg_usd: number; vol7_cv: number
  trader_count: number | null; top1_share: number | null; price_usd: number | null; price_ref_usd: number | null; price_dev_pct: number | null
  raw_apr: number | null; score: number | null; excluded: number; flags: string[]; sim: any; all_day_tradable: string | null
  vol_6h_usd: number | null; heat_6h: number | null
  weekend_fees_usd: number | null; weekend_vol_usd: number | null; weekend_fee_tvl: number | null; weekend_hours: number
  rank_today: number | null; rank_prev: number | null
}
function rankMap(db: Database.Database, date: string): Map<string, number> {
  const rows = db.prepare('SELECT pool_id FROM pool_snapshots WHERE date=? AND excluded=0 AND score IS NOT NULL ORDER BY score DESC').all(date) as { pool_id: string }[]
  return new Map(rows.map((r, i) => [r.pool_id, i + 1]))
}
/** 最近一個週末（UTC 週六 00:00 起 48h = 台灣週六 08:00 到週一 08:00）的每池手續費與成交量（D45） */
export function weekendWindow(now = new Date()): { from: number; to: number } {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const back = (d.getUTCDay() + 1) % 7   // 距離上個週六的天數（週六 → 0）
  const sat = d.getTime() / 1000 - back * 86400
  return { from: sat, to: sat + 48 * 3600 }
}
export function weekendStats(db: Database.Database, now = new Date()): Map<string, { fees: number; vol: number; hours: number }> {
  const { from, to } = weekendWindow(now)
  const rows = db.prepare('SELECT pool_id, SUM(fees_usd) fees, SUM(volume_usd) vol, COUNT(*) hours FROM pool_hourly WHERE ts >= ? AND ts < ? GROUP BY pool_id').all(from, to) as any[]
  return new Map(rows.map(r => [r.pool_id, { fees: r.fees ?? 0, vol: r.vol ?? 0, hours: r.hours }]))
}
export function getOverview(db: Database.Database, date: string): OverviewRow[] {
  const prevDate = (db.prepare('SELECT MAX(date) d FROM pool_snapshots WHERE date < ?').get(date) as { d: string | null }).d
  const today = rankMap(db, date); const prev = prevDate ? rankMap(db, prevDate) : new Map<string, number>()
  const wk = weekendStats(db)
  const rows = db.prepare(`SELECT s.pool_id, t.symbol, p.protocol, p.fee_ppm, s.fee_ppm_observed, p.hooks, p.hook_kind, p.hook_flags, s.age_days, s.tvl_usd, s.volume_24h_usd, s.fees_24h_usd, s.vol7_avg_usd, s.vol7_cv,
      s.trader_count, s.top1_share, s.price_usd, s.price_ref_usd, s.price_dev_pct, s.raw_apr, s.score, s.excluded, s.flags, s.sim, t.all_day_tradable, s.vol_6h_usd ${POOL_JOIN} WHERE s.date=?`).all(date) as any[]
  return rows.map(r => { const w = wk.get(r.pool_id); return ({ ...r, weekend_fees_usd: w ? w.fees : null, weekend_vol_usd: w ? w.vol : null, weekend_fee_tvl: w && r.tvl_usd ? w.fees / r.tvl_usd : null, weekend_hours: w?.hours ?? 0, heat_6h: r.vol_6h_usd !== null && r.volume_24h_usd > 0 ? (r.vol_6h_usd / 6) / (r.volume_24h_usd / 24) : null, flags: parse(r.flags) ?? [], hook_flags: parse(r.hook_flags) ?? [], sim: parse(r.sim), rank_today: today.get(r.pool_id) ?? null, rank_prev: prev.get(r.pool_id) ?? null }) })
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
  const feeStats = latest ? (db.prepare('SELECT MIN(fees_usd/NULLIF(volume_usd,0)) mn, MAX(fees_usd/NULLIF(volume_usd,0)) mx FROM pool_hourly WHERE pool_id=? AND ts>=? AND volume_usd>0').get(poolId, Math.floor(Date.now() / 1000) - 86400) as any) : null
  // D37：成交持續性、生命週期成本、容量
  const econCfg = loadScoring().economics
  const vols = (hourly as any[]).map(h => h.volume_usd ?? 0)
  const lastH = (hourly as any[]).filter(h => h.liquidity && h.price_usd).at(-1)
  const feeForCost = pool.fee_ppm ?? latest?.fee_ppm_observed ?? null
  const economics = {
    heat_1h: volumePersistence(vols, 1), heat_6h: volumePersistence(vols, 6),
    byDeposit: [200, 1000, 5000].map(D => { const s = latest?.sim?.[`d${D}`]?.r25; const daily = s && s.hours > 0 ? s.fees_usd / (s.hours / 24) : null
      return { D, cost: lifecycleCost(D, feeForCost, daily, econCfg.gas_usd_per_tx, econCfg.lifecycle_txs), dailyFeeUsd: daily } }),
    capacity: lastH ? { r10: capacityUsd(lastH.liquidity, lastH.price_usd, 0.10, econCfg.capacity_share), r25: capacityUsd(lastH.liquidity, lastH.price_usd, 0.25, econCfg.capacity_share), share: econCfg.capacity_share, activeLiquidity: lastH.liquidity } : null,
  }
  const wkAll = weekendStats(db); const w = wkAll.get(poolId); const weekend = w ? { ...w, fee_tvl: latest?.tvl_usd ? w.fees / latest.tvl_usd : null, window: weekendWindow() } : null
  return { pool: { ...pool, hook_flags: parse(pool.hook_flags) ?? [] }, snapshots, hourly, curves, corporateActions, latest, feeStats, economics, weekend }
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
const D65_FLAG_SINCE = '2026-09-26'   // swap_not_fetched 旗標開始寫入的第一個快照日
/** D65：同股票 × USDG、無流動性 hook、TVL ≥ min_tvl 的池（含費率低於下限的池）最近 n 天的 LP 實得費與 TVL。回傳第一筆是 poolId 自己 */
export function poolSeries(db: Database.Database, poolId: string, n = 7, minTvl = 5000): { held: PoolSeries | null; alts: PoolSeries[] } {
  const me = db.prepare('SELECT * FROM pools WHERE pool_id=?').get(poolId) as any; if (!me) return { held: null, alts: [] }
  const stock = me.stock_is_token0 ? me.token0 : me.token1
  const rows = db.prepare(`SELECT p.pool_id, p.protocol, p.fee_ppm, p.hook_kind, p.hooks, p.created_at FROM pools p WHERE (CASE WHEN p.stock_is_token0=1 THEN p.token0 ELSE p.token1 END)=? AND COALESCE(p.quote_kind,'usdg')='usdg'`).all(stock) as any[]
  // 以自己最新快照日往回 n 個日曆日為共同截止，不是「最近 n 筆」：漏掃後幾週前的高量日才不會留在平均裡（Codex code review）
  const latestDate = (db.prepare('SELECT MAX(date) d FROM pool_snapshots WHERE pool_id=?').get(poolId) as { d: string | null }).d
  if (!latestDate) return { held: null, alts: [] }
  const since = new Date(Date.parse(latestDate) - (n - 1) * 86400000).toISOString().slice(0, 10)
  const snapQ = db.prepare('SELECT date, fees_24h_usd, tvl_usd, flags, fee_ppm_observed, swap_count FROM pool_snapshots WHERE pool_id=? AND date>=? AND date<=? ORDER BY date')
  const build = (p: any): PoolSeries | null => {
    const snaps = snapQ.all(p.pool_id, since, latestDate) as any[]
    const latestTvl = snaps.length ? snaps[snaps.length - 1].tvl_usd : null
    const hookKind = p.hook_kind ?? (p.hooks === '0x0000000000000000000000000000000000000000' ? 'none' : 'liquidity')
    if (p.pool_id !== poolId && (hookKind === 'liquidity' || latestTvl === null || latestTvl < minTvl)) return null
    const observed = [...snaps].reverse().find(x => x.fee_ppm_observed !== null)?.fee_ppm_observed ?? null
    const feePpm = observed ?? p.fee_ppm ?? 3000
    const label = `${p.protocol} ${p.fee_ppm !== null ? (p.fee_ppm / 1e4).toFixed(2) + '%' : observed !== null ? '~' + (observed / 1e4).toFixed(2) + '%' : '動態'}`
    return { poolId: p.pool_id, label, swapFeeRate: feePpm / 1e6, hookKind, createdAt: p.created_at ?? null, days: snaps.map(x => { const flags: string[] = (() => { try { return JSON.parse(x.flags ?? '[]') } catch { return [] } })()
      // 沒抓 swap 的日子不能當成「費率 0」：新快照有 swap_not_fetched 旗標；D65 之前的舊快照沒有旗標，低費率池（fee_out_of_range）swap_count=0 就視為沒抓。抓了但整天沒成交算有效的零收益日（Codex plan review）
      const legacyUnfetched = x.date < D65_FLAG_SINCE && !flags.includes('swap_not_fetched') && flags.includes('fee_out_of_range') && (x.swap_count ?? 0) === 0   // 只套用在旗標上線前的快照；之後「抓了沒成交」是有效的零收益日（Codex code review）
      return { date: x.date, feesUsd: x.fees_24h_usd ?? 0, tvlUsd: x.tvl_usd, ok: !flags.includes('swap_fetch_failed') && !flags.includes('swap_not_fetched') && !flags.includes('protocol_fee_unknown') && !legacyUnfetched } }) }   // protocol_fee_unknown 那天存的是交易者總費，不能和 LP 實得互比（Codex code review）
  }
  const held = build(me)
  const alts = rows.filter(r => r.pool_id !== poolId).map(build).filter((x): x is PoolSeries => x !== null)
  return { held, alts }
}

export function listPositions(db: Database.Database) {
  const cfgAll = loadScoring(); const econCfg = cfgAll.economics
  const rows = db.prepare(`SELECT ps.*, t.symbol, p.fee_ppm FROM positions ps JOIN pools p ON p.pool_id=ps.pool_id
    JOIN tokens t ON t.address = CASE WHEN p.stock_is_token0 = 1 THEN p.token0 ELSE p.token1 END ORDER BY ps.id DESC`).all() as any[]
  return rows.map(r => {
    const from = Date.parse(r.opened_at) / 1000; const to = r.closed_at ? Date.parse(r.closed_at) / 1000 : Infinity
    const hours = loadHourly(db, r.pool_id, 24 * 45).filter(h => h.ts >= from && h.ts <= to)
    const P0 = hours[0]?.priceUsd
    const R = P0 ? (r.range_upper - r.range_lower) / (2 * P0) : 0.25
    const est = hours.length ? simulateHourly(hours, r.deposit_usd, R) : []   // 舊：固定投入（僅供 curve 以外的相容用途）
    const last = est[est.length - 1]
    const snaps = db.prepare('SELECT * FROM position_snapshots WHERE position_id=? ORDER BY date').all(r.id) as any[]
    const finalSnap = r.closed_at ? snaps[snaps.length - 1] : null
    const notes = (() => { try { return JSON.parse(r.notes ?? '') } catch { return null } })()
    const latest = snaps[snaps.length - 1]
    const journal = listJournal(db, r.id)
    // 已領的費：從快照偵測「未領費比前一天少」= 中間領過（手動領或加倉時自動結算）；同一段時間若日誌有 collect 的精確金額就用日誌，否則用快照差額（Codex review）
    const drops: { from: string; to: string; fromAt?: string | null; toAt?: string | null; amount: number }[] = []
    // 未領費是美元計價，股票側跌價也會讓它變小；只有掉超過一半（領取會歸零）且前值不是零頭才當成領過（Codex review）
    for (let i = 1; i < snaps.length; i++) if (snaps[i - 1].fees_cum_usd > 0.5 && snaps[i].fees_cum_usd < snaps[i - 1].fees_cum_usd * 0.5) drops.push({ from: snaps[i - 1].date, to: snaps[i].date, fromAt: snaps[i - 1].taken_at, toAt: snaps[i].taken_at, amount: snaps[i - 1].fees_cum_usd })
    const tp = (iso: string) => taipeiDate(new Date(iso))   // 快照的 date 是台北日期；日誌與流動性變動的時間戳是 UTC ISO，統一換成台北日期再比（Codex review）
    const collects = journal.filter(j => j.kind === 'collect').map(j => ({ ts: String(j.ts), usd: Number((j.data ?? {}).usd ?? (j.data ?? {}).fees_collected_usd ?? 0) })).filter(c => c.usd > 0)
    const events: { ts: string; date: string; usd: number; reinvested: number; reinvestTs?: string }[] = []; const used = new Set<number>()
    const inInterval = (c: { ts: string }, d: { from: string; to: string; fromAt?: string | null; toAt?: string | null }) =>
      d.fromAt && d.toAt ? (Date.parse(c.ts) > Date.parse(d.fromAt) && Date.parse(c.ts) <= Date.parse(d.toAt)) : (tp(c.ts) >= d.from && tp(c.ts) <= d.to)   // 舊快照沒時間戳：同日（含 from 當天）的日誌視為同一次領取，不再另加快照差額
    for (const d of drops) { const k = collects.findIndex((c, idx) => !used.has(idx) && inInterval(c, d)); if (k >= 0) { used.add(k); events.push({ ts: collects[k].ts, date: tp(collects[k].ts), usd: collects[k].usd, reinvested: 0 }) } else events.push({ ts: d.toAt ?? d.to + 'T00:00:00+08:00', date: d.to, usd: d.amount, reinvested: 0 }) }
    collects.forEach((c, idx) => { if (!used.has(idx)) events.push({ ts: c.ts, date: tp(c.ts), usd: c.usd, reinvested: 0 }) })
    // 「到某個快照為止」已領多少：有 taken_at 就用時間戳，舊快照退回台北日期
    const collectedBy = (sn: { date: string; taken_at?: string | null }) => events.filter(e => sn.taken_at ? Date.parse(e.ts) <= Date.parse(sn.taken_at) : e.date <= sn.date).reduce((a, e) => a + e.usd, 0)
    // 再投入的費：逐日（台北）判斷。該日 adjust 日誌有明寫 reinvested_usd 就用它；沒寫且該日流動性「增加」才把同日領取視為再投入；減倉日的領取是提走的
    const changes = ((notes?.liquidity_changes ?? []) as { at: string; from: string; to: string }[])
    const dayBefore = (d: string) => taipeiDate(new Date(Date.parse(d + 'T12:00:00+08:00') - 86400000))   // 以台北時間算前一天
    // at 是每日同步「觀察到」變動的時間，實際加倉發生在前一次同步之後 → 觀察日與前一日都算（Codex review）；日誌明寫時以日誌為準
    const increaseDays = new Set(changes.filter(c => { try { return BigInt(c.to) > BigInt(c.from) } catch { return false } }).flatMap(c => [tp(c.at), dayBefore(tp(c.at))]))
    const explicitByDay = new Map<string, number>(); const explicitList: { ts: string; date: string; usd: number }[] = []
    for (const j of journal) if (j.kind === 'adjust' && j.data && j.data.reinvested_usd !== undefined) { const d = tp(String(j.ts)); explicitByDay.set(d, (explicitByDay.get(d) ?? 0) + Number(j.data.reinvested_usd)); explicitList.push({ ts: String(j.ts), date: d, usd: Number(j.data.reinvested_usd) }) }
    // 每次加倉一個視窗（前一日, 觀察日）：視窗內有明寫就用明寫，否則視窗內的領取全數視為再投入；再投入逐事件記到 events[].reinvested（可部分），視窗重疊時事件只用一次（Codex review）
    const usedDays = new Set<string>()
    const markReinvest = (win: string[], amountOrNull: number | null, at: string) => {
      const inWin = events.filter(e => win.includes(e.date) && e.usd - e.reinvested > 0)   // 允許對同一筆領取的「剩餘」再分配（Codex review）
      let left = amountOrNull === null ? Infinity : amountOrNull
      for (const e of inWin) { const r = Math.min(e.usd - e.reinvested, left); e.reinvested += r; e.reinvestTs = at; left -= r; if (left <= 0) break }
      if (amountOrNull !== null && left > 0 && left !== Infinity) events.push({ ts: at, date: tp(at), usd: left, reinvested: left, reinvestTs: at })   // 明寫比觀察到的領取多：多的部分視為「有賺到且再投入」，領出為 0（Codex review）
    }
    for (const c of changes) { let inc = false; try { inc = BigInt(c.to) > BigInt(c.from) } catch { }
      if (!inc) continue
      const win = [dayBefore(tp(c.at)), tp(c.at)].filter(d => !usedDays.has(d)); win.forEach(d => usedDays.add(d))
      const exs = explicitList.filter(x => win.includes(x.date))
      if (exs.length) for (const x of exs) markReinvest(win, x.usd, x.ts)   // 每筆明寫各自帶自己的時間戳（Codex review）
      else markReinvest(win, null, c.at) }
    for (const d of new Set(explicitList.map(x => x.date))) if (!usedDays.has(d)) { for (const x of explicitList.filter(x => x.date === d)) markReinvest([d], x.usd, x.ts); usedDays.add(d) }   // 同日多筆全部處理再標記
    const reinvested = events.reduce((a, e) => a + e.reinvested, 0)
    const reinvestedBy = (iso: string) => events.reduce((a, e) => a + (e.reinvested > 0 && effReinvestTs(e) <= Date.parse(iso) ? e.reinvested : 0), 0)
    void increaseDays
    const liqChangeDays = new Set(changes.map(c => tp(c.at)))
    // D62：投入時間軸。adjust 日誌的 cash_added_usd 是帶正負號的外部本金淨流入（再投入的費不算）；某時點的投入 = 目前 deposit_usd − 該時點之後的流入
    const flows = journal.filter(j => j.kind === 'adjust' && j.data && j.data.cash_added_usd !== undefined).map(j => ({ ts: String(j.ts), usd: Number(j.data.cash_added_usd) }))
    const capitalAt = (iso: string) => r.deposit_usd - flows.filter(f => Date.parse(f.ts) > Date.parse(iso)).reduce((a, f) => a + f.usd, 0)
    /** 區間內的「投入 × 小時」：在加減倉時點切段，不是拿區間結束時的投入乘整段（Codex review D69） */
    const clampClose = (iso: string) => r.closed_at && Date.parse(iso) > Date.parse(r.closed_at) ? r.closed_at : iso
    const capitalHours = (fromIso: string, toIso: string) => {
      const a = Date.parse(fromIso), b = Date.parse(toIso); if (!(b > a)) return 0
      const cuts = [a, ...flows.map(f => Date.parse(f.ts)).filter(t => t > a && t < b).sort((x, y) => x - y), b]
      let sum = 0; for (let k = 1; k < cuts.length; k++) sum += capitalAt(new Date(cuts[k - 1]).toISOString()) * (cuts[k] - cuts[k - 1]) / 3600000
      return sum
    }
    const effReinvestTs = (e: { ts: string; reinvestTs?: string }) => Math.max(Date.parse(e.ts), Date.parse(e.reinvestTs ?? e.ts))   // 再投入不可能早於領取；日誌時間誤填時以領取時間為準（Codex review）
    const withdrawnBy = (iso: string) => events.reduce((a, e) => a + (Date.parse(e.ts) <= Date.parse(iso) ? e.usd : 0) - (e.reinvested > 0 && effReinvestTs(e) <= Date.parse(iso) ? e.reinvested : 0), 0)   // 領出在領取時生效、再投入在存回時扣
    const snapIso = (sn: any) => sn.taken_at ?? (sn.date + 'T23:59:59+08:00')
    const actual = latest && notes?.source === 'onchain' ? { date: latest.date, value_usd: latest.value_usd, fees_cum_usd: latest.fees_cum_usd, in_range: !!latest.in_range,
      net_usd: latest.value_usd + latest.fees_cum_usd + withdrawnBy(snapIso(latest)) - capitalAt(snapIso(latest)), fees_withdrawn_usd: withdrawnBy(snapIso(latest)), fees_reinvested_usd: reinvestedBy(snapIso(latest)), capital_usd: capitalAt(snapIso(latest)), days: Math.max(1, Math.round((Date.parse(latest.date) - Date.parse(r.opened_at.slice(0, 10))) / 86400000) + 1), deposit_estimated: !!notes.deposit_estimated } : null
    // 每日「實際 vs 模擬」：模擬取該日最後一小時的累積值
    // D62：模擬承接同一部位、在加倉時點加流動性（不重新建倉）；實際淨損益對「當時的投入」算，領出的費加回
    const D0 = capitalAt(r.opened_at); const capEvents = [...flows.map(f => ({ ts: Date.parse(f.ts) / 1000, usd: f.usd, kind: 'capital' as const })), ...events.filter(e => e.reinvested > 0).map(e => ({ ts: effReinvestTs(e) / 1000, usd: e.reinvested, kind: 'reinvest' as const }))]
    const simCap = hours.length ? simulateWithCapital(hours, D0, r.range_lower, r.range_upper, capEvents) : []
    const simByDate = new Map<string, number>(); for (const e of simCap) simByDate.set(taipeiDate(new Date(e.ts * 1000)), e.net)
    const history = snaps.map(sn => ({ date: sn.date, actual: sn.value_usd + sn.fees_cum_usd + withdrawnBy(snapIso(sn)) - capitalAt(snapIso(sn)), sim: simByDate.get(sn.date) ?? null, capital: capitalAt(snapIso(sn)) }))
    const capitalMarks = flows.map(f => ({ date: tp(f.ts), usd: f.usd }))
    // D61：持倉中的保本線。L 用鏈上真實流動性（notes.liquidity，加減倉後仍正確）；已賺的費 = 目前未領 + 日誌裡領過的；
    // 費速 = 最近 7 天「已賺總額」的差（未領會在領取時歸零，所以要把領取日誌加回去），不足 7 天資料退回持有期平均並標示
    let breakeven: any = null
    if (actual && !r.closed_at && notes?.liquidity && hours.length) {
      const Pnow = hours[hours.length - 1].priceUsd ?? null
      const earnedNow = latest.fees_cum_usd + collectedBy(latest)
      const cutoff = new Date(Date.parse(latest.date) - 7 * 86400000).toISOString().slice(0, 10)
      const ref = [...snaps].reverse().find(sn => sn.date <= cutoff) ?? snaps[0]
      const spanDays = Math.max(1, (Date.parse(latest.date) - Date.parse(ref.date)) / 86400000)
      const earnedRef = ref === latest ? 0 : ref.fees_cum_usd + collectedBy(ref)
      const pace = ref === latest ? earnedNow / Math.max(1, actual.days) : (earnedNow - earnedRef) / spanDays
      const paceBasis = ref === latest ? '持有期平均' : snaps.length && ref.date <= cutoff ? '近 7 天' : `近 ${Math.round(spanDays)} 天`
      if (Pnow && Pnow > 0) {
        const costsIncurred = journal.filter(j => (j.kind === 'open' || j.kind === 'adjust' || j.kind === 'collect') && j.data).reduce((a, j) => a + Number(j.data.costs_usd ?? 0) + Number(j.data.gas_usd ?? 0), 0)   // 已發生的進場成本（Codex review）
        const be = exitBreakeven({ D: r.deposit_usd, P0: Pnow, Pl: r.range_lower, Pu: r.range_upper, L: Number(notes.liquidity) / L_HUMAN_TO_RAW, dailyFeeUsd: pace > 0 ? pace : null,
          swapFeeRate: (((db.prepare('SELECT fee_ppm_observed f FROM pool_snapshots WHERE pool_id=? AND fee_ppm_observed IS NOT NULL ORDER BY date DESC LIMIT 1').get(r.pool_id) as any)?.f ?? r.fee_ppm ?? 3000) / 1e6) + 0.001, /* 觀察到的是交易者付的總費（含協議費），動態池也適用 */ gasPerTx: econCfg.gas_usd_per_tx, txs: 2, live: { feesEarnedUsd: earnedNow - reinvested, costsIncurredUsd: costsIncurred } })
        breakeven = { lower: be.lower, upper: be.upper, paceUsdPerDay: pace, paceBasis, feesEarnedUsd: earnedNow, feesReinvestedUsd: reinvested, priceNow: Pnow, capitalChanged: liqChangeDays.size > 0 }   // 加減倉後 deposit_usd 需人工確認（Codex review）
      }
    }
    // D68：每筆快照與前一筆之間的已賺手續費（未領 + 領過的），第一筆從開倉起算；給每週彙整用
    // D69：相鄰快照的新賺手續費用代幣數量增量估值（feeDelta），舊快照沒有數量時退回美元差
    const fsnap = (sn: any) => ({ fees_cum_usd: sn.fees_cum_usd, fees_stock: sn.fees_stock ?? null, fees_usdg: sn.fees_usdg ?? null, price_usd: sn.price_usd ?? null, collected: collectedBy(sn) })
    const dailyFees = notes?.source === 'onchain' ? snaps.map((sn, k) => ({ date: sn.date, usd: feeDelta(k ? fsnap(snaps[k - 1]) : null, fsnap(sn)), capitalUsd: capitalAt(snapIso(sn)),
      hours: Math.max(0, (Date.parse(snapIso(sn)) - Date.parse(k ? snapIso(snaps[k - 1]) : r.opened_at)) / 3600000),
      capHours: capitalHours(k ? snapIso(snaps[k - 1]) : r.opened_at, clampClose(snapIso(sn))) })) : []   // 關倉當天的快照沒有 taken_at 會被當成 23:59:59，截到關倉時刻（Codex review D73）   // 當時的投入，加減倉後歷史週不會被改寫（Codex review）
    // D66：昨日手續費 = 最近兩筆快照之間「已賺總額」的差（未領 + 領過的）；只有一筆快照 → 從開倉起算
    let feesLastDay: { usd: number; hours: number; from: string; to: string; capitalUsd: number; capHours: number } | null = null
    if (latest && !r.closed_at && notes?.source === 'onchain') {
      const prev = snaps.length >= 2 ? snaps[snaps.length - 2] : null
      const toIso = snapIso(latest); const fromIso = prev ? snapIso(prev) : r.opened_at; const last = dailyFees[dailyFees.length - 1]
      feesLastDay = { usd: last.usd, hours: last.hours, from: fromIso, to: toIso, capitalUsd: last.capitalUsd, capHours: last.capHours }
    }
    // D65：換池提示。只對持有中的頭寸；費速用保本線的 7 天 pace（沒有就 null，不判冷）
    // D67：用這個頭寸的區間與目前投入，在自己的池和同股票各池的逐小時資料上重放，只比美股交易日、兩邊資料都完整的同一批日子
    let switchHintOut: SwitchHint | null = null
    if (!r.closed_at) { const { held: hs, alts } = poolSeries(db, r.pool_id, 8, cfgAll.exclusions.min_tvl_usd)
      if (hs) {
        const cap = actual?.capital_usd ?? r.deposit_usd
        const validUtc = (ps: PoolSeries) => new Set(ps.days.filter(d => d.ok).map(d => snapshotToUtcDay(d.date)))
        // 共同起點：所有池只取視窗起點之後的小時，並用自己池在起點的價格建倉（D69）
        const heldH = loadHourly(db, hs.poolId, 24 * 9); const t0 = heldH.length ? heldH[0].ts : 0; const P0 = heldH.length ? heldH[0].priceUsd : undefined
        const replayS = (ps: PoolSeries) => replayStats((ps.poolId === hs.poolId ? heldH : loadHourly(db, ps.poolId, 24 * 9)).filter(h => h.ts >= t0), cap, r.range_lower, r.range_upper, validUtc(ps), P0)
        const replay = (ps: PoolSeries) => replayS(ps).daily
        const asOf = hs.days.length ? hs.days[hs.days.length - 1].date : null
        const altPools: AltPool[] = alts.filter(a => a.hookKind !== 'liquidity').map(a => { const tv = a.days.map(d => d.tvlUsd).filter((x): x is number => x !== null)
          return { poolId: a.poolId, label: a.hookKind === 'fee_only' ? a.label.replace(/~[\d.]+%|動態/, '動態') : a.label, hookKind: a.hookKind as 'none' | 'fee_only',
            ageDays: a.createdAt && asOf ? (Date.parse(asOf) - Date.parse(a.createdAt.slice(0, 10))) / 86400000 : null,
            tvlNow: tv.length ? tv[tv.length - 1] : null, tvlMin7: tv.length ? Math.min(...tv) : null, tvlMax7: tv.length ? Math.max(...tv) : null, ...(() => { const both = new Set([...validUtc(a)].filter(d => validUtc(hs).has(d)))   // 佔比只算兩池都有效的共同交易日，跟報酬比較同一批日子（Codex review）
            return { daily: replayS(a).daily, share: replayStats((loadHourly(db, a.poolId, 24 * 9)).filter(h => h.ts >= t0), cap, r.range_lower, r.range_upper, both, P0).feeWeightedShare } })() } })
        let acc = 0; const wp = weekdayPace(dailyFees.map(d => ({ date: d.date, earned: (acc += d.usd) })))   // D69：與每日手續費同口徑
        switchHintOut = switchHint({ held: replay(hs), alts: altPools, depositUsd: cap, weekdayPace: wp.pace, tradingDaysHeld: wp.days, inRange: actual ? actual.in_range : true, cfg: cfgAll.switch_hint })
      } }
    return { ...r, notes_json: notes, journal, breakeven, switchHint: switchHintOut, feesLastDay, dailyFees, est: simCap.length ? (() => { const e = simCap[simCap.length - 1]; const P = hours[hours.length - 1].priceUsd; return { value_usd: e.valueH, fees_cum_usd: e.grossFees, fees_reinvested_usd: e.reinvested, capital_usd: e.capital, in_range: P >= r.range_lower && P <= r.range_upper, net_usd: e.net, price: P, hours: simCap.length } })() : null,
      actual, closeTailCapHours: r.closed_at && snaps.length ? capitalHours(snapIso(snaps[snaps.length - 1]), r.closed_at) : 0, liveBasis: { capital_usd: capitalAt(new Date().toISOString()), withdrawn_usd: withdrawnBy(new Date().toISOString()) }, history, capitalMarks, feesWithdrawnUsd: withdrawnBy(latest ? snapIso(latest) : new Date().toISOString()), feesReinvestedUsd: reinvested, curve: simCap.map(e => ({ ts: e.ts, net: e.net })), final: finalSnap ? { value_usd: finalSnap.value_usd, fees_cum_usd: finalSnap.fees_cum_usd } : null }
  })
}

export type JournalKind = 'open' | 'note' | 'adjust' | 'collect' | 'close' | 'review'
export function addJournal(db: Database.Database, positionId: number, kind: JournalKind, text: string, data?: unknown): number {
  return Number(db.prepare('INSERT INTO position_journal(position_id,ts,kind,text,data) VALUES (?,?,?,?,?)').run(positionId, new Date().toISOString(), kind, text, data ? JSON.stringify(data) : null).lastInsertRowid)
}
export function listJournal(db: Database.Database, positionId: number) {
  return (db.prepare('SELECT * FROM position_journal WHERE position_id=? ORDER BY ts').all(positionId) as any[]).map(r => ({ ...r, data: r.data ? JSON.parse(r.data) : null }))
}
/** 每筆頭寸一個 JSON：基本資料、開倉交易、每日快照、模擬對照、日誌。給使用者離線檢討用（DECISIONS D32） */
export function exportPositions(db: Database.Database, dir: string): string[] {
  mkdirSync(dir, { recursive: true })
  const files: string[] = []
  for (const p of listPositions(db)) {
    const pool = db.prepare('SELECT protocol, fee_ppm, hooks, token0, token1, stock_is_token0 FROM pools WHERE pool_id=?').get(p.pool_id)
    const snaps = db.prepare('SELECT date, value_usd, fees_cum_usd, in_range FROM position_snapshots WHERE position_id=? ORDER BY date').all(p.id)
    const key = positionKey(p.notes_json, p.id)
    const out = { id: p.id, label: p.label, symbol: p.symbol, pool_id: p.pool_id, pool, range_usd: [p.range_lower, p.range_upper], deposit_usd: p.deposit_usd,
      opened_at: p.opened_at, closed_at: p.closed_at, onchain: p.notes_json, latest_actual: p.actual, latest_sim_estimate: p.est, daily: snaps, actual_vs_sim: p.history, final: p.final, journal: listJournal(db, p.id), exported_at: new Date().toISOString() }
    const f = `${dir}/${key}.json`; writeFileSync(f, JSON.stringify(out, null, 2)); files.push(f)
  }
  return files
}

export function positionKey(notes: any, id: number): string {
  if (!notes?.tokenId) return `manual-${id}`
  return notes.protocol === 'v3' ? `v3-${notes.tokenId}` : String(notes.tokenId)
}
