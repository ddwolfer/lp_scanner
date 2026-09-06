// scripts/tx-costs.ts — 列出 TRACK_ADDRESS 最近的鏈上交易：gas（USD）與 USDG / 股票代幣流向，並合計（DECISIONS D42）
// 用法：pnpm costs [天數=3] [--symbol SPCX]     只讀，資料來源 Alchemy getAssetTransfers + eth_getTransactionReceipt
import 'dotenv/config'
import { ADDR } from '../config/chain.js'
const KEY = process.env.ALCHEMY_KEY, A = (process.env.TRACK_ADDRESS ?? '').toLowerCase()
if (!KEY || !A) { console.log('需要 .env 的 ALCHEMY_KEY 與 TRACK_ADDRESS'); process.exit(1) }
const args = process.argv.slice(2); const days = Number(args.find(a => /^\d+$/.test(a)) ?? 3); const symArg = args.includes('--symbol') ? args[args.indexOf('--symbol') + 1] : null
const rpc = async (method: string, params: unknown[]) => { const j = await (await fetch(`https://robinhood-mainnet.g.alchemy.com/v2/${KEY}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (j.error) throw new Error(JSON.stringify(j.error)); return j.result }
// ETH/USD：DexScreener 上 Robinhood Chain 的 WETH/USDG 主池
let ethUsd = 2400
try { const ds = await (await fetch(`https://api.dexscreener.com/token-pairs/v1/robinhood/${ADDR.weth}`)).json(); const p = ds.filter((x: any) => x.quoteToken.symbol === 'USDG').sort((a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0]; if (p) ethUsd = Number(p.priceUsd) } catch {}
const assets = (await (await fetch('https://api.robinhood.com/rhj/assets')).json()).assets as any[]
const symOf = new Map<string, string>([[ADDR.usdg, 'USDG'], ...assets.map(a => [a.deployments[0].contractAddress.toLowerCase(), a.tokenSymbol] as [string, string])])
const latest = parseInt(await rpc('eth_blockNumber', []), 16); const fromBlock = '0x' + Math.max(0, latest - 830000 * days).toString(16)
const hashes = new Set<string>()
for (const dir of ['fromAddress', 'toAddress']) for (const category of [['erc20'], ['external']]) { const x = await rpc('alchemy_getAssetTransfers', [{ fromBlock, [dir]: A, category, maxCount: '0x3e8' }]); for (const t of x.transfers) hashes.add(t.hash) }
const T = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const rows: { ts: string; gas: number; flows: Record<string, number>; hash: string }[] = []
for (const h of hashes) {
  const r = await rpc('eth_getTransactionReceipt', [h]); if (!r || r.from.toLowerCase() !== A) continue   // 只算自己發起的交易（gas 是自己付的）
  const b = await rpc('eth_getBlockByNumber', [r.blockNumber, false]); const ts = new Date(parseInt(b.timestamp, 16) * 1000).toISOString().slice(0, 16).replace('T', ' ')
  const gas = parseInt(r.gasUsed, 16) * parseInt(r.effectiveGasPrice, 16) / 1e18 * ethUsd; const flows: Record<string, number> = {}
  for (const l of r.logs) { if (l.topics[0] !== T || l.topics.length !== 3) continue; const sym = symOf.get(l.address.toLowerCase()); if (!sym) continue
    const from = '0x' + l.topics[1].slice(26), to = '0x' + l.topics[2].slice(26); const v = Number(BigInt(l.data)) / (sym === 'USDG' ? 1e6 : 1e18)
    if (from === A) flows[sym] = (flows[sym] ?? 0) - v; if (to === A) flows[sym] = (flows[sym] ?? 0) + v }
  if (symArg && !(symArg in flows)) continue
  rows.push({ ts, gas, flows, hash: h })
}
rows.sort((a, b) => a.ts.localeCompare(b.ts))
const net: Record<string, number> = {}; let gasSum = 0
console.log(`TRACK_ADDRESS 最近 ${days} 天（ETH $${ethUsd.toFixed(0)}）${symArg ? `，只列含 ${symArg} 的交易` : ''}\n`)
for (const r of rows) { gasSum += r.gas; for (const [k, v] of Object.entries(r.flows)) net[k] = (net[k] ?? 0) + v
  console.log(`${r.ts} UTC  gas $${r.gas.toFixed(2).padStart(5)}  ${Object.entries(r.flows).map(([k, v]) => `${v > 0 ? '+' : ''}${v.toFixed(4)} ${k}`).join(', ') || '(無代幣流向)'}  ${r.hash.slice(0, 10)}…`) }
console.log(`\n${rows.length} 筆  gas 合計 $${gasSum.toFixed(2)}`)
console.log('代幣淨變動：' + Object.entries(net).map(([k, v]) => `${v > 0 ? '+' : ''}${v.toFixed(4)} ${k}`).join('，'))
if (net.USDG !== undefined) console.log(`USDG 淨變動 − gas = ${(net.USDG - gasSum).toFixed(2)} USD（若股票代幣淨變動為 0，這就是這段期間的實際淨利）`)
