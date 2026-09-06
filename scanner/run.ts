// scanner/run.ts — 每日流程。純唯讀：只讀鏈、只讀 REST、只寫本機 SQLite、只推 Telegram（SPEC §10）
import 'dotenv/config'
import { openDb, getMeta, setMeta } from '../db/index.js'
import { ADDR, CHAIN, loadScoring } from '../config/chain.js'
import { ApiUsage } from './sources/usage.js'
import { makeRpc } from './sources/rpc.js'
import { fetchAssets, fetchCorporateActions, fetchPrice, type RhQuote } from './sources/robinhood.js'
import { fetchTokenPairs } from './sources/dexscreener.js'
import { discoverUsdgPools, fetchSwaps } from './sources/uniswapV4.js'
import { discoverV3UsdgPools, fetchV3Swaps, fetchV3LiquidityEvents } from './sources/uniswapV3.js'
import { aggregateHourly } from './metrics/hourly.js'
import { ageDays, vol7, priceDevPct } from './metrics/derived.js'
import { hardExclusions } from './metrics/exclusions.js'
import { formatDailySummary } from './notify/summary.js'
import { sendTelegram } from './notify/telegram.js'
import { taipeiDate, isUsWeekday } from './time.js'
import { upsertTokens, upsertPools, writeHourly, writeSnapshot, previousCandidates, recentVolumes, pruneHourly, isStockUsdgPool, loadHourly, updateSim } from './steps.js'
import { simulateAll, type SimJson } from './metrics/simulate.js'
import { weeklySigma } from './metrics/volatility.js'
import { scorePools, getSimField } from './metrics/score.js'
import { analyzeWash, type WashSwap } from './metrics/wash.js'
import { fetchModifyLiquidity } from './sources/uniswapV4.js'
import { makeTraderRpc, resolveTxFrom } from './sources/traders.js'
import { updateWash } from './steps.js'
import { listPositions } from '../server/queries.js'
import { lastKnownTvl, backfillHookInfo } from './steps.js'
import { median } from './metrics/hooks.js'
import { runPositionsStage } from './positionsStage.js'

const WEEKDAY_ZH = ['日', '一', '二', '三', '四', '五', '六']
const STOCKISH = /^[A-Z]{1,5}$/
const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`)

export async function runDaily(opts: { dbPath?: string; now?: Date; simOnly?: boolean } = {}) {
  const now = opts.now ?? new Date(); const date = taipeiDate(now); const usage = new ApiUsage()
  const db = openDb(opts.dbPath ?? 'db/lp.sqlite'); const scoring = loadScoring()
  const runId = Number(db.prepare(`INSERT INTO scan_runs(started_at) VALUES (?)`).run(now.toISOString()).lastInsertRowid)
  let poolsScanned = 0, swapPools = 0
  try {
    if (!opts.simOnly) {
    const rpc = makeRpc({ usage })
    // 1. 白名單與公司行動
    const assets = await fetchAssets({ usage }); upsertTokens(db, assets, now.toISOString()); log(`assets ${assets.length}`)
    const stockByAddr = new Map(assets.map(a => [a.address, a])); const stockSet = new Set(stockByAddr.keys())
    const cas = await fetchCorporateActions({ usage })
    const caSt = db.prepare(`INSERT OR REPLACE INTO corporate_actions(id,token,type,status,effective_at,pending_multiplier,raw) VALUES (?,?,?,?,?,?,?)`)
    for (const c of cas) caSt.run(c.id, c.address, c.type, c.status, c.effectiveAt, stockByAddr.get(c.address)?.pendingMultiplier ?? '', JSON.stringify(c.raw))
    log(`corporate actions ${cas.length}`)
    // 2. 池子發現（增量）
    const latest = await rpc.getBlockNumber()
    const lastDisc = getMeta(db, 'last_discovery_block')
    const from = lastDisc ? BigInt(lastDisc) + 1n : latest - BigInt(30 * CHAIN.blocksPerDay)
    if (!lastDisc) log('尚未 backfill，只掃最近 30 天的 Initialize；請跑 pnpm backfill 補齊')
    const found = [...await discoverUsdgPools(rpc, from, latest), ...await discoverV3UsdgPools(rpc, from, latest)]
    const blockTs = new Map<string, string>()
    for (const p of found) if (isStockUsdgPool(p, stockSet) && !blockTs.has(p.createdBlock.toString()))
      blockTs.set(p.createdBlock.toString(), new Date(Number((await rpc.call(() => rpc.client.getBlock({ blockNumber: p.createdBlock }))).timestamp) * 1000).toISOString())
    log(`discovery ${from}→${latest}: ${found.length} usdg pools (v3 ${found.filter(f => f.protocol === 'v3').length}), ${upsertPools(db, found, stockSet, blockTs)} new stock pools`)
    setMeta(db, 'last_discovery_block', latest.toString())
    // 3. TVL（DexScreener）與參考價（Robinhood）
    { const n = backfillHookInfo(db); if (n) log(`hook info backfilled for ${n} pools`) }
    const pools = db.prepare('SELECT * FROM pools').all() as any[]
    const stockAddrsWithPools = [...new Set<string>(pools.map(p => p.stock_is_token0 ? p.token0 : p.token1))]
    const tvlByPool = new Map<string, number | null>(); const quoteBySymbol = new Map<string, RhQuote | null>()
    for (const addr of stockAddrsWithPools) {
      try { for (const pair of await fetchTokenPairs({ usage }, addr)) tvlByPool.set(pair.pairId, pair.liquidityUsd) } catch (e) { log(`dexscreener ${addr}: ${(e as Error).message}`) }
      const sym = stockByAddr.get(addr)?.tokenSymbol
      if (sym && !quoteBySymbol.has(sym)) { try { quoteBySymbol.set(sym, await fetchPrice({ usage }, sym)) } catch (e) { quoteBySymbol.set(sym, null); log(`price ${sym}: ${(e as Error).message}`) } }
    }
    log(`tvl for ${tvlByPool.size} pairs, quotes ${quoteBySymbol.size}`)
    // 4. 每池：Swap → hourly → snapshot
    const dayFrom = latest - BigInt(CHAIN.blocksPerDay)
    const tsFrom = Number((await rpc.call(() => rpc.client.getBlock({ blockNumber: dayFrom }))).timestamp)
    const tsTo = Number((await rpc.call(() => rpc.client.getBlock({ blockNumber: latest }))).timestamp)
    const interp = (b: bigint) => tsFrom + Number(b - dayFrom) * (tsTo - tsFrom) / Number(latest - dayFrom)   // DECISIONS D12
    const nextCa = db.prepare(`SELECT MIN(effective_at) e FROM corporate_actions WHERE token=? AND effective_at>=?`)
    for (const p of pools) {
      poolsScanned++
      const stockAddr: string = p.stock_is_token0 ? p.token0 : p.token1; const asset = stockByAddr.get(stockAddr)
      const hookKind: 'none' | 'fee_only' | 'liquidity' = p.hook_kind ?? (p.hooks === ADDR.zero ? 'none' : 'liquidity')
      // 動態費率池（fee_ppm NULL）在純費率 hook 下先拉 swap，用觀察到的中位數當費率（D36）
      const feeOk = p.fee_ppm === null ? hookKind === 'fee_only' : (p.fee_ppm >= scoring.exclusions.fee_ppm_min && p.fee_ppm <= scoring.exclusions.fee_ppm_max)
      let tvl = tvlByPool.get(p.pool_id) ?? null; let tvlStale = false
      if (tvl === null) { const prevTvl = lastKnownTvl(db, p.pool_id, date); if (prevTvl !== null) { tvl = prevTvl; tvlStale = true } }   // DECISIONS D31：來源缺漏時沿用前值
      // DECISIONS D16：只對無 hooks、費率合理、DexScreener TVL ≥ 門檻的池拉 Swap（其餘必被硬排除）
      const worth = hookKind !== 'liquidity' && feeOk && tvl !== null && tvl >= scoring.scan.swap_fetch_min_tvl_usd
      if (worth) swapPools++
      let hourly: ReturnType<typeof aggregateHourly> = []; let swapFetchFailed = false; let feeObserved: number | null = null
      if (worth) {
        try { const sw = p.protocol === 'v3' ? await fetchV3Swaps(rpc, p.pool_id, p.fee_ppm, dayFrom, latest) : await fetchSwaps(rpc, p.pool_id, dayFrom, latest); hourly = aggregateHourly(sw, interp, !!p.stock_is_token0, tsFrom, tsTo); feeObserved = median(sw.map(x => x.fee)) }
        catch (e) { swapFetchFailed = true; log(`swaps ${p.pool_id.slice(0, 10)}: ${String((e as Error).message).split('\n')[0]}`) }
      }
      if (hourly.length) writeHourly(db, p.pool_id, hourly)
      const volume = hourly.reduce((a, r) => a + r.volumeUsd, 0), fees = hourly.reduce((a, r) => a + r.feesUsd, 0), swaps = hourly.reduce((a, r) => a + r.swapCount, 0)
      const lastPrice = [...hourly].reverse().find(r => r.priceUsd !== null)?.priceUsd ?? null
      const quoteRaw = asset ? quoteBySymbol.get(asset.tokenSymbol) ?? null : null
      // D40：Robinhood 週末/盤後報價價差可達 20%（GLD bid 406 / ask 500），價差 > 2% 的參考價不採用
      const refWide = !!quoteRaw && quoteRaw.spreadPct > scoring.scan.ref_max_spread_pct
      const quote = refWide ? { ...quoteRaw, mid: NaN } : quoteRaw
      const age = p.created_at ? ageDays(p.created_at, date) : null
      const v7 = vol7([...recentVolumes(db, p.pool_id, date), volume])
      const caRow = asset ? (nextCa.get(stockAddr, date) as { e: string | null })?.e : null
      const caDays = caRow ? ageDays(date, caRow) : null
      const effectiveFee: number | null = p.fee_ppm ?? feeObserved   // 動態費率池：觀察不到就 null → fee_out_of_range
      const flags = hardExclusions({ stockAddress: asset ? stockAddr : null, otherIsUsdg: true, symbolLooksLikeStock: STOCKISH.test(asset?.tokenSymbol ?? ''), hooks: p.hooks, hookKind, feePpm: effectiveFee,
        ageDays: age, tvlUsd: tvl, pendingMultiplier: asset?.pendingMultiplier ?? '', corpActionDaysAhead: caDays, isTradingHalt: quote?.isTradingHalt ?? null,
        rhStatus: asset?.status ?? null, wash: null, quoteKind: 'usdg' }, scoring.exclusions)
      if (v7.shortHistory) flags.push('short_history')
      if (swapFetchFailed) flags.push('swap_fetch_failed')
      if (tvlStale) flags.push('tvl_stale')
      if (refWide) flags.push('ref_wide_spread')
      writeSnapshot(db, { pool_id: p.pool_id, date, is_weekday: isUsWeekday(now) ? 1 : 0, tvl_usd: tvl, volume_24h_usd: volume, fees_24h_usd: fees, price_usd: lastPrice,
        price_ref_usd: refWide ? null : quote?.mid ?? null, price_dev_pct: lastPrice !== null && !refWide ? priceDevPct(lastPrice, quote?.mid ?? null, Number(asset?.currentMultiplier ?? 1)) : null,
        swap_count: swaps, fee_ppm_observed: feeObserved, vol_6h_usd: hourly.slice(-6).reduce((a, r) => a + r.volumeUsd, 0), vol_1h_usd: hourly.slice(-1).reduce((a, r) => a + r.volumeUsd, 0), age_days: age, vol7_avg_usd: v7.avg, vol7_cv: v7.cv, raw_apr: tvl && tvl > 0 ? fees * 365 / tvl : null,
        flags, excluded: flags.some(f => !['short_history', 'swap_fetch_failed', 'tvl_stale', 'hook_fee_only', 'ref_wide_spread'].includes(f)) ? 1 : 0 })
      if (poolsScanned % 25 === 0) log(`pools ${poolsScanned}/${pools.length} (calls ${JSON.stringify(usage.toJSON())})`)
    }
    } else { poolsScanned = (db.prepare('SELECT COUNT(*) c FROM pool_snapshots WHERE date=?').get(date) as any).c; log(`sim-only: ${poolsScanned} snapshots for ${date}`) }
    // 5. 模擬與評分（SPEC §7 / §8.3）：只對未硬排除的池（DECISIONS D22）
    const candRows = db.prepare(`SELECT s.pool_id, s.flags, s.vol7_cv, s.trader_count, s.price_dev_pct, t.all_day_tradable FROM pool_snapshots s JOIN pools p ON p.pool_id=s.pool_id
      JOIN tokens t ON t.address = CASE WHEN p.stock_is_token0=1 THEN p.token0 ELSE p.token1 END WHERE s.date=? AND s.excluded=0`).all(date) as any[]
    const simById = new Map<string, { sim: SimJson; flags: string[] }>()
    for (const r of candRows) {
      const hours = loadHourly(db, r.pool_id)
      const { sim, flags } = simulateAll(hours, weeklySigma(hours.map(h => h.priceUsd)))
      simById.set(r.pool_id, { sim, flags: [...JSON.parse(r.flags), ...flags, 'sigma_from_pool'] })   // DECISIONS 11.3
    }
    const scores = scorePools(candRows.map(r => ({ poolId: r.pool_id, sim: simById.get(r.pool_id)!.sim, vol7Cv: r.vol7_cv ?? 0, traderCount: r.trader_count, priceDevPct: r.price_dev_pct, allDayTradable: r.all_day_tradable === 'tradable' })), scoring)
    for (const [id, v] of simById) updateSim(db, id, date, v.sim, scores.get(id) ?? null, v.flags)
    log(`simulated ${simById.size} candidate pools`)
    // 6. 刷量分析（SPEC §5/§8.1，P3）：只對評分前 N 名，命中門檻加 wash_suspect 後重新評分（DECISIONS D26）
    const topN = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, scoring.wash_analysis_top_n).map(([id]) => id)
    if (topN.length) {
      const wrpc = makeRpc({ usage }); const latestW = await wrpc.getBlockNumber(); const dayFromW = latestW - BigInt(CHAIN.blocksPerDay)
      const tsFromW = Number((await wrpc.call(() => wrpc.client.getBlock({ blockNumber: dayFromW }))).timestamp)
      const tsToW = Number((await wrpc.call(() => wrpc.client.getBlock({ blockNumber: latestW }))).timestamp)
      const interpW = (b: bigint) => tsFromW + Number(b - dayFromW) * (tsToW - tsFromW) / Number(latestW - dayFromW)
      const { rpc: trpc, isAlchemy } = makeTraderRpc(usage); const SAMPLE = scoring.scan.wash_sample_swaps
      const poolInfo = new Map((db.prepare('SELECT * FROM pools').all() as any[]).map(p => [p.pool_id, p] as [string, any]))
      const th = scoring.exclusions; let washExcluded = 0
      for (const id of topN) {
        const p = poolInfo.get(id); if (!p) continue
        try {
          let swaps = p.protocol === 'v3' ? await fetchV3Swaps(wrpc, id, p.fee_ppm, dayFromW, latestW) : await fetchSwaps(wrpc, id, dayFromW, latestW)
          const lps = p.protocol === 'v3' ? await fetchV3LiquidityEvents(wrpc, id, dayFromW, latestW) : await fetchModifyLiquidity(wrpc, id, dayFromW, latestW)
          const total = swaps.length; const sampled = swaps.length > SAMPLE; if (sampled) swaps = swaps.slice(-SAMPLE)   // DECISIONS D25：只取最新 N 筆
          const fromMap = await resolveTxFrom(trpc, [...swaps.map(s => s.txHash), ...lps.map(l => l.txHash)])
          const stockIs0 = !!p.stock_is_token0
          const ws: WashSwap[] = swaps.map(s => {
            const usdg = stockIs0 ? s.amount1 : s.amount0; const stock = stockIs0 ? s.amount0 : s.amount1
            return { trader: fromMap.get(s.txHash) ?? s.sender, ts: Math.floor(interpW(s.blockNumber)), dir: stock < 0n ? 'buy' : 'sell', volumeUsd: Number(usdg < 0n ? -usdg : usdg) / 1e6 }
          })
          const m = analyzeWash(ws, new Set(lps.map(l => fromMap.get(l.txHash) ?? l.sender)))
          const hit = m.top1Share > th.wash_top1_share || m.pingpongRatio > th.wash_pingpong_ratio || m.lpOverlapVolumeShare > th.wash_overlap_volume_share
          const cur = simById.get(id)!; const flags = [...cur.flags.filter(f => f !== 'wash_suspect'), ...(hit ? ['wash_suspect'] : []), ...(sampled ? ['wash_sampled'] : [])]
          if (hit) { washExcluded++; scores.delete(id) }
          updateWash(db, id, date, m, flags, hit ? 1 : 0, sampled)
          log(`wash ${id.slice(0, 10)}: swaps ${total}${sampled ? ` (sampled ${SAMPLE})` : ''}, lps ${lps.length}, traders ${m.traderCount}, top1 ${(m.top1Share * 100).toFixed(0)}%, pingpong ${(m.pingpongRatio * 100).toFixed(0)}%, lpOverlapVol ${(m.lpOverlapVolumeShare * 100).toFixed(0)}%${hit ? ' ⚠️ wash_suspect' : ''}`)
        } catch (e) { log(`wash ${id.slice(0, 10)}: ${String((e as Error).message).split('\n')[0]}`) }
      }
      if (washExcluded) {   // 重新評分（被排除的不進百分位）
        const remain = candRows.filter(r => scores.has(r.pool_id))
        const re = scorePools(remain.map(r => ({ poolId: r.pool_id, sim: simById.get(r.pool_id)!.sim, vol7Cv: r.vol7_cv ?? 0, traderCount: (db.prepare('SELECT trader_count t FROM pool_snapshots WHERE pool_id=? AND date=?').get(r.pool_id, date) as any)?.t ?? null, priceDevPct: r.price_dev_pct, allDayTradable: r.all_day_tradable === 'tradable' })), scoring)
        for (const [id, sc] of re) db.prepare('UPDATE pool_snapshots SET score=? WHERE pool_id=? AND date=?').run(sc, id, date)
      }
      log(`wash analysis on ${topN.length} pools, ${washExcluded} flagged wash_suspect (traders via ${isAlchemy ? 'alchemy' : 'public rpc'})`)
    }
    // 7. 鏈上頭寸回填（P5）：TRACK_ADDRESS 有設才做，全部唯讀
    const trackAddr = process.env.TRACK_ADDRESS
    if (trackAddr) { try { await runPositionsStage(db, usage, trackAddr, date, now, log) } catch (e) { log(`positions: ${String((e as Error).message).split('\n')[0]}`) } }
    // 8. 摘要
    const today = db.prepare(`SELECT s.*, p.fee_ppm, p.protocol, t.symbol FROM pool_snapshots s JOIN pools p ON p.pool_id=s.pool_id
      JOIN tokens t ON t.address = CASE WHEN p.stock_is_token0=1 THEN p.token0 ELSE p.token1 END WHERE s.date=?`).all(date) as any[]
    const cands = today.filter(r => !r.excluded).sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
    const prev = previousCandidates(db, date); const cur = new Set(cands.map(c => c.pool_id))
    const label = (r: any) => `${r.symbol}/USDG ${r.protocol}`
    const changes = [...today.filter(r => prev.has(r.pool_id) && !cur.has(r.pool_id)).map(r => ({ label: label(r), kind: 'dropped' as const, reason: JSON.parse(r.flags).join(',') })),
                     ...cands.filter(r => !prev.has(r.pool_id) && prev.size > 0).map(r => ({ label: label(r), kind: 'added' as const }))]
    const text = formatDailySummary({ date, weekdayZh: WEEKDAY_ZH[new Date(date + 'T00:00:00+08:00').getDay()], poolsScanned, candidates: cands.length, sortKey: scoring.sort_key,
      top: cands.slice(0, 5).map(r => { const sim = r.sim ? JSON.parse(r.sim) as SimJson : null
        return { label: label(r), feePct: r.fee_ppm !== null ? (r.fee_ppm / 1e4).toFixed(2) + '%' : r.fee_ppm_observed !== null ? '~' + (r.fee_ppm_observed / 1e4).toFixed(2) + '%' : '動態', netApr: getSimField(sim, scoring.sort_key, scoring.rank_field ?? 'net_apr_trimmed'), inRangePct: getSimField(sim, scoring.sort_key, 'in_range_pct'), traderCount: r.trader_count } }), changes, positions: formatPositions(listPositions(db)), dashboardUrl: process.env.DASHBOARD_URL })
    console.log('\n' + text + '\n')
    const sent = await sendTelegram(text, { token: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID, topicId: process.env.TELEGRAM_TOPIC_ID })
    pruneHourly(db)
    db.prepare(`UPDATE scan_runs SET finished_at=?, ok=1, pools_scanned=?, api_calls=?, error=? WHERE id=?`)
      .run(new Date().toISOString(), poolsScanned, JSON.stringify(usage.toJSON()), sent === 'not_configured' ? 'telegram_not_configured' : null, runId)
    log(`done. swap-fetched pools=${swapPools}. telegram=${sent} api_calls=${JSON.stringify(usage.toJSON())}`)
  } catch (e) {
    db.prepare(`UPDATE scan_runs SET finished_at=?, ok=0, pools_scanned=?, api_calls=?, error=? WHERE id=?`).run(new Date().toISOString(), poolsScanned, JSON.stringify(usage.toJSON()), String((e as Error).stack ?? e), runId)
    throw e
  } finally { db.close() }
}
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)
if (isMain) runDaily({ simOnly: process.argv.includes('--sim-only') }).catch(e => { console.error(e); process.exit(1) })

/** 摘要的「我的頭寸」列：未關閉的頭寸。有鏈上快照 → 實際 vs 模擬；否則只有模擬估算（DECISIONS D27/D30） */
export function formatPositions(list: ReturnType<typeof listPositions>): string[] {
  const money = (v: number) => `${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(2)}`
  return list.filter(p => !p.closed_at).map(p => {
    const days = p.actual ? Math.max(1, p.actual.days) : p.est ? Math.max(1, Math.round(p.est.hours / 24)) : 0
    if (p.actual) return `${p.symbol}/USDG ${p.label} (${days}d)  手續費 ${money(p.actual.fees_cum_usd)} + 價差 ${money(p.actual.value_usd - p.deposit_usd)} = ${money(p.actual.net_usd)}（模擬 ${p.est ? money(p.est.net_usd) : '—'}）  在區間 ${p.actual.in_range ? '✓' : '✗'}`
    if (!p.est) return `${p.symbol}/USDG ${p.label}  無小時資料`
    return `${p.symbol}/USDG ${p.label}  ${money(p.est.net_usd)} (${days}d, 估算)  在區間 ${p.est.in_range ? '✓' : '✗'}`
  })
}
