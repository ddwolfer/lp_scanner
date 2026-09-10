// scripts/lp-replay.ts — 用最近 N 天的真實 swap 重放：$D 在各區間的手續費、LP−HODL（不含費）、淨（D50）
// 用法：pnpm replay <poolId|SYMBOL> [days=5] [D=1000] [ranges=5,10,25]
import { openDb } from '../db/index.js'
import { CHAIN } from '../config/chain.js'
import { ApiUsage } from '../scanner/sources/usage.js'
import { makeRpc } from '../scanner/sources/rpc.js'
import { fetchSwaps } from '../scanner/sources/uniswapV4.js'
import { fetchV3Swaps } from '../scanner/sources/uniswapV3.js'
import { aggregateHourly } from '../scanner/metrics/hourly.js'
import { liquidityForDeposit, positionAmounts, positionValue, L_HUMAN_TO_RAW } from '../scanner/metrics/lp-math.js'
const [arg, daysArg = '5', dArg = '1000', rArg = '5,10,25'] = process.argv.slice(2)
const db = openDb('db/lp.sqlite')
const pool = (arg.startsWith('0x') ? db.prepare(`SELECT p.*, t.symbol FROM pools p JOIN tokens t ON t.address=(CASE WHEN p.stock_is_token0 THEN p.token0 ELSE p.token1 END) WHERE p.pool_id=?`).get(arg.toLowerCase())
  : db.prepare(`SELECT p.*, t.symbol FROM pools p JOIN tokens t ON t.address=(CASE WHEN p.stock_is_token0 THEN p.token0 ELSE p.token1 END) JOIN pool_snapshots s ON s.pool_id=p.pool_id AND s.date=(SELECT MAX(date) FROM pool_snapshots) WHERE t.symbol=? AND s.excluded=0 ORDER BY s.tvl_usd DESC LIMIT 1`).get(arg.toUpperCase())) as any
if (!pool) { console.error('pool not found'); process.exit(1) }
const usage = new ApiUsage(); const rpc = makeRpc({ usage }); const latest = await rpc.getBlockNumber(); const from = latest - BigInt(Number(daysArg) * CHAIN.blocksPerDay)
const t0 = Number((await rpc.call(() => rpc.client.getBlock({ blockNumber: from }))).timestamp), t1 = Number((await rpc.call(() => rpc.client.getBlock({ blockNumber: latest }))).timestamp)
const interp = (b: bigint) => t0 + Number(b - from) * (t1 - t0) / Number(latest - from)
const sw = pool.protocol === 'v3' ? await fetchV3Swaps(rpc, pool.pool_id, pool.fee_ppm, from, latest) : await fetchSwaps(rpc, pool.pool_id, from, latest)
const hs = aggregateHourly(sw, interp, !!pool.stock_is_token0, t0, t1).filter(h => h.priceUsd !== null && h.priceUsd > 0) as (ReturnType<typeof aggregateHourly>[number] & { priceUsd: number })[]
const P0 = hs[0].priceUsd, Pend = hs[hs.length - 1].priceUsd; const D = Number(dArg)
console.log(`${pool.symbol}/USDG ${pool.protocol} ${(pool.fee_ppm / 1e4).toFixed(2)}% · ${hs.length}h（${(hs.length / 24).toFixed(1)} 天，${new Date(t0 * 1000).toISOString().slice(0, 13)} → ${new Date(t1 * 1000).toISOString().slice(0, 13)}）· swaps ${sw.length} · 價 ${P0.toFixed(2)} → ${Pend.toFixed(2)}（${((Pend / P0 - 1) * 100).toFixed(2)}%）· 池總費 $${Math.round(hs.reduce((a, h) => a + h.feesUsd, 0)).toLocaleString()}`)
console.log(`投入 $${D} · 區間   在區間  出去  平均份額   手續費   LP−HODL(不含費)   淨(LP−HODL)   費/日   HODL 本身`)
for (const R of rArg.split(',').map(Number)) {
  const Pl = P0 * (1 - R / 100), Pu = P0 * (1 + R / 100); const L = liquidityForDeposit(D, P0, Pl, Pu), Lraw = L * L_HUMAN_TO_RAW; const { x: x0, y: y0 } = positionAmounts(L, P0, Pl, Pu)
  let fees = 0, inR = 0, exits = 0, prev = true, sh = 0
  for (const h of hs) { const ir = h.priceUsd >= Pl && h.priceUsd <= Pu; if (ir) inR++; if (prev && !ir) exits++; prev = ir; const s = ir && h.liquidity ? Lraw / (Number(h.liquidity) + Lraw) : 0; sh += s; fees += s * h.feesUsd }
  const lp = positionValue(L, Pend, Pl, Pu), hodl = x0 * Pend + y0
  console.log(`  ±${String(R).padStart(2)}%        ${(inR / hs.length * 100).toFixed(0).padStart(3)}%   ${String(exits).padStart(2)}    ${(sh / hs.length * 100).toFixed(2).padStart(5)}%   $${fees.toFixed(2).padStart(6)}      $${(lp - hodl).toFixed(2).padStart(7)}        $${(fees + lp - hodl).toFixed(2).padStart(7)}    $${(fees / (hs.length / 24)).toFixed(2).padStart(5)}   $${(hodl - D).toFixed(2)}`)
}
console.error('api', usage.toJSON())
