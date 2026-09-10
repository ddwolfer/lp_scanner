// scripts/lp-replay.ts — CLI：pnpm replay <poolId | SYMBOL | SYM0/SYM1> [--days=5] [--d=1000] [--ranges=5,10,25 | --lower=<顯示價> --upper=<顯示價>] [--from=<block>] [--to=<block>] [--fee=0.05]
import { openDb } from '../db/index.js'
import { CHAIN } from '../config/chain.js'
import { makeCtx, resolvePool, loadSwaps, tsOf, replayWindow, showP, type Case } from './lib/replay-core.js'
const args = process.argv.slice(2); const target = args.find(a => !a.startsWith('--'))!; const opt = (k: string, d: string) => (args.find(a => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=')[1]
const ctx = makeCtx(openDb('db/lp.sqlite')); const pool = await resolvePool(ctx, target, Number(opt('fee', '0.05')))
const latest = await ctx.rpc.getBlockNumber(); const to = BigInt(opt('to', latest.toString())), from = BigInt(opt('from', (to - BigInt(Number(opt('days', '5')) * CHAIN.blocksPerDay)).toString()))
const [t0, t1] = await Promise.all([tsOf(ctx, from), tsOf(ctx, to)]); const sw = await loadSwaps(ctx, pool, from, to)
const yConst = ctx.usdPrice(pool.token1) ?? 1; const yUsd = (P: number) => pool.token1 === ctx.sym(pool.token1) && false ? 1 : pool.inv ? 1 / P : (pool.token1.toLowerCase() === '0x5fc5360d0400a0fd4f2af552add042d716f1d168' ? 1 : yConst)
const P0 = (sw[0].sqrtPriceX96 ? (Number(sw[0].sqrtPriceX96) / 2 ** 96) ** 2 * 10 ** (pool.d0 - pool.d1) : 1); const disp0 = pool.inv ? 1 / P0 : P0
const cases: Case[] = args.some(a => a.startsWith('--lower=')) ? [{ label: `[${opt('lower', '')}–${opt('upper', '')}]`, lower: Number(opt('lower', '')), upper: Number(opt('upper', '')) }] : opt('ranges', '5,10,25').split(',').map(Number).map(R => ({ label: `±${R}%`, lower: disp0 * (1 - R / 100), upper: disp0 * (1 + R / 100) }))
const w = await replayWindow(ctx, pool, sw, from, to, t0, t1, cases, Number(opt('d', '1000')), yUsd)
console.log(`${w.name} · 區塊 ${from}–${to} · ${new Date(t0 * 1000).toISOString().slice(0, 13)} → ${new Date(t1 * 1000).toISOString().slice(0, 13)}（${((t1 - t0) / 86400).toFixed(1)} 天）· swaps ${w.swaps} · 價 ${w.disp0.toFixed(4)} → ${w.dispEnd.toFixed(4)}（${((w.dispEnd / w.disp0 - 1) * 100).toFixed(2)}%）· 池總費 $${Math.round(w.totalFeeUsd).toLocaleString()} · 小時σ ${(w.sigmaHourly * 100).toFixed(3)}%`)
console.log(`token0 ${ctx.sym(pool.token0)}（${pool.d0}）/ token1 ${ctx.sym(pool.token1)}（${pool.d1}）· 顯示價 = ${pool.inv ? '1/P' : 'P'}${!pool.inv && pool.token1 !== '0x5fc5360d0400a0fd4f2af552add042d716f1d168' ? ` · Y 美元價用常數 $${yConst.toFixed(2)}` : ''}`)
console.log('區間                          在區間 出去  份額    估計費  feeGrowth費   LP−HODL   淨(LP−HODL) 留存率  LP−50/50  HODL本身')
const f = (v: number) => ('$' + v.toFixed(2)).padStart(8)
for (const r of w.rows) console.log(`  ${r.label} [${[showP(pool, r.Pl), showP(pool, r.Pu)].sort((a, b) => Number(a) - Number(b)).join("–")}]`.padEnd(30) + `${(r.inRange * 100).toFixed(0).padStart(4)}%  ${String(r.exits).padStart(2)}  ${(r.share * 100).toFixed(2).padStart(5)}%  ${f(r.est)}  ${r.exact === null ? '   無效  ' : f(r.exact)}   ${f(r.il)}   ${f(r.net)}   ${(r.retention * 100).toFixed(0).padStart(4)}%  ${f(r.vs5050)}  ${f(r.hodlUsd)}  ${r.adjusted}${r.exact === null ? '（feeGrowth 無效，淨用估計費）' : ''}`)
console.error('api', ctx.usage.toJSON())
