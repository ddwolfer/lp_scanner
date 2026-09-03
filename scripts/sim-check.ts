// scripts/sim-check.ts — SPEC §7.4：逐小時表格供人工對照 Uniswap 介面
import 'dotenv/config'
import { openDb } from '../db/index.js'
import { loadHourly } from '../scanner/steps.js'
import { simulate, simulateHourly } from '../scanner/metrics/simulate.js'
import { liquidityForDeposit } from '../scanner/metrics/lp-math.js'
const [poolId, dArg, rArg, fromArg, toArg] = process.argv.slice(2)
if (!poolId) { console.log('用法: pnpm sim-check <poolId> [D=1000] [R=0.25] [from YYYY-MM-DD] [to YYYY-MM-DD]'); process.exit(1) }
const D = Number(dArg ?? 1000), R = Number(rArg ?? 0.25)
const db = openDb('db/lp.sqlite')
const pool = db.prepare(`SELECT p.*, t.symbol FROM pools p JOIN tokens t ON t.address = CASE WHEN p.stock_is_token0=1 THEN p.token0 ELSE p.token1 END WHERE p.pool_id=?`).get(poolId.toLowerCase()) as any
if (!pool) { console.log('找不到池'); process.exit(1) }
let hours = loadHourly(db, poolId.toLowerCase(), 24 * 45)
if (fromArg) hours = hours.filter(h => h.ts >= Date.parse(fromArg + 'T00:00:00Z') / 1000)
if (toArg) hours = hours.filter(h => h.ts < Date.parse(toArg + 'T00:00:00Z') / 1000 + 86400)
hours = hours.slice(-720)
if (!hours.length) { console.log('此池沒有小時資料'); process.exit(1) }
const P0 = hours[0].priceUsd, Pl = P0 * (1 - R), Pu = P0 * (1 + R)
console.log(`${pool.symbol}/USDG v4 fee ${(pool.fee_ppm / 1e4).toFixed(3)}%  pool ${poolId}`)
console.log(`D=$${D}  R=±${R * 100}%  P0=${P0.toFixed(4)}  區間 [${Pl.toFixed(4)}, ${Pu.toFixed(4)}]  L=${liquidityForDeposit(D, P0, Pl, Pu).toExponential(4)}  小時數=${hours.length}\n`)
console.log('time(UTC)        | price    | in | poolL(raw)  | share    | fee_h   | cumFee  | value')
for (const r of simulateHourly(hours, D, R)) {
  const t = new Date(r.row.ts * 1000).toISOString().slice(0, 16).replace('T', ' ')
  console.log(`${t} | ${r.row.priceUsd.toFixed(4).padStart(8)} | ${r.inRange ? ' ✓' : ' ✗'} | ${(r.row.liquidity === null ? '-' : Number(r.row.liquidity).toExponential(3)).padStart(11)} | ${r.share.toExponential(2)} | ${r.feeH.toFixed(3).padStart(7)} | ${r.cumFees.toFixed(2).padStart(7)} | ${r.valueH.toFixed(2)}`)
}
console.log('\n結果 (§7.3):', JSON.stringify(simulate(hours, D, R), null, 1))
db.close()
