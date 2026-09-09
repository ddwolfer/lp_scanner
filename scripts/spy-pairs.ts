// scripts/spy-pairs.ts — 研究用：SPY × 股票 池（股票對股票）的費/TVL 與比值波動，和同股票的 USDG 主池比較（D48）
import { openDb } from '../db/index.js'
import { ADDR, CHAIN } from '../config/chain.js'
import { ApiUsage } from '../scanner/sources/usage.js'
import { makeRpc } from '../scanner/sources/rpc.js'
import { INITIALIZE_EVENT, decodeInitialize } from '../scanner/sources/uniswapV4.js'
import { fetchTokenPairs } from '../scanner/sources/dexscreener.js'

const db = openDb('db/lp.sqlite'); const usage = new ApiUsage(); const rpc = makeRpc({ usage })
const spy = (db.prepare(`SELECT address FROM tokens WHERE symbol='SPY'`).get() as any).address as `0x${string}`
const tokens = new Map<string, string>((db.prepare('SELECT address, symbol FROM tokens').all() as any[]).map(r => [r.address, r.symbol]))
const latest = await rpc.getBlockNumber()
const STEP = 2_000_000n; const found: any[] = []
for (let a = 0n; a <= latest; a += STEP) {
  const b = a + STEP - 1n < latest ? a + STEP - 1n : latest
  const [x, y] = await Promise.all([
    rpc.getLogsChunked({ address: ADDR.poolManager, event: INITIALIZE_EVENT, args: { currency0: spy } }, a, b),
    rpc.getLogsChunked({ address: ADDR.poolManager, event: INITIALIZE_EVENT, args: { currency1: spy } }, a, b)])
  found.push(...[...x, ...y].map(decodeInitialize))
}
const pairs = found.map(p => ({ ...p, other: p.currency0 === spy ? p.currency1 : p.currency0 }))
  .filter(p => tokens.has(p.other) && p.other !== ADDR.usdg && p.hooks === ADDR.zero && p.feePpm !== null)
console.error(`SPY v4 pools total ${found.length}, stock×SPY no-hook fixed-fee ${pairs.length}`)

// DexScreener：每個對手股票查一次，取出與 SPY 的 pair 與該股票的 USDG 主池
const ds = new Map<string, any>()
const byOther = new Map<string, any[]>()
for (const o of new Set(pairs.map(p => p.other))) byOther.set(o, await fetchTokenPairs({ usage }, o))
const sigma = (prices: number[]) => { const r: number[] = []; for (let i = 1; i < prices.length; i++) r.push(Math.log(prices[i] / prices[i - 1])); if (r.length < 24) return null; const m = r.reduce((a, b) => a + b, 0) / r.length; return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / r.length) * Math.sqrt(24 * 7) }
const hourly = (poolId: string) => (db.prepare(`SELECT ts, price_usd FROM pool_hourly WHERE pool_id=? AND price_usd IS NOT NULL ORDER BY ts`).all(poolId) as any[])
const mainUsdgPool = (stock: string) => (db.prepare(`SELECT p.pool_id, s.tvl_usd, s.volume_24h_usd, s.fees_24h_usd, p.fee_ppm FROM pools p JOIN pool_snapshots s ON s.pool_id=p.pool_id AND s.date=(SELECT MAX(date) FROM pool_snapshots)
  WHERE (p.token0=? OR p.token1=?) AND p.hooks=? ORDER BY s.tvl_usd DESC LIMIT 1`).get(stock, stock, ADDR.zero) as any)
const spyMain = mainUsdgPool(spy); const spyH = new Map(hourly(spyMain.pool_id).map(r => [r.ts, r.price_usd]))
const rows: any[] = []
for (const p of pairs) {
  let d = (byOther.get(p.other) ?? []).find(x => x.pairId === p.poolId)
  if (!d) {   // DexScreener token-pairs 只回 30 筆，漏掉的池改用 pair 端點補
    await new Promise(r => setTimeout(r, 1100))
    const j = await fetch(`https://api.dexscreener.com/latest/dex/pairs/robinhood/${p.poolId}`).then(r => r.json()).catch(() => null) as any
    const x = j?.pairs?.[0]; usage.inc('dexscreener')
    if (x) d = { pairId: p.poolId, liquidityUsd: Number(x.liquidity?.usd ?? 0), volume24hUsd: Number(x.volume?.h24 ?? 0) } as any
  }
  const tvl = d?.liquidityUsd ?? 0, vol = d?.volume24hUsd ?? 0
  if (tvl < 5000) continue
  const m = mainUsdgPool(p.other); const h = hourly(m?.pool_id ?? '')
  const ratio = h.filter(r => spyH.has(r.ts)).map(r => r.price_usd / spyH.get(r.ts)!)
  rows.push({ pair: `SPY/${tokens.get(p.other)}`, fee: p.feePpm! / 1e4, tvl, vol, feeTvl: vol * p.feePpm! / 1e6 / tvl * 100, sigUsd: sigma(h.map(r => r.price_usd)), sigRatio: sigma(ratio),
    usdg: m ? { fee: m.fee_ppm / 1e4, tvl: m.tvl_usd, feeTvl: (m.fees_24h_usd ?? 0) / (m.tvl_usd || 1) * 100 } : null, id: p.poolId })
}
rows.sort((a, b) => b.tvl - a.tvl)
const f = (n: number | null | undefined, d = 2) => n === null || n === undefined ? '—' : n.toFixed(d)
console.log('pair            fee%   TVL$      vol24$    費/TVL日%  σ₇股票  σ₇比值  | USDG主池 fee% 費/TVL日%  TVL$')
for (const r of rows) console.log(`${r.pair.padEnd(15)} ${f(r.fee)}  ${Math.round(r.tvl).toString().padStart(9)} ${Math.round(r.vol).toString().padStart(9)}  ${f(r.feeTvl).padStart(7)}   ${f(r.sigUsd === null ? null : r.sigUsd * 100, 1).padStart(5)}%  ${f(r.sigRatio === null ? null : r.sigRatio * 100, 1).padStart(5)}%  | ${r.usdg ? `${f(r.usdg.fee)}  ${f(r.usdg.feeTvl).padStart(7)}  ${Math.round(r.usdg.tvl)}` : '—'}   ${r.id.slice(0, 10)}`)
console.error('api', usage.toJSON())
