// server/queries.ts — dashboard 用的唯讀查詢（頭寸登錄除外），可用 :memory: 測試
import type Database from 'better-sqlite3'
import { mkdirSync, writeFileSync } from 'node:fs'
import { simulateHourly, type SimHour } from '../scanner/metrics/simulate.js'
import { loadHourly } from '../scanner/steps.js'
import { rvolRange } from '../scanner/metrics/volatility.js'
import { lifecycleCost, capacityUsd, volumePersistence, exitBreakeven } from '../scanner/metrics/economics.js'
import { L_HUMAN_TO_RAW } from '../scanner/metrics/lp-math.js'
import { taipeiDate } from '../scanner/time.js'
import { loadScoring } from '../config/chain.js'

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
export function listPositions(db: Database.Database) {
  const econCfg = loadScoring().economics
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
    const notes = (() => { try { return JSON.parse(r.notes ?? '') } catch { return null } })()
    const latest = snaps[snaps.length - 1]
    const actual = latest && notes?.source === 'onchain' ? { date: latest.date, value_usd: latest.value_usd, fees_cum_usd: latest.fees_cum_usd, in_range: !!latest.in_range,
      net_usd: latest.value_usd + latest.fees_cum_usd - r.deposit_usd, days: Math.max(1, Math.round((Date.parse(latest.date) - Date.parse(r.opened_at.slice(0, 10))) / 86400000) + 1), deposit_estimated: !!notes.deposit_estimated } : null
    // 每日「實際 vs 模擬」：模擬取該日最後一小時的累積值
    const simByDate = new Map<string, number>(); for (const e of est) simByDate.set(new Date(e.row.ts * 1000).toISOString().slice(0, 10), e.valueH + e.cumFees - r.deposit_usd)
    const history = snaps.map(sn => ({ date: sn.date, actual: sn.value_usd + sn.fees_cum_usd - r.deposit_usd, sim: simByDate.get(sn.date) ?? null }))
    // D61：持倉中的保本線。L 用鏈上真實流動性（notes.liquidity，加減倉後仍正確）；已賺的費 = 目前未領 + 日誌裡領過的；
    // 費速 = 最近 7 天「已賺總額」的差（未領會在領取時歸零，所以要把領取日誌加回去），不足 7 天資料退回持有期平均並標示
    const journal = listJournal(db, r.id)
    // 已領的費：從快照偵測「未領費比前一天少」= 中間領過（手動領或加倉時自動結算）；同一段時間若日誌有 collect 的精確金額就用日誌，否則用快照差額（Codex review）
    const drops: { from: string; to: string; fromAt?: string | null; toAt?: string | null; amount: number }[] = []
    // 未領費是美元計價，股票側跌價也會讓它變小；只有掉超過一半（領取會歸零）且前值不是零頭才當成領過（Codex review）
    for (let i = 1; i < snaps.length; i++) if (snaps[i - 1].fees_cum_usd > 0.5 && snaps[i].fees_cum_usd < snaps[i - 1].fees_cum_usd * 0.5) drops.push({ from: snaps[i - 1].date, to: snaps[i].date, fromAt: snaps[i - 1].taken_at, toAt: snaps[i].taken_at, amount: snaps[i - 1].fees_cum_usd })
    const tp = (iso: string) => taipeiDate(new Date(iso))   // 快照的 date 是台北日期；日誌與流動性變動的時間戳是 UTC ISO，統一換成台北日期再比（Codex review）
    const collects = journal.filter(j => j.kind === 'collect').map(j => ({ ts: String(j.ts), usd: Number((j.data ?? {}).usd ?? (j.data ?? {}).fees_collected_usd ?? 0) })).filter(c => c.usd > 0)
    const events: { ts: string; date: string; usd: number }[] = []; const used = new Set<number>()
    const inInterval = (c: { ts: string }, d: { from: string; to: string; fromAt?: string | null; toAt?: string | null }) =>
      d.fromAt && d.toAt ? (Date.parse(c.ts) > Date.parse(d.fromAt) && Date.parse(c.ts) <= Date.parse(d.toAt)) : (tp(c.ts) >= d.from && tp(c.ts) <= d.to)   // 舊快照沒時間戳：同日（含 from 當天）的日誌視為同一次領取，不再另加快照差額
    for (const d of drops) { const k = collects.findIndex((c, idx) => !used.has(idx) && inInterval(c, d)); if (k >= 0) { used.add(k); events.push({ ts: collects[k].ts, date: tp(collects[k].ts), usd: collects[k].usd }) } else events.push({ ts: d.toAt ?? d.to + 'T00:00:00+08:00', date: d.to, usd: d.amount }) }
    collects.forEach((c, idx) => { if (!used.has(idx)) events.push({ ts: c.ts, date: tp(c.ts), usd: c.usd }) })
    // 「到某個快照為止」已領多少：有 taken_at 就用時間戳，舊快照退回台北日期
    const collectedBy = (sn: { date: string; taken_at?: string | null }) => events.filter(e => sn.taken_at ? Date.parse(e.ts) <= Date.parse(sn.taken_at) : e.date <= sn.date).reduce((a, e) => a + e.usd, 0)
    // 再投入的費：逐日（台北）判斷。該日 adjust 日誌有明寫 reinvested_usd 就用它；沒寫且該日流動性「增加」才把同日領取視為再投入；減倉日的領取是提走的
    const changes = ((notes?.liquidity_changes ?? []) as { at: string; from: string; to: string }[])
    const dayBefore = (d: string) => taipeiDate(new Date(Date.parse(d + 'T12:00:00+08:00') - 86400000))   // 以台北時間算前一天
    // at 是每日同步「觀察到」變動的時間，實際加倉發生在前一次同步之後 → 觀察日與前一日都算（Codex review）；日誌明寫時以日誌為準
    const increaseDays = new Set(changes.filter(c => { try { return BigInt(c.to) > BigInt(c.from) } catch { return false } }).flatMap(c => [tp(c.at), dayBefore(tp(c.at))]))
    const explicitByDay = new Map<string, number>()
    for (const j of journal) if (j.kind === 'adjust' && j.data && j.data.reinvested_usd !== undefined) { const d = tp(String(j.ts)); explicitByDay.set(d, (explicitByDay.get(d) ?? 0) + Number(j.data.reinvested_usd)) }
    // 每次加倉一個視窗（前一日, 觀察日）：視窗內有明寫就用明寫，否則用視窗內的領取；視窗重疊時事件只用一次（Codex review）
    const usedDays = new Set<string>(); let reinvested = 0
    for (const c of changes) { let inc = false; try { inc = BigInt(c.to) > BigInt(c.from) } catch { }
      if (!inc) continue
      const win = [dayBefore(tp(c.at)), tp(c.at)].filter(d => !usedDays.has(d)); win.forEach(d => usedDays.add(d))
      const ex = win.reduce((a, d) => a + (explicitByDay.get(d) ?? 0), 0)
      reinvested += win.some(d => explicitByDay.has(d)) ? ex : events.filter(e => win.includes(e.date)).reduce((a, e) => a + e.usd, 0) }
    for (const [d, v] of explicitByDay) if (!usedDays.has(d)) { reinvested += v; usedDays.add(d) }   // 日誌明寫但沒觀察到流動性變動（舊資料）
    void increaseDays
    const liqChangeDays = new Set(changes.map(c => tp(c.at)))
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
    return { ...r, notes_json: notes, journal, breakeven, est: last ? { value_usd: last.valueH, fees_cum_usd: last.cumFees, in_range: last.inRange, net_usd: last.valueH + last.cumFees - r.deposit_usd, price: last.row.priceUsd, hours: est.length } : null,
      actual, history, curve: est.map(e => ({ ts: e.row.ts, net: e.valueH + e.cumFees - r.deposit_usd })), final: finalSnap ? { value_usd: finalSnap.value_usd, fees_cum_usd: finalSnap.fees_cum_usd } : null }
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
