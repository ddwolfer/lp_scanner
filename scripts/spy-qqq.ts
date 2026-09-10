// scripts/spy-qqq.ts — 研究用：SPY/QQQ v4 0.05% 池（股票對股票、18/18 decimals）用真實 swap 跑 §7 模擬（D49）
import { ADDR, CHAIN } from '../config/chain.js'
import { ApiUsage } from '../scanner/sources/usage.js'
import { makeRpc } from '../scanner/sources/rpc.js'
import { INITIALIZE_EVENT, decodeInitialize, fetchSwaps } from '../scanner/sources/uniswapV4.js'
import { simulate, type SimHour } from '../scanner/metrics/simulate.js'
const SPY = '0x117cc2133c37b721f49de2a7a74833232b3b4c0c', QQQ = '0xd5f3879160bc7c32ebb4dc785f8a4f505888de68'
const SPY_USD = Number(process.argv[2] ?? 769), DAYS = Number(process.argv[3] ?? 5)
const usage = new ApiUsage(); const rpc = makeRpc({ usage }); const latest = await rpc.getBlockNumber()
const pools = (await rpc.getLogsChunked({ address: ADDR.poolManager, event: INITIALIZE_EVENT, args: { currency0: SPY, currency1: QQQ } }, 0n, latest, 3_000_000n)).map(decodeInitialize)
const pool = pools.find(p => p.feePpm === 500 && p.hooks === ADDR.zero)!; console.error('pool', pool.poolId, 'fee', pool.feePpm)
const from = latest - BigInt(DAYS * CHAIN.blocksPerDay); const sw = await fetchSwaps(rpc, pool.poolId, from, latest); console.error('swaps', sw.length, 'rpc', usage.toJSON())
const t0 = Number((await rpc.call(() => rpc.client.getBlock({ blockNumber: from }))).timestamp), t1 = Number((await rpc.call(() => rpc.client.getBlock({ blockNumber: latest }))).timestamp)
const ts = (b: bigint) => t0 + Number(b - from) * (t1 - t0) / Number(latest - from)
// 小時聚合：價格 = QQQ per SPY（= SPY$/QQQ$ 比值）；手續費以 QQQ 計（輸入側 × fee）；liquidity 縮 1e6 讓 simulate 的 1e12 換算對應 18/18 的 1e18
const H = new Map<number, SimHour & { vol: number }>()
for (const s of sw) {
  const h = Math.floor(ts(s.blockNumber) / 3600) * 3600; const price = (Number(s.sqrtPriceX96) / 2 ** 96) ** 2
  const feeQ = s.amount0 > 0n ? Number(s.amount0) / 1e18 * price * s.fee / 1e6 : Number(s.amount1) / 1e18 * s.fee / 1e6
  const volQ = Math.abs(Number(s.amount1)) / 1e18
  const r = H.get(h) ?? { ts: h, priceUsd: price, feesUsd: 0, liquidity: null, vol: 0 }
  r.priceUsd = price; r.feesUsd += feeQ; r.vol += volQ; r.liquidity = (Number(s.liquidity) / 1e6).toString(); H.set(h, r)
}
const hours = [...H.values()].sort((a, b) => a.ts - b.ts)
const P = hours[hours.length - 1].priceUsd; const QQQ_USD = SPY_USD / P
const totalFeeUsd = hours.reduce((a, r) => a + r.feesUsd, 0) * QQQ_USD, totalVol = hours.reduce((a, r) => a + r.vol, 0) * QQQ_USD
const lo = Math.min(...hours.map(h => h.priceUsd)), hi = Math.max(...hours.map(h => h.priceUsd))
console.log(`SPY/QQQ 0.05% · ${hours.length}h（${(hours.length / 24).toFixed(1)} 天）· 比值 ${lo.toFixed(4)} – ${hi.toFixed(4)}，現在 ${P.toFixed(4)} · 池總成交 $${Math.round(totalVol).toLocaleString()} · 池總手續費 $${Math.round(totalFeeUsd).toLocaleString()}（$${Math.round(totalFeeUsd / hours.length * 24)}/日）`)
import { liquidityForDeposit, positionAmounts, positionValue, L_HUMAN_TO_RAW } from '../scanner/metrics/lp-math.js'
function replay(hs: SimHour[], D: number, Pl: number, Pu: number) {
  const P0 = hs[0].priceUsd; const L = liquidityForDeposit(D, P0, Pl, Pu); const Lraw = L * L_HUMAN_TO_RAW; const { x: x0, y: y0 } = positionAmounts(L, P0, Pl, Pu)
  let fees = 0, inR = 0, exits = 0, prevIn = true, shareSum = 0
  for (const h of hs) { const inRange = h.priceUsd >= Pl && h.priceUsd <= Pu; if (inRange) inR++; if (prevIn && !inRange) exits++; prevIn = inRange
    const share = inRange && h.liquidity ? Lraw / (Number(h.liquidity) + Lraw) : 0; shareSum += share; fees += share * h.feesUsd }
  const Pend = hs[hs.length - 1].priceUsd; const lp = positionValue(L, Pend, Pl, Pu), hodl = x0 * Pend + y0
  return { fees, lp, hodl, il: lp - hodl, net: fees + lp - hodl, inRange: inR / hs.length, exits, share: shareSum / hs.length, x0, y0 }
}
const k = QQQ_USD; const D = 1000 / k
import { parseAbi } from 'viem'
const SV = parseAbi(['function getFeeGrowthInside(bytes32 poolId, int24 tickLower, int24 tickUpper) view returns (uint256, uint256)'])
const arpc = process.env.ALCHEMY_KEY ? makeRpc({ usage, url: CHAIN.alchemyRpc(process.env.ALCHEMY_KEY), source: 'alchemy', concurrency: 1 }) : null
async function exact(tl: number, tu: number, Lraw18: bigint) {
  const g = async (b: bigint) => arpc!.call(() => arpc!.client.readContract({ address: ADDR.stateView, abi: SV, functionName: 'getFeeGrowthInside', args: [pool.poolId as `0x${string}`, tl, tu], blockNumber: b })) as Promise<readonly [bigint, bigint]>
  const [a, b] = await Promise.all([g(from), g(latest)]); const M = 2n ** 256n; const d = (x: bigint, y: bigint) => ((y - x) % M + M) % M
  const f0 = Number(Lraw18 * d(a[0], b[0]) / 2n ** 128n) / 1e18, f1 = Number(Lraw18 * d(a[1], b[1]) / 2n ** 128n) / 1e18   // f0 SPY 顆、f1 QQQ 顆
  return f0 * SPY_USD + f1 * QQQ_USD
}
console.log(`窗口起點比值 ${hours[0].priceUsd.toFixed(4)} · 終點 ${P.toFixed(4)}（${((P / hours[0].priceUsd - 1) * 100).toFixed(2)}%）`)
console.log('投入 $1000 · 區間                    開倉 SPY%  在區間 出去 平均份額 手續費  LP−HODL(不含費)  淨(LP−HODL)  費/日')
const P0 = hours[0].priceUsd
const cases: [string, number, number][] = [['截圖 1.0613–1.0795', 1.0613026, 1.0794981], ['±0.85% 對稱', P0 * 0.9915, P0 * 1.0085], ['±1.4%（1.055–1.085）', 1.055, 1.085], ['±3.3%（1.03–1.10）', 1.03, 1.10], ['±10%', P0 * 0.9, P0 * 1.1]]
for (const [label, Pl, Pu] of cases) {
  const tl = Math.floor(Math.log(Pl) / Math.log(1.0001) / 10) * 10, tu = Math.ceil(Math.log(Pu) / Math.log(1.0001) / 10) * 10
  const r = replay(hours, D, Pl, Pu); const spyPct = r.x0 * P0 / (r.x0 * P0 + r.y0) * 100
  const Lraw18 = BigInt(Math.round(liquidityForDeposit(D, P0, Pl, Pu) * 1e18)); const ex = arpc ? await exact(tl, tu, Lraw18) : null
  console.log(`${label.padEnd(24)} ${spyPct.toFixed(0).padStart(4)}%     ${(r.inRange * 100).toFixed(0).padStart(3)}%  ${String(r.exits).padStart(2)}   ${(r.share * 100).toFixed(2).padStart(5)}%  $${(r.fees * k).toFixed(2).padStart(5)}   $${(r.il * k).toFixed(2).padStart(6)}        $${(r.net * k).toFixed(2).padStart(6)}   $${(r.fees * k / (hours.length / 24)).toFixed(2)}${ex !== null ? `  精確費 $${ex.toFixed(2)}（估/精確 ${(r.fees * k / ex * 100).toFixed(0)}%）` : ''}`)
}
console.log(`window_ts ${hours[0].ts} ${hours[hours.length - 1].ts}`)
