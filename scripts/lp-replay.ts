// scripts/lp-replay.ts — 用固定區塊窗口的真實 swap 重放一個 v4 池：$D 在各區間的手續費（小時估計 + 歷史 feeGrowth）、LP−HODL、淨、留存率（D50–D52）
// 用法：pnpm replay <poolId | SYMBOL | SYM0/SYM1> [--days=5] [--d=1000] [--ranges=5,10,25 | --lower=<顯示價> --upper=<顯示價>] [--from=<block>] [--to=<block>] [--fee=0.05]
//   SYMBOL   → 該股票 TVL 最大的 USDG 候選池；SYM0/SYM1 → 兩個代幣的 v4 無 hook 池（--fee 選費率，預設 0.05）
// 通用：X = token0、Y = token1、P = Y per X（人類單位）；D 以 Y 計（USD ÷ Y 的美元價）；L_raw = L_human × 10^((d0+d1)/2)
import { openDb } from '../db/index.js'
import { ADDR, CHAIN } from '../config/chain.js'
import { ApiUsage } from '../scanner/sources/usage.js'
import { makeRpc } from '../scanner/sources/rpc.js'
import { INITIALIZE_EVENT, decodeInitialize, fetchSwaps } from '../scanner/sources/uniswapV4.js'
import { liquidityForDeposit, positionAmounts, positionValue } from '../scanner/metrics/lp-math.js'
import { parseAbi } from 'viem'

const args = process.argv.slice(2); const target = args.find(a => !a.startsWith('--'))!; const opt = (k: string, d: string) => (args.find(a => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=')[1]
const DAYS = Number(opt('days', '5')), D_USD = Number(opt('d', '1000')), RANGES = opt('ranges', '5,10,25').split(',').map(Number), FEE = Number(opt('fee', '0.05'))
const db = openDb('db/lp.sqlite'); const usage = new ApiUsage(); const rpc = makeRpc({ usage })
const tok = (addr: string) => db.prepare('SELECT symbol, decimals FROM tokens WHERE address=?').get(addr) as { symbol: string; decimals: number } | undefined
const decimals = (addr: string) => addr === ADDR.usdg ? 6 : (tok(addr)?.decimals ?? 18)
const sym = (addr: string) => addr === ADDR.usdg ? 'USDG' : (tok(addr)?.symbol ?? addr.slice(0, 8))
const usdPrice = (addr: string): number | null => addr === ADDR.usdg ? 1 : (db.prepare(`SELECT s.price_usd p FROM pool_snapshots s JOIN pools q ON q.pool_id=s.pool_id WHERE s.date=(SELECT MAX(date) FROM pool_snapshots) AND s.price_usd IS NOT NULL AND ((q.token0=? AND q.token1=?) OR (q.token1=? AND q.token0=?)) ORDER BY s.tvl_usd DESC LIMIT 1`).get(addr, ADDR.usdg, addr, ADDR.usdg) as any)?.p ?? null

// 1. 解析池
let pool: { poolId: string; token0: string; token1: string; feePpm: number; tickSpacing: number }
const latest0 = await rpc.getBlockNumber()
if (target.startsWith('0x')) { const r = db.prepare('SELECT * FROM pools WHERE pool_id=?').get(target.toLowerCase()) as any; if (!r) throw new Error('pool not in db'); pool = { poolId: r.pool_id, token0: r.token0, token1: r.token1, feePpm: r.fee_ppm, tickSpacing: r.tick_spacing } }
else if (target.includes('/')) {
  const [a, b] = target.split('/').map(s => (db.prepare('SELECT address FROM tokens WHERE symbol=?').get(s.toUpperCase()) as any)?.address as string); if (!a || !b) throw new Error('token not found')
  const [c0, c1] = [a, b].sort(); const feePpm = Math.round(FEE * 1e4)
  const logs = (await rpc.getLogsChunked({ address: ADDR.poolManager, event: INITIALIZE_EVENT, args: { currency0: c0 as `0x${string}`, currency1: c1 as `0x${string}` } }, 0n, latest0, 3_000_000n)).map(decodeInitialize)
  const p = logs.find(l => l.feePpm === feePpm && l.hooks === ADDR.zero); if (!p) throw new Error(`no hookless v4 pool ${target} at ${FEE}% (found fees: ${logs.map(l => l.feePpm).join(',')})`)
  pool = { poolId: p.poolId, token0: c0, token1: c1, feePpm, tickSpacing: p.tickSpacing }
} else { const r = db.prepare(`SELECT p.* FROM pools p JOIN tokens t ON t.address=(CASE WHEN p.stock_is_token0 THEN p.token0 ELSE p.token1 END) JOIN pool_snapshots s ON s.pool_id=p.pool_id AND s.date=(SELECT MAX(date) FROM pool_snapshots) WHERE t.symbol=? AND s.excluded=0 AND p.protocol='v4' ORDER BY s.tvl_usd DESC LIMIT 1`).get(target.toUpperCase()) as any; if (!r) throw new Error('no candidate pool'); pool = { poolId: r.pool_id, token0: r.token0, token1: r.token1, feePpm: r.fee_ppm, tickSpacing: r.tick_spacing } }
const d0 = decimals(pool.token0), d1 = decimals(pool.token1); const LSCALE = 10 ** ((d0 + d1) / 2)
// Y 的美元價：token1 是 USDG → 1；token0 是 USDG → 1/P；都不是 → 查 token1 的 USDG 主池小時價（最接近該時刻）
const yPoolId = pool.token1 === ADDR.usdg || pool.token0 === ADDR.usdg ? null : (db.prepare(`SELECT s.pool_id FROM pool_snapshots s JOIN pools q ON q.pool_id=s.pool_id WHERE s.date=(SELECT MAX(date) FROM pool_snapshots) AND s.price_usd IS NOT NULL AND ((q.token0=? AND q.token1=?) OR (q.token1=? AND q.token0=?)) ORDER BY s.tvl_usd DESC LIMIT 1`).get(pool.token1, ADDR.usdg, pool.token1, ADDR.usdg) as any)?.pool_id
const yUsdAt = (ts: number, P: number): number => pool.token1 === ADDR.usdg ? 1 : pool.token0 === ADDR.usdg ? 1 / P : ((db.prepare('SELECT price_usd p FROM pool_hourly WHERE pool_id=? AND price_usd IS NOT NULL ORDER BY ABS(ts-?) LIMIT 1').get(yPoolId, ts) as any)?.p ?? usdPrice(pool.token1))
const name = `${sym(pool.token0)}/${sym(pool.token1)} v4 ${(pool.feePpm / 1e4).toFixed(2)}%`

// 2. 固定窗口
const to = BigInt(opt('to', latest0.toString())), from = BigInt(opt('from', (to - BigInt(DAYS * CHAIN.blocksPerDay)).toString()))
const t0 = Number((await rpc.call(() => rpc.client.getBlock({ blockNumber: from }))).timestamp), t1 = Number((await rpc.call(() => rpc.client.getBlock({ blockNumber: to }))).timestamp)
const interp = (b: bigint) => t0 + Number(b - from) * (t1 - t0) / Number(to - from)
const sw = await fetchSwaps(rpc, pool.poolId, from, to)
const H = new Map<number, { p: number; f: number; l: bigint }>()
for (const s of sw) { const h = Math.floor(interp(s.blockNumber) / 3600); const P = (Number(s.sqrtPriceX96) / 2 ** 96) ** 2 * 10 ** (d0 - d1); const fY = (s.amount1 < 0n ? Number(-s.amount1) / 10 ** d1 : Number(-s.amount0) / 10 ** d0 * P) * s.fee / 1e6   // 輸入側 × 費率，換成 Y
  const r = H.get(h) ?? { p: P, f: 0, l: s.liquidity }; r.p = P; r.f += fY; r.l = s.liquidity; H.set(h, r) }
const hs = [...H.values()]; const P0 = hs[0].p, Pend = hs[hs.length - 1].p; const totalFeeY = hs.reduce((a, h) => a + h.f, 0)
const Y0 = yUsdAt(t0, P0), Y1 = yUsdAt(t1, Pend); const showP = (P: number) => pool.token0 === ADDR.usdg ? (1 / P).toFixed(2) : P.toFixed(4)
const tickMin = Math.min(...sw.map(x => x.tick)), tickMax = Math.max(...sw.map(x => x.tick))
console.log(`${name} · 區塊 ${from}–${to} · ${new Date(t0 * 1000).toISOString().slice(0, 13)} → ${new Date(t1 * 1000).toISOString().slice(0, 13)}（${((t1 - t0) / 86400).toFixed(1)} 天）· swaps ${sw.length} · 價 ${showP(P0)} → ${showP(Pend)}（${((showP(Pend) as any) / (showP(P0) as any) * 100 - 100).toFixed(2)}%）· 池總費 $${Math.round(totalFeeY * Y1).toLocaleString()} · ${sym(pool.token1)} $${Y0.toFixed(2)} → $${Y1.toFixed(2)}`)

// 3. 歷史 feeGrowth（Alchemy 歷史狀態）：不是 counterfactual，假想 L 未加入池；$1k 級誤差 < 1%
const SV = parseAbi(['function getFeeGrowthInside(bytes32 poolId, int24 tickLower, int24 tickUpper) view returns (uint256, uint256)', 'function getTickLiquidity(bytes32 poolId, int24 tick) view returns (uint128 liquidityGross, int128 liquidityNet)'])
const arpc = process.env.ALCHEMY_KEY ? makeRpc({ usage, url: CHAIN.alchemyRpc(process.env.ALCHEMY_KEY), source: 'alchemy', concurrency: 1 }) : null
let adjusted = ''
async function feeGrowthFee(tl: number, tu: number, Lraw: bigint): Promise<number | null> {
  adjusted = ''; if (!arpc) return null
  const g = (b: bigint) => arpc.call(() => arpc.client.readContract({ address: ADDR.stateView, abi: SV, functionName: 'getFeeGrowthInside', args: [pool.poolId as `0x${string}`, tl, tu], blockNumber: b })) as Promise<readonly [bigint, bigint]>
  // 邊界 tick 必須在窗口頭尾兩個區塊都有流動性：tick 在窗口內被清空或新建都會重設 feeGrowthOutside，差值就沒有意義（D52）。
  // 不合格就往外找最近的合格 tick（價格在兩個區間內時每單位 L 的 fee 相同），找不到回 null。
  const init = async (t: number) => { const [x, y] = await Promise.all([from, to].map(b => arpc!.call(() => arpc!.client.readContract({ address: ADDR.stateView, abi: SV, functionName: 'getTickLiquidity', args: [pool.poolId as `0x${string}`, t], blockNumber: b })))); return (x as any)[0] > 0n && (y as any)[0] > 0n }
  // 外推只在價格整段都留在「原始」區間內才允許（GPT：否則外側區間會把原始頭寸出區間時的費也算進來）
  if (tickMin < tl || tickMax >= tu) return null
  let l = tl, u = tu; for (let i = 0; i < 12 && !(await init(l)); i++) l -= pool.tickSpacing; for (let i = 0; i < 12 && !(await init(u)); i++) u += pool.tickSpacing
  if (!(await init(l)) || !(await init(u))) return null
  if (l !== tl || u !== tu) adjusted = `（對照 tick ${l}/${u}）`
  tl = l; tu = u
  const [a, b] = await Promise.all([g(from), g(to)]); const M = 2n ** 256n; const dd = (x: bigint, y: bigint) => ((y - x) % M + M) % M
  const fX = Number(Lraw * dd(a[0], b[0]) / 2n ** 128n) / 10 ** d0, fY = Number(Lraw * dd(a[1], b[1]) / 2n ** 128n) / 10 ** d1
  const feeY = fX * Pend + fY; return feeY > 0 ? feeY : null   // 不再用估計的 totalFeeY 當守門（GPT）
}

// 4. 各區間
const D = D_USD / Y0; const tick = (P: number) => Math.log(P * 10 ** (d1 - d0)) / Math.log(1.0001); const priceAt = (t: number) => 1.0001 ** t * 10 ** (d0 - d1)
const inv = pool.token0 === ADDR.usdg; const toP = (disp: number) => inv ? 1 / disp : disp; const disp0 = inv ? 1 / P0 : P0   // 區間永遠在「顯示價」上定義（D53）
const lowerArg = args.find(a => a.startsWith('--lower=')), upperArg = args.find(a => a.startsWith('--upper='))
const cases: [string, number, number][] = lowerArg && upperArg ? [[`[${opt('lower', '')}–${opt('upper', '')}]`, Number(opt('lower', '')), Number(opt('upper', ''))]] : RANGES.map(R => [`±${String(R).padStart(2)}%`, disp0 * (1 - R / 100), disp0 * (1 + R / 100)])
console.log(`token0 ${sym(pool.token0)}（${d0}）/ token1 ${sym(pool.token1)}（${d1}）· 顯示價 = ${inv ? '1/P' : 'P'} · 區間以顯示價定義`)
console.log(`投入 $${D_USD} · 區間                     在區間 出去 份額    估計費   feeGrowth費  LP−HODL(不含費)  淨(LP−HODL)  留存率  費/日    HODL本身`)
for (const [label, dl, du] of cases) {
  const [pa, pb] = [toP(dl), toP(du)].sort((a, b) => a - b)
  const tl = Math.floor(tick(pa) / pool.tickSpacing) * pool.tickSpacing, tu = Math.ceil(tick(pb) / pool.tickSpacing) * pool.tickSpacing
  const Pl = priceAt(tl), Pu = priceAt(tu); const L = liquidityForDeposit(D, P0, Pl, Pu); const Lraw = L * LSCALE; const { x: x0, y: y0 } = positionAmounts(L, P0, Pl, Pu)
  let est = 0, inR = 0, exits = 0, prev = true, sh = 0
  for (const h of hs) { const ir = h.p >= Pl && h.p <= Pu; if (ir) inR++; if (prev && !ir) exits++; prev = ir; const s = ir ? Lraw / (Number(h.l) + Lraw) : 0; sh += s; est += s * h.f }
  const exact = await feeGrowthFee(tl, tu, BigInt(Math.round(Lraw))); const fee = exact ?? est
  const lp = positionValue(L, Pend, Pl, Pu), hodl = x0 * Pend + y0; const il = lp - hodl, net = fee + il; const k = Y1
  const f = (v: number) => ('$' + (v * k).toFixed(2)).padStart(8)
  console.log(`  ${label} [${[showP(Pl), showP(Pu)].sort((a, b) => Number(a) - Number(b)).join('–')}]`.padEnd(30) + `${(inR / hs.length * 100).toFixed(0).padStart(4)}%  ${String(exits).padStart(2)}  ${(sh / hs.length * 100).toFixed(2).padStart(5)}%  ${f(est)}  ${exact === null ? '   無效  ' : f(exact)}     ${f(il)}        ${f(net)}   ${(fee > 0 ? net / fee * 100 : 0).toFixed(0).padStart(4)}%  ${f(fee / ((t1 - t0) / 86400))}  ${('$' + (hodl * Y1 - D_USD).toFixed(2)).padStart(8)}${exact === null ? '   （feeGrowth 無效：價格曾離開區間或找不到頭尾都初始化的邊界 tick，淨用估計費）' : adjusted}`)
}
console.error('api', usage.toJSON())
