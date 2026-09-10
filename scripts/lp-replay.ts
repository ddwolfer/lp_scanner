// scripts/lp-replay.ts — 用最近 N 天的真實 swap 重放：$D 在各區間的手續費、LP−HODL（不含費）、淨（D50）
// 用法：pnpm replay <poolId|SYMBOL> [days=5] [D=1000] [ranges=5,10,25]
import { openDb } from '../db/index.js'
import { ADDR, CHAIN } from '../config/chain.js'
import { ApiUsage } from '../scanner/sources/usage.js'
import { makeRpc } from '../scanner/sources/rpc.js'
import { fetchSwaps } from '../scanner/sources/uniswapV4.js'
import { fetchV3Swaps } from '../scanner/sources/uniswapV3.js'
import { aggregateHourly } from '../scanner/metrics/hourly.js'
import { liquidityForDeposit, positionAmounts, positionValue, L_HUMAN_TO_RAW } from '../scanner/metrics/lp-math.js'
import { parseAbi } from 'viem'
// 精確對照（D51）：Alchemy 有歷史狀態，StateView.getFeeGrowthInside 在窗口頭尾的差 × L / 2^128 = 該區間每單位流動性的真實手續費
const SV = parseAbi(['function getFeeGrowthInside(bytes32 poolId, int24 tickLower, int24 tickUpper) view returns (uint256, uint256)'])
const arpc = process.env.ALCHEMY_KEY ? makeRpc({ usage: new ApiUsage(), url: CHAIN.alchemyRpc(process.env.ALCHEMY_KEY), source: 'alchemy', concurrency: 1 }) : null
const Q128 = 2n ** 128n, M256 = 2n ** 256n
async function exactFees(poolId: string, tl: number, tu: number, fromB: bigint, toB: bigint, Lraw: bigint) {
  const g = async (b: bigint) => arpc!.call(() => arpc!.client.readContract({ address: ADDR.stateView, abi: SV, functionName: 'getFeeGrowthInside', args: [poolId as `0x${string}`, tl, tu], blockNumber: b })) as Promise<readonly [bigint, bigint]>
  const [a, b] = await Promise.all([g(fromB), g(toB)]); const d = (x: bigint, y: bigint) => ((y - x) % M256 + M256) % M256
  return [Lraw * d(a[0], b[0]) / Q128, Lraw * d(a[1], b[1]) / Q128]
}
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
  // 區間對齊 tickSpacing（跟真的開倉一樣），模擬與精確對照用同一組 tick
  const s0 = !!pool.stock_is_token0; const toRaw = (P: number) => s0 ? P * 1e-12 : 1e12 / P; const toTick = (P: number) => Math.log(toRaw(P)) / Math.log(1.0001)
  const sp = pool.tick_spacing as number; const [tA, tB] = [toTick(P0 * (1 - R / 100)), toTick(P0 * (1 + R / 100))].sort((a, b) => a - b)
  const tl = Math.floor(tA / sp) * sp, tu = Math.ceil(tB / sp) * sp; const fromTick = (t: number) => s0 ? 1.0001 ** t * 1e12 : 1e12 / 1.0001 ** t
  const [Pl, Pu] = [fromTick(tl), fromTick(tu)].sort((a, b) => a - b)
  const L = liquidityForDeposit(D, P0, Pl, Pu), Lraw = L * L_HUMAN_TO_RAW; const { x: x0, y: y0 } = positionAmounts(L, P0, Pl, Pu)
  let fees = 0, inR = 0, exits = 0, prev = true, sh = 0, feesSwap = 0
  { let Lprev: bigint | null = null
    for (const w of sw) { const usdg = Math.abs(Number(s0 ? w.amount1 : w.amount0)) / 1e6; const f = usdg * w.fee / 1e6
      const P = s0 ? (Number(w.sqrtPriceX96) / 2 ** 96) ** 2 * 1e12 : 1e12 / (Number(w.sqrtPriceX96) / 2 ** 96) ** 2
      const Lp = Lprev ?? w.liquidity; if (P >= Pl && P <= Pu && Lp > 0n) feesSwap += f * Lraw / (Number(Lp) + Lraw); Lprev = w.liquidity } }
  for (const h of hs) { const ir = h.priceUsd >= Pl && h.priceUsd <= Pu; if (ir) inR++; if (prev && !ir) exits++; prev = ir; const s = ir && h.liquidity ? Lraw / (Number(h.liquidity) + Lraw) : 0; sh += s; fees += s * h.feesUsd }
  const lp = positionValue(L, Pend, Pl, Pu), hodl = x0 * Pend + y0
  let exact = ''
  if (arpc && pool.protocol === 'v4') { const [f0, f1] = await exactFees(pool.pool_id, tl, tu, from, latest, BigInt(Math.round(Lraw)))
    const usd = s0 ? Number(f0) / 1e18 * Pend + Number(f1) / 1e6 : Number(f0) / 1e6 + Number(f1) / 1e18 * Pend
    exact = usd > 0 && usd < 1e6 ? `  精確費 $${usd.toFixed(2)}（小時估/精確 ${(fees / usd * 100).toFixed(0)}%，逐筆估/精確 ${(feesSwap / usd * 100).toFixed(0)}%）` : '  精確費 無效（區間邊界 tick 未初始化且被穿越）' }
  console.log(`  ±${String(R).padStart(2)}% [${Pl.toFixed(2)}–${Pu.toFixed(2)}]  ${(inR / hs.length * 100).toFixed(0).padStart(3)}%   ${String(exits).padStart(2)}    ${(sh / hs.length * 100).toFixed(2).padStart(5)}%   $${fees.toFixed(2).padStart(6)}      $${(lp - hodl).toFixed(2).padStart(7)}        $${(fees + lp - hodl).toFixed(2).padStart(7)}    $${(fees / (hs.length / 24)).toFixed(2).padStart(5)}   $${(hodl - D).toFixed(2)}${exact}`)
}
console.error('api', usage.toJSON())
