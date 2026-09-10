// scripts/regime-backtest.ts — 規則切窗的多 regime 回測（D54）：pnpm regimes [--weeks=8] [--d=1000]
// 規則：以最新區塊往回切 7 天窗口；用 SPY/QQQ 比值分類：|週報酬| ≥ 1% → 趨勢（QQQ 跑贏 / SPY 跑贏），否則依週波動高低於中位數 → 高波動震盪 / 低波動震盪。
// 區間：政策區間（SPY/QQQ ±0.85%、股票/USDG ±10%）+ 波動正規化 ±1σ/±1.5σ/±2σ（σ = 前一窗口該池顯示價的週波動，第一個窗口用自身、標 *）。
import { openDb } from '../db/index.js'
import { CHAIN } from '../config/chain.js'
import { makeCtx, resolvePool, loadSwaps, tsOf, replayWindow, type Case, type WindowResult, type PoolInfo } from './lib/replay-core.js'
const args = process.argv.slice(2); const opt = (k: string, d: string) => (args.find(a => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=')[1]
const WEEKS = Number(opt('weeks', '8')), D_USD = Number(opt('d', '1000')); const WEEK = BigInt(7 * CHAIN.blocksPerDay)
const ctx = makeCtx(openDb('db/lp.sqlite')); const latest = await ctx.rpc.getBlockNumber()
const specs: [string, number, number][] = [['SPY/QQQ', 0.05, 0.85], ['MSTR', 0, 10], ['AMD', 0, 10]]   // [target, fee, 政策區間 ±%]
const pools: { pool: PoolInfo; policy: number }[] = []; let spyqqqCreated: bigint | null = null; for (const [t, fee, pol] of specs) pools.push({ pool: await resolvePool(ctx, t, fee), policy: pol })
for (const p of pools) console.error(p.pool.name, 'created', p.pool.createdBlock?.toString()); spyqqqCreated = pools[0].pool.createdBlock
const windows: { from: bigint; to: bigint }[] = []; for (let i = 0; i < WEEKS; i++) { const to = latest - WEEK * BigInt(i), from = to - WEEK; windows.push({ from, to }) }
const usable = windows.filter(w => !spyqqqCreated || w.from >= spyqqqCreated).reverse()   // 以分類用的 SPY/QQQ 池存在為準；其他池在各自存在的窗口才跑
const spanFrom = usable[0].from; console.error(`windows ${usable.length}, span ${spanFrom}–${latest}`)
const [tA, tB] = await Promise.all([tsOf(ctx, spanFrom), tsOf(ctx, latest)]); const tsAt = (b: bigint) => tA + Number(b - spanFrom) * (tB - tA) / Number(latest - spanFrom)
const swaps = new Map<string, Awaited<ReturnType<typeof loadSwaps>>>(); for (const p of pools) { swaps.set(p.pool.poolId, await loadSwaps(ctx, p.pool, p.pool.createdBlock && p.pool.createdBlock > spanFrom ? p.pool.createdBlock : spanFrom, latest)); console.error(p.pool.name, 'swaps', swaps.get(p.pool.poolId)!.length) }
const yUsdFor = (p: PoolInfo) => { const c = ctx.usdPrice(p.token1) ?? 1; return (P: number) => p.inv ? 1 / P : (p.token1 === '0x5fc5360d0400a0fd4f2af552add042d716f1d168' ? 1 : c) }

// 先跑一輪取每窗口的比值報酬與波動（分類用）與各池 σ（正規化用）
const spyqqq = pools[0]; const stats: { w: typeof usable[number]; ret: number; volW: number }[] = []
const sigmaPrev = new Map<string, number[]>()
for (const w of usable) {
  const r = await replayWindow(ctx, spyqqq.pool, swaps.get(spyqqq.pool.poolId)!, w.from, w.to, tsAt(w.from), tsAt(w.to), [], D_USD, yUsdFor(spyqqq.pool))
  stats.push({ w, ret: Math.log(r.dispEnd / r.disp0), volW: r.sigmaHourly * Math.sqrt(168) })
  for (const p of pools) { if (p.pool.createdBlock && w.from < p.pool.createdBlock) { sigmaPrev.set(p.pool.poolId, [...(sigmaPrev.get(p.pool.poolId) ?? []), NaN]); continue }; const x = await replayWindow(ctx, p.pool, swaps.get(p.pool.poolId)!, w.from, w.to, tsAt(w.from), tsAt(w.to), [], D_USD, yUsdFor(p.pool)); sigmaPrev.set(p.pool.poolId, [...(sigmaPrev.get(p.pool.poolId) ?? []), x.sigmaHourly * Math.sqrt(168)]) }
}
const medVol = [...stats.map(s => s.volW)].sort((a, b) => a - b)[Math.floor(stats.length / 2)]
const regime = (s: typeof stats[number]) => Math.abs(s.ret) >= 0.01 ? (s.ret < 0 ? 'QQQ 跑贏' : 'SPY 跑贏') : s.volW >= medVol ? '高波動震盪' : '低波動震盪'

const f = (v: number) => ('$' + v.toFixed(2)).padStart(8); const out: string[] = []; const agg = new Map<string, { n: number; net: number; fee: number; inR: number; vs: number }>()
for (let i = 0; i < usable.length; i++) {
  const s = stats[i], w = s.w; const rg = regime(s)
  out.push(`\n== 窗口 ${i + 1}  ${new Date(tsAt(w.from) * 1000).toISOString().slice(0, 10)} → ${new Date(tsAt(w.to) * 1000).toISOString().slice(0, 10)}  區塊 ${w.from}–${w.to}  SPY/QQQ 週報酬 ${(s.ret * 100).toFixed(2)}%  週σ ${(s.volW * 100).toFixed(2)}%  → ${rg}`)
  out.push('池 · 區間                       在區間 出去  feeGrowth費  估計費   LP−HODL     淨    留存率  LP−50/50  顯示價 起→終')
  for (let k = 0; k < pools.length; k++) {
    const p = pools[k]; if (p.pool.createdBlock && w.from < p.pool.createdBlock) continue
    const sig = sigmaPrev.get(p.pool.poolId)!; const usePrev = i > 0 && !Number.isNaN(sig[i - 1]); const sigma = usePrev ? sig[i - 1] : sig[i]; const star = usePrev ? '' : '*'
    const r0 = await replayWindow(ctx, p.pool, swaps.get(p.pool.poolId)!, w.from, w.to, tsAt(w.from), tsAt(w.to), [], D_USD, yUsdFor(p.pool)); const d0 = r0.disp0
    const cases: Case[] = [{ label: `政策 ±${p.policy}%`, lower: d0 * (1 - p.policy / 100), upper: d0 * (1 + p.policy / 100) }, ...[1, 1.5, 2].filter(m => m * sigma < 0.5).map(m => ({ label: `±${m}σ${star}(${(m * sigma * 100).toFixed(1)}%)`, lower: d0 * (1 - m * sigma), upper: d0 * (1 + m * sigma) }))]   // σ 超過 50% 的池（新池價格噪音）不做正規化
    const r = await replayWindow(ctx, p.pool, swaps.get(p.pool.poolId)!, w.from, w.to, tsAt(w.from), tsAt(w.to), cases, D_USD, yUsdFor(p.pool))
    for (const row of r.rows) {
      out.push(`${p.pool.name.padEnd(22)} ${row.label.padEnd(16)} ${(row.inRange * 100).toFixed(0).padStart(4)}%  ${String(row.exits).padStart(2)}   ${row.exact === null ? '  無效   ' : f(row.exact)}  ${f(row.est)}  ${f(row.il)}  ${f(row.net)}  ${(row.retention * 100).toFixed(0).padStart(4)}%  ${f(row.vs5050)}   ${r.disp0.toFixed(p.pool.inv ? 1 : 4)}→${r.dispEnd.toFixed(p.pool.inv ? 1 : 4)}${row.exact === null ? '（估）' : ''}`)
      const key = `${rg} | ${p.pool.name} | ${row.label.replace(/\*|\(.*\)/g, '')}`; const a = agg.get(key) ?? { n: 0, net: 0, fee: 0, inR: 0, vs: 0 }; a.n++; a.net += row.net; a.fee += row.fee; a.inR += row.inRange; a.vs += row.vs5050; agg.set(key, a)
    }
  }
}
out.push('\n== 依 regime 彙總（每窗口 $1000，平均）'); out.push('regime | 池 | 區間 | 窗口數 | 平均費 | 平均淨 | 留存率 | 平均在區間 | 平均 LP−50/50')
for (const [k, a] of [...agg.entries()].sort()) out.push(`${k} | ${a.n} | ${f(a.fee / a.n)} | ${f(a.net / a.n)} | ${(a.fee ? a.net / a.fee * 100 : 0).toFixed(0)}% | ${(a.inR / a.n * 100).toFixed(0)}% | ${f(a.vs / a.n)}`)
console.log(out.join('\n')); console.error('api', ctx.usage.toJSON())
