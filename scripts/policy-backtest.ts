// scripts/policy-backtest.ts — 區間管理策略回測（D55）：pnpm policies [--weeks=5] [--d=1000] [--gas=1.5]
// 整段一個頭寸；策略：A 不重開、B 出區間 24h 重開、C 超出邊界 0.25% 重開、D 每週重開；成本 = 重平衡量 × (池費率 + 0.1% 滑價) + gas。
import { openDb } from '../db/index.js'
import { CHAIN } from '../config/chain.js'
import { makeCtx, resolvePool, loadSwaps, tsOf, hourlyRows, simulateStateful, segmentsExactFee, type Policy } from './lib/replay-core.js'
const args = process.argv.slice(2); const opt = (k: string, d: string) => (args.find(a => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=')[1]
const WEEKS = Number(opt('weeks', '5')), D_USD = Number(opt('d', '1000')), GAS = Number(opt('gas', '1.5'))
const ctx = makeCtx(openDb('db/lp.sqlite')); const latest = await ctx.rpc.getBlockNumber(); const from = latest - BigInt(WEEKS * 7 * CHAIN.blocksPerDay)
const [t0, t1] = await Promise.all([tsOf(ctx, from), tsOf(ctx, latest)])
const specs: [string, number, number[]][] = [['SPY/QQQ', 0.05, [0.85, 1.5, 2.5]], ['AMD', 0, [10, 6, 15]]]
const policies: [string, Policy][] = [['A 不重開', { kind: 'static' }], ['B 出區間 24h', { kind: 'oor_hours', hours: 24 }], ['C 超界 0.25%', { kind: 'beyond_pct', pct: 0.25 }], ['D 每週重開', { kind: 'weekly' }]]
console.log(`窗口 ${new Date(t0 * 1000).toISOString().slice(0, 10)} → ${new Date(t1 * 1000).toISOString().slice(0, 10)}（${((t1 - t0) / 86400).toFixed(1)} 天）· $${D_USD} · gas/次 $${GAS} · 滑價 0.1%`)
const f = (v: number) => ('$' + v.toFixed(2)).padStart(8)
for (const [target, fee, widths] of specs) {
  const pool = await resolvePool(ctx, target, fee); const start = pool.createdBlock && pool.createdBlock > from ? pool.createdBlock : from
  const sw = await loadSwaps(ctx, pool, start, latest); const hs = hourlyRows(pool, sw, start, latest, start === from ? t0 : await tsOf(ctx, start), t1)
  const yc = ctx.usdPrice(pool.token1) ?? 1; const yUsd = (P: number) => pool.inv ? 1 / P : (pool.token1 === '0x5fc5360d0400a0fd4f2af552add042d716f1d168' ? 1 : yc)
  console.log(`\n${pool.name} · ${hs.length}h · 顯示價 ${(pool.inv ? 1 / hs[0].p : hs[0].p).toFixed(4)} → ${(pool.inv ? 1 / hs[hs.length - 1].p : hs[hs.length - 1].p).toFixed(4)}`)
  const blockAt = (ts: number) => start + BigInt(Math.round(Number(latest - start) * (ts - hs[0].ts) / (t1 - hs[0].ts)))
  console.log('半寬    策略            重開  在區間   估計費  feeGrowth費(有效段/段)   成本   LP−HODL    淨(估)   淨(feeGrowth)  份額 中位/p95/最大')
  for (const w of widths) for (const [name, pol] of policies) {
    const r = simulateStateful(pool, hs, w, pol, D_USD, yUsd, GAS, pool.feePpm / 1e6 + 0.001); const ex = await segmentsExactFee(ctx, pool, r.segments, blockAt); const k = yUsd(hs[hs.length - 1].p)
    const netFg = ex.fee * k - r.costs + r.lpEnd - r.hodlEnd
    console.log(`±${String(w).padEnd(5)} ${name.padEnd(14)} ${String(r.recenters).padStart(3)}   ${(r.inRange * 100).toFixed(0).padStart(4)}%  ${f(r.fees)}  ${f(ex.fee * k)} (${ex.valid}/${ex.total})   ${f(r.costs)}  ${f(r.lpEnd - r.hodlEnd)}  ${f(r.net)}  ${f(netFg)}${ex.valid < ex.total ? '*' : ' '}   ${(r.shareMed * 100).toFixed(2)}% / ${(r.shareP95 * 100).toFixed(2)}% / ${(r.shareMax * 100).toFixed(2)}%`)
  }
}
console.log('\n* = 有段落拿不到 feeGrowth，該段用估計費')
console.error('api', ctx.usage.toJSON())
