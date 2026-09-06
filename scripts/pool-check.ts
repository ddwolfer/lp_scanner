// scripts/pool-check.ts — 一個股票或一個池的完整體檢（DECISIONS D43）
// 用法：pnpm pool <SYMBOL|poolId> [--min-tvl 5000] [--live]      --live：上鏈算最近 24h 交易者數 / LP 地址數 / 費率分布（前 3 個池）
import 'dotenv/config'
import { openDb } from '../db/index.js'
import { getPool } from '../server/queries.js'
import { hookInfo, HOOK_BITS, median } from '../scanner/metrics/hooks.js'
import { weeklySigma, rvolRange } from '../scanner/metrics/volatility.js'
import { makeRpc } from '../scanner/sources/rpc.js'
import { ApiUsage } from '../scanner/sources/usage.js'
import { fetchSwaps, fetchModifyLiquidity } from '../scanner/sources/uniswapV4.js'
import { fetchV3Swaps, fetchV3LiquidityEvents } from '../scanner/sources/uniswapV3.js'
import { makeTraderRpc, resolveTxFrom } from '../scanner/sources/traders.js'
import { CHAIN } from '../config/chain.js'

const args = process.argv.slice(2); const target = args.find(a => !a.startsWith('--'))
if (!target) { console.log('用法: pnpm pool <SYMBOL|poolId> [--min-tvl 5000] [--live]'); process.exit(1) }
const minTvl = Number(args.includes('--min-tvl') ? args[args.indexOf('--min-tvl') + 1] : 5000); const live = args.includes('--live')
const db = openDb('db/lp.sqlite')
const date = (db.prepare('SELECT MAX(date) d FROM pool_snapshots').get() as any).d
const rank = new Map((db.prepare('SELECT pool_id FROM pool_snapshots WHERE date=? AND excluded=0 AND score IS NOT NULL ORDER BY score DESC').all(date) as any[]).map((r, i) => [r.pool_id, i + 1]))
const ids: string[] = target.startsWith('0x')
  ? [target.toLowerCase()]
  : (db.prepare(`SELECT p.pool_id FROM pools p JOIN tokens t ON t.address = CASE WHEN p.stock_is_token0=1 THEN p.token0 ELSE p.token1 END
      LEFT JOIN pool_snapshots s ON s.pool_id=p.pool_id AND s.date=? WHERE t.symbol=? AND COALESCE(s.tvl_usd,0) >= ? ORDER BY s.tvl_usd DESC`).all(date, target.toUpperCase(), minTvl) as any[]).map(r => r.pool_id)
if (!ids.length) { console.log('找不到符合的池'); process.exit(1) }
const usd = (v: number | null | undefined, d = 0) => v === null || v === undefined ? '—' : '$' + v.toLocaleString('en-US', { maximumFractionDigits: d })
const pct = (v: number | null | undefined, d = 0) => v === null || v === undefined ? '—' : (v * 100).toFixed(d) + '%'
console.log(`快照日期 ${date} · ${target.toUpperCase()} · ${ids.length} 個池（TVL ≥ ${usd(minTvl)}）\n`)
const rows: any[] = []
for (const id of ids) {
  const d = getPool(db, id); if (!d) continue; const { pool, latest, economics, hourly } = d as any
  const h = hookInfo(pool.hooks); const sim = latest?.sim?.d1000; const sigma = weeklySigma((hourly as any[]).map(x => x.price_usd))
  const feeLabel = pool.fee_ppm !== null ? (pool.fee_ppm / 1e4).toFixed(2) + '%' : latest?.fee_ppm_observed !== null && latest?.fee_ppm_observed !== undefined ? '~' + (latest.fee_ppm_observed / 1e4).toFixed(2) + '%（動態）' : '動態（無觀察）'
  console.log(`━━ ${pool.symbol}/USDG ${pool.protocol} ${feeLabel}  ${id}`)
  console.log(`   開池 ${pool.created_at?.slice(0, 10)} · hook ${h.kind === 'none' ? '無' : h.kind === 'fee_only' ? '純費率（' + h.flags.map(f => HOOK_BITS.find(b => b.key === f)?.zh).join('、') + '）' : '⚠️ 流動性型（' + h.flags.join(',') + '）'} · 排名 ${rank.get(id) ?? '未入榜'} · ${latest?.excluded ? '排除：' + (latest.flags as string[]).filter(f => !['short_history', 'sigma_from_pool', 'rvol_fallback'].includes(f)).join(',') : '候選 score ' + (latest?.score?.toFixed(3) ?? '—')}`)
  if (latest) console.log(`   TVL ${usd(latest.tvl_usd)} · 24h 量 ${usd(latest.volume_24h_usd)} · 費 ${usd(latest.fees_24h_usd)}（費/TVL ${latest.tvl_usd ? pct(latest.fees_24h_usd / latest.tvl_usd, 2) : '—'}/日）· 熱度 6h ${economics?.heat_6h?.toFixed(2) ?? '—'}× · swaps ${latest.swap_count}`)
  if (latest) console.log(`   交易者 ${latest.trader_count ?? '—'} · top1 ${pct(latest.top1_share)} · 對打 ${pct(latest.pingpong_ratio)} · 池價 ${latest.price_usd?.toFixed(2) ?? '—'} vs 參考 ${latest.price_ref_usd?.toFixed(2) ?? '—'}（偏離 ${pct(latest.price_dev_pct, 2)}）`)
  if (sim) for (const R of ['r10', 'r25'] as const) { const s = sim[R]; const feeApr = s.hours ? (s.fees_trimmed_usd ?? s.fees_usd) / 1000 * 365 / (s.hours / 24) : null
    console.log(`   $1000 ±${R === 'r10' ? 10 : 25}%: 手續費 APR ${pct(feeApr)} · 含價差 ${pct(s.net_apr_trimmed ?? s.net_apr)} · 在區間 ${pct(s.in_range_pct)} · 出 ${s.exits} 次 · 單時 ${pct(s.top_hour_share)} · ${s.hours}h`) }
  const rv = rvolRange(sigma); console.log(`   週波動率 σ₇ ${sigma === null ? '—（不足 5 天）' : pct(sigma, 1)} → rvol ±${pct(rv.R)}${rv.fallback ? '（退回）' : ''} · 容量 ±10% ${usd(economics?.capacity?.r10)} / ±25% ${usd(economics?.capacity?.r25)} · $1000 回本 ${economics?.byDeposit?.[1]?.cost.breakevenDays?.toFixed(1) ?? '—'} 天 · 小時資料 ${hourly.length}h`)
  rows.push({ id, pool, latest, h })
  console.log()
}
if (live) {
  console.log('── 上鏈即時（最近 24h）──')
  const u = new ApiUsage(); const rpc = makeRpc({ usage: u, concurrency: 2, minGapMs: 400 }); const { rpc: trpc, isAlchemy } = makeTraderRpc(u)
  const latestB = await rpc.getBlockNumber(); const from = latestB - BigInt(CHAIN.blocksPerDay)
  for (const r of rows.filter(x => x.h.kind !== 'liquidity').slice(0, 3)) {
    try {
      const sw = r.pool.protocol === 'v3' ? await fetchV3Swaps(rpc, r.id, r.pool.fee_ppm, from, latestB) : await fetchSwaps(rpc, r.id, from, latestB)
      const lps = r.pool.protocol === 'v3' ? await fetchV3LiquidityEvents(rpc, r.id, from, latestB) : await fetchModifyLiquidity(rpc, r.id, from, latestB)
      const stock0 = !!r.pool.stock_is_token0; const vol = sw.reduce((a, s) => { const x = stock0 ? s.amount1 : s.amount0; return a + Number(x < 0n ? -x : x) / 1e6 }, 0)
      const fees = sw.map(s => s.fee); const sample = sw.slice(-400)
      let traders = '—', lpAddrs = '—'
      if (isAlchemy) { const m = await resolveTxFrom(trpc, [...sample.map(s => s.txHash), ...lps.slice(-300).map(l => l.txHash)]); traders = String(new Set(sample.map(s => m.get(s.txHash))).size); lpAddrs = String(new Set(lps.slice(-300).map(l => m.get(l.txHash))).size) }
      console.log(`${r.pool.symbol} ${r.pool.protocol} ${r.id.slice(0, 12)}…: swaps ${sw.length} · 量 ${usd(vol)} · 費率 ${fees.length ? `${Math.min(...fees) / 1e4}% / 中位 ${(median(fees) ?? 0) / 1e4}% / ${Math.max(...fees) / 1e4}%` : '—'} · 最近 ${sample.length} 筆交易者 ${traders} · LP 事件 ${lps.length}（地址 ${lpAddrs}）· 最後價 ${sw.at(-1) ? ((Number(sw.at(-1)!.sqrtPriceX96) / 2 ** 96) ** 2 * (stock0 ? 1e12 : 1e-12) ** (stock0 ? 1 : 1)).toFixed?.(2) : '—'}`)
    } catch (e) { console.log(`${r.pool.symbol}: ${String((e as Error).message).split('\n')[0]}`) }
  }
  console.log('calls', u.toJSON())
}
db.close()
