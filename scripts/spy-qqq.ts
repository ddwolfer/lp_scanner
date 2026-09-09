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
console.log('投入 $1000 ·  區間        在區間  出去  平均份額  手續費/日  淨值變化  IL     淨損益  折年')
for (const [label, R] of [['±0.85%（GPT 現在）', 0.0085], ['±1.4%（GPT 推薦）', 0.014], ['±3.3%（GPT 低維護）', 0.033], ['±10%', 0.10]] as const) {
  const D = 1000 / QQQ_USD; const r = simulate(hours, D, R); const k = QQQ_USD
  const share = r.in_range_hours ? hours.reduce((a, h, i) => a, 0) : 0
  console.log(`${label.padEnd(20)} ${(r.in_range_pct * 100).toFixed(0).padStart(4)}%   ${String(r.exits).padStart(2)}    ${'—'.padStart(6)}   $${(r.fees_usd * k / (hours.length / 24)).toFixed(2).padStart(5)}   $${((r.value_end_usd - D) * k).toFixed(2).padStart(6)}  $${(r.il_usd * k).toFixed(2).padStart(6)}  $${(r.net_usd * k).toFixed(2).padStart(6)}  ${(r.net_apr * 100).toFixed(0)}%`)
}
