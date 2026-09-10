// scripts/lib/replay-core.ts — LP 歷史重放核心（D50–D54）：任意 v4 無 hook 池，固定區塊窗口，
// 手續費 = 小時估計（成交量 × 費率 × 份額）與「歷史 feeGrowth 費」（StateView.getFeeGrowthInside 頭尾差 × L）；LP−HODL、LP−50/50、留存率。
// 慣例：X = token0、Y = token1、P = Y per X（人類單位）；顯示價 = USDG 是 token0 時 1/P，否則 P；區間一律在顯示價上定義。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import type Database from 'better-sqlite3'
import { ADDR, CHAIN } from '../../config/chain.js'
import { ApiUsage } from '../../scanner/sources/usage.js'
import { makeRpc, type Rpc } from '../../scanner/sources/rpc.js'
import { INITIALIZE_EVENT, decodeInitialize, fetchSwaps, type SwapLog } from '../../scanner/sources/uniswapV4.js'
import { liquidityForDeposit, positionAmounts, positionValue } from '../../scanner/metrics/lp-math.js'
import { parseAbi } from 'viem'

export interface PoolInfo { poolId: string; token0: string; token1: string; feePpm: number; tickSpacing: number; d0: number; d1: number; inv: boolean; name: string; createdBlock: bigint | null }
export interface Case { label: string; lower: number; upper: number }   // 顯示價
export interface Row { label: string; Pl: number; Pu: number; inRange: number; exits: number; share: number; est: number; exact: number | null; adjusted: string; fee: number; il: number; net: number; retention: number; vs5050: number; hodlUsd: number }
export interface WindowResult { name: string; from: bigint; to: bigint; t0: number; t1: number; hours: number; swaps: number; disp0: number; dispEnd: number; totalFeeUsd: number; sigmaHourly: number; rows: Row[] }

const SV = parseAbi(['function getFeeGrowthInside(bytes32 poolId, int24 tickLower, int24 tickUpper) view returns (uint256, uint256)', 'function getTickLiquidity(bytes32 poolId, int24 tick) view returns (uint128 liquidityGross, int128 liquidityNet)', 'function getFeeGrowthGlobals(bytes32 poolId) view returns (uint256 feeGrowthGlobal0, uint256 feeGrowthGlobal1)'])

export function makeCtx(db: Database.Database) {
  const usage = new ApiUsage(); const rpc = makeRpc({ usage })
  const arpc = process.env.ALCHEMY_KEY ? makeRpc({ usage, url: CHAIN.alchemyRpc(process.env.ALCHEMY_KEY), source: 'alchemy', concurrency: 2, minGapMs: 60 }) : null
  const tok = (addr: string) => db.prepare('SELECT symbol, decimals FROM tokens WHERE address=?').get(addr) as { symbol: string; decimals: number } | undefined
  const decimals = (a: string) => a === ADDR.usdg ? 6 : (tok(a)?.decimals ?? 18)
  const sym = (a: string) => a === ADDR.usdg ? 'USDG' : (tok(a)?.symbol ?? a.slice(0, 8))
  const usdPrice = (a: string): number | null => a === ADDR.usdg ? 1 : (db.prepare(`SELECT s.price_usd p FROM pool_snapshots s JOIN pools q ON q.pool_id=s.pool_id WHERE s.date=(SELECT MAX(date) FROM pool_snapshots) AND s.price_usd IS NOT NULL AND ((q.token0=? AND q.token1=?) OR (q.token1=? AND q.token0=?)) ORDER BY s.tvl_usd DESC LIMIT 1`).get(a, ADDR.usdg, a, ADDR.usdg) as any)?.p ?? null
  return { db, usage, rpc, arpc, decimals, sym, usdPrice }
}
export type Ctx = ReturnType<typeof makeCtx>

/** target：poolId | SYMBOL（TVL 最大的 USDG 候選 v4 池）| SYM0/SYM1（兩代幣的無 hook v4 池，fee 選費率） */
export async function resolvePool(ctx: Ctx, target: string, feePct = 0.05): Promise<PoolInfo> {
  const { db, rpc } = ctx; let p: { poolId: string; token0: string; token1: string; feePpm: number; tickSpacing: number; createdBlock: bigint | null }
  if (target.startsWith('0x')) { const r = db.prepare('SELECT * FROM pools WHERE pool_id=?').get(target.toLowerCase()) as any; if (!r) throw new Error('pool not in db'); p = { poolId: r.pool_id, token0: r.token0, token1: r.token1, feePpm: r.fee_ppm, tickSpacing: r.tick_spacing, createdBlock: r.created_block ? BigInt(r.created_block) : null } }
  else if (target.includes('/')) {
    const [a, b] = target.split('/').map(s => (db.prepare('SELECT address FROM tokens WHERE symbol=?').get(s.toUpperCase()) as any)?.address as string); if (!a || !b) throw new Error('token not found')
    const [c0, c1] = [a, b].sort(); const feePpm = Math.round(feePct * 1e4); const latest = await rpc.getBlockNumber()
    const logs = (await rpc.getLogsChunked({ address: ADDR.poolManager, event: INITIALIZE_EVENT, args: { currency0: c0 as `0x${string}`, currency1: c1 as `0x${string}` } }, 0n, latest, 3_000_000n)).map(decodeInitialize)
    const f = logs.find(l => l.feePpm === feePpm && l.hooks === ADDR.zero); if (!f) throw new Error(`no hookless v4 pool ${target} at ${feePct}% (fees: ${logs.map(l => l.feePpm).join(',')})`)
    p = { poolId: f.poolId, token0: c0, token1: c1, feePpm, tickSpacing: f.tickSpacing, createdBlock: f.createdBlock }
  } else { const r = db.prepare(`SELECT p.* FROM pools p JOIN tokens t ON t.address=(CASE WHEN p.stock_is_token0 THEN p.token0 ELSE p.token1 END) JOIN pool_snapshots s ON s.pool_id=p.pool_id AND s.date=(SELECT MAX(date) FROM pool_snapshots) WHERE t.symbol=? AND s.excluded=0 AND p.protocol='v4' ORDER BY s.tvl_usd DESC LIMIT 1`).get(target.toUpperCase()) as any; if (!r) throw new Error('no candidate pool'); p = { poolId: r.pool_id, token0: r.token0, token1: r.token1, feePpm: r.fee_ppm, tickSpacing: r.tick_spacing, createdBlock: r.created_block ? BigInt(r.created_block) : null } }
  const d0 = ctx.decimals(p.token0), d1 = ctx.decimals(p.token1)
  return { ...p, d0, d1, inv: p.token0 === ADDR.usdg, name: `${ctx.sym(p.token0)}/${ctx.sym(p.token1)} v4 ${(p.feePpm / 1e4).toFixed(2)}%` }
}

/** swap 快取在 scratchpad（同池同區段不重抓） */
const CACHE_DIR = process.env.REPLAY_CACHE ?? '.cache/replay'
export async function loadSwaps(ctx: Ctx, pool: PoolInfo, from: bigint, to: bigint): Promise<SwapLog[]> {
  mkdirSync(CACHE_DIR, { recursive: true }); const f = `${CACHE_DIR}/${pool.poolId.slice(0, 10)}-${from}-${to}.json`
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'), (k, v) => typeof v === 'string' && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v)
  const sw = await fetchSwaps(ctx.rpc, pool.poolId, from, to)
  writeFileSync(f, JSON.stringify(sw, (k, v) => typeof v === 'bigint' ? v.toString() + 'n' : v)); return sw
}

export const tsOf = async (ctx: Ctx, b: bigint) => Number((await ctx.rpc.call(() => ctx.rpc.client.getBlock({ blockNumber: b }))).timestamp)

/** 一個窗口、一組區間。yUsd：Y 的美元價（token1 = USDG → 1；token0 = USDG → 1/P；其他請給常數或函式） */
export async function replayWindow(ctx: Ctx, pool: PoolInfo, swAll: SwapLog[], from: bigint, to: bigint, t0: number, t1: number, cases: Case[], D_USD: number, yUsd: (P: number, ts: number) => number): Promise<WindowResult> {
  const { d0, d1 } = pool; const LSCALE = 10 ** ((d0 + d1) / 2)
  const sw = swAll.filter(s => s.blockNumber >= from && s.blockNumber <= to); if (sw.length < 2) throw new Error('no swaps in window')
  const interp = (b: bigint) => t0 + Number(b - from) * (t1 - t0) / Number(to - from)
  const H = new Map<number, { p: number; f: number; l: bigint }>()
  for (const s of sw) { const h = Math.floor(interp(s.blockNumber) / 3600); const P = (Number(s.sqrtPriceX96) / 2 ** 96) ** 2 * 10 ** (d0 - d1)
    const fY = (s.amount1 < 0n ? Number(-s.amount1) / 10 ** d1 : Number(-s.amount0) / 10 ** d0 * P) * s.fee / 1e6   // 輸入側 × 費率 → Y
    const r = H.get(h) ?? { p: P, f: 0, l: s.liquidity }; r.p = P; r.f += fY; r.l = s.liquidity; H.set(h, r) }
  const hs = [...H.values()]; const P0 = hs[0].p, Pend = hs[hs.length - 1].p; const Y0 = yUsd(P0, t0), Y1 = yUsd(Pend, t1)
  const lr: number[] = []; for (let i = 1; i < hs.length; i++) lr.push(Math.log(hs[i].p / hs[i - 1].p)); const m = lr.reduce((a, b) => a + b, 0) / lr.length; const sigmaHourly = Math.sqrt(lr.reduce((a, b) => a + (b - m) ** 2, 0) / lr.length)
  const tickMin = Math.min(...sw.map(x => x.tick)), tickMax = Math.max(...sw.map(x => x.tick))
  const tick = (P: number) => Math.log(P * 10 ** (d1 - d0)) / Math.log(1.0001); const priceAt = (t: number) => 1.0001 ** t * 10 ** (d0 - d1)
  const toP = (disp: number) => pool.inv ? 1 / disp : disp; const D = D_USD / Y0
  const init = async (t: number) => { const r = await Promise.all([from, to].map(b => ctx.arpc!.call(() => ctx.arpc!.client.readContract({ address: ADDR.stateView, abi: SV, functionName: 'getTickLiquidity', args: [pool.poolId as `0x${string}`, t], blockNumber: b })))); return (r[0] as any)[0] > 0n && (r[1] as any)[0] > 0n }
  const rows: Row[] = []
  for (const c of cases) {
    const [pa, pb] = [toP(c.lower), toP(c.upper)].sort((a, b) => a - b)
    let tl = Math.floor(tick(pa) / pool.tickSpacing) * pool.tickSpacing, tu = Math.ceil(tick(pb) / pool.tickSpacing) * pool.tickSpacing
    const Pl = priceAt(tl), Pu = priceAt(tu); const L = liquidityForDeposit(D, P0, Pl, Pu), Lraw = L * LSCALE; const { x: x0, y: y0 } = positionAmounts(L, P0, Pl, Pu)
    let est = 0, inR = 0, exits = 0, prev = true, sh = 0
    for (const h of hs) { const ir = h.p >= Pl && h.p <= Pu; if (ir) inR++; if (prev && !ir) exits++; prev = ir; const s = ir ? Lraw / (Number(h.l) + Lraw) : 0; sh += s; est += s * h.f }
    let exact: number | null = null, adjusted = ''
    if (ctx.arpc && tickMin >= tl && tickMax < tu) {
      // 價格整段沒離開區間 → 所有手續費都發生在區間內，feeGrowthGlobal 的差就是 feeGrowthInside 的差，不依賴任何 tick（D55）
      const g = (b: bigint) => ctx.arpc!.call(() => ctx.arpc!.client.readContract({ address: ADDR.stateView, abi: SV, functionName: 'getFeeGrowthGlobals', args: [pool.poolId as `0x${string}`], blockNumber: b })) as Promise<readonly [bigint, bigint]>
      const [a, b] = await Promise.all([g(from), g(to)]); const M = 2n ** 256n; const dd = (x: bigint, y: bigint) => ((y - x) % M + M) % M; const LB = BigInt(Math.round(Lraw))
      const fX = Number(LB * dd(a[0], b[0]) / 2n ** 128n) / 10 ** d0, fY = Number(LB * dd(a[1], b[1]) / 2n ** 128n) / 10 ** d1; const feeY = fX * Pend + fY
      const poolFeeY = hs.reduce((q, h) => q + h.f, 0); if (feeY > 0 && feeY <= poolFeeY * 1.5) { exact = feeY; adjusted = 'global' }
    } else if (ctx.arpc) {
      // 價格曾離開區間：原始邊界 tick 頭尾都初始化才能用 feeGrowthInside（D53）
      let l = tl, u = tu; const okOrig = await init(tl) && await init(tu)
      if (!okOrig && tickMin >= tl && tickMax < tu) { for (let i = 0; i < 12 && !(await init(l)); i++) l -= pool.tickSpacing; for (let i = 0; i < 12 && !(await init(u)); i++) u += pool.tickSpacing }
      if (okOrig || (tickMin >= tl && tickMax < tu && await init(l) && await init(u))) {
        if (l !== tl || u !== tu) adjusted = `對照 tick ${l}/${u}`
        const g = (b: bigint) => ctx.arpc!.call(() => ctx.arpc!.client.readContract({ address: ADDR.stateView, abi: SV, functionName: 'getFeeGrowthInside', args: [pool.poolId as `0x${string}`, l, u], blockNumber: b })) as Promise<readonly [bigint, bigint]>
        const [a, b] = await Promise.all([g(from), g(to)]); const M = 2n ** 256n; const dd = (x: bigint, y: bigint) => ((y - x) % M + M) % M; const LB = BigInt(Math.round(Lraw))
        const fX = Number(LB * dd(a[0], b[0]) / 2n ** 128n) / 10 ** d0, fY = Number(LB * dd(a[1], b[1]) / 2n ** 128n) / 10 ** d1; const feeY = fX * Pend + fY
        const poolFeeY = hs.reduce((q, h) => q + h.f, 0); if (feeY > 0 && feeY <= poolFeeY) exact = feeY   // 物理上限：一個頭寸拿不到超過整池的費（tick 在窗口內被清空/重建時差值會爆掉）
      }
    }
    const fee = exact ?? est; const lp = positionValue(L, Pend, Pl, Pu), hodl = x0 * Pend + y0; const il = lp - hodl, net = fee + il
    const half = (D / 2 / P0) * Pend + D / 2   // 50/50 組合：開倉時一半 Y、一半 X
    rows.push({ label: c.label, Pl, Pu, inRange: inR / hs.length, exits, share: sh / hs.length, est: est * Y1, exact: exact === null ? null : exact * Y1, adjusted, fee: fee * Y1, il: il * Y1, net: net * Y1, retention: fee > 0 ? net / fee : 0, vs5050: (fee + lp - half) * Y1, hodlUsd: hodl * Y1 - D_USD })
  }
  const disp = (P: number) => pool.inv ? 1 / P : P
  return { name: pool.name, from, to, t0, t1, hours: hs.length, swaps: sw.length, disp0: disp(P0), dispEnd: disp(Pend), totalFeeUsd: hs.reduce((a, h) => a + h.f, 0) * Y1, sigmaHourly, rows }
}
export const showP = (pool: PoolInfo, P: number) => (pool.inv ? 1 / P : P).toFixed(pool.inv ? 2 : 4)

// ---- 有狀態的區間管理策略模擬（D55）：整段時間一個頭寸，依策略重開，扣 swap 費 + gas。手續費用小時估計（份額法），SPY/QQQ 這類池已知偏高。
export interface HourRow { ts: number; p: number; f: number; l: bigint }
export function hourlyRows(pool: PoolInfo, sw: SwapLog[], from: bigint, to: bigint, t0: number, t1: number): HourRow[] {
  const { d0, d1 } = pool; const interp = (b: bigint) => t0 + Number(b - from) * (t1 - t0) / Number(to - from); const H = new Map<number, HourRow>()
  for (const s of sw) { if (s.blockNumber < from || s.blockNumber > to) continue; const h = Math.floor(interp(s.blockNumber) / 3600); const P = (Number(s.sqrtPriceX96) / 2 ** 96) ** 2 * 10 ** (d0 - d1)
    const fY = (s.amount1 < 0n ? Number(-s.amount1) / 10 ** d1 : Number(-s.amount0) / 10 ** d0 * P) * s.fee / 1e6
    const r = H.get(h) ?? { ts: h * 3600, p: P, f: 0, l: s.liquidity }; r.p = P; r.f += fY; r.l = s.liquidity; H.set(h, r) }
  return [...H.values()].sort((a, b) => a.ts - b.ts)
}
export type Policy = { kind: 'static' } | { kind: 'oor_hours'; hours: number } | { kind: 'beyond_pct'; pct: number } | { kind: 'weekly' }
export interface StatefulResult { fees: number; costs: number; recenters: number; lpEnd: number; hodlEnd: number; net: number; inRange: number; hours: number }
/** widthPct：區間半寬（顯示價 ±%）；costs：gasPerRecenterUsd（換成 Y 用 yUsd），swapFee = 池費率 + 滑價（比例，對重平衡的那一半） */
export function simulateStateful(pool: PoolInfo, hs: HourRow[], widthPct: number, policy: Policy, D_USD: number, yUsd: (P: number) => number, gasUsd: number, swapCost: number): StatefulResult {
  const { liquidityForDeposit: lfd, positionAmounts: pa, positionValue: pv } = { liquidityForDeposit, positionAmounts, positionValue }
  const rangeAt = (P: number) => { const disp = pool.inv ? 1 / P : P; const a = pool.inv ? 1 / (disp * (1 + widthPct / 100)) : disp * (1 - widthPct / 100), b = pool.inv ? 1 / (disp * (1 - widthPct / 100)) : disp * (1 + widthPct / 100); return [Math.min(a, b), Math.max(a, b)] }
  const LSCALE = 10 ** ((pool.d0 + pool.d1) / 2); const P0 = hs[0].p; const D = D_USD / yUsd(P0)
  let [Pl, Pu] = rangeAt(P0); let L = lfd(D, P0, Pl, Pu); const { x: hx, y: hy } = pa(L, P0, Pl, Pu)   // HODL 基準 = 開倉當下的 token
  let fees = 0, costs = 0, recenters = 0, inR = 0, oorSince: number | null = null, lastWeekly = hs[0].ts
  const recenter = (P: number, ts: number) => {
    const val = pv(L, P, Pl, Pu); const { x, y } = pa(L, P, Pl, Pu); const [nl, nu] = rangeAt(P); const nL = lfd(val, P, nl, nu); const { x: nx } = pa(nL, P, nl, nu)
    const swapped = Math.abs(nx - x) * P   // 以 Y 計的換幣量（一邊多出來換成另一邊）
    const c = swapped * swapCost + gasUsd / yUsd(P); costs += c
    const val2 = val - c; L = lfd(val2, P, nl, nu); Pl = nl; Pu = nu; recenters++; oorSince = null; lastWeekly = ts
  }
  for (let i = 0; i < hs.length; i++) {
    const h = hs[i]; const P = h.p; const ir = P >= Pl && P <= Pu
    if (ir) { inR++; const Lraw = L * LSCALE; fees += Lraw / (Number(h.l) + Lraw) * h.f; oorSince = null } else if (oorSince === null) oorSince = h.ts
    if (i === hs.length - 1) break
    if (policy.kind === 'oor_hours' && oorSince !== null && h.ts - oorSince >= policy.hours * 3600) recenter(P, h.ts)
    else if (policy.kind === 'beyond_pct') { const disp = pool.inv ? 1 / P : P; const [dl, du] = pool.inv ? [1 / Pu, 1 / Pl] : [Pl, Pu]; if (disp < dl * (1 - policy.pct / 100) || disp > du * (1 + policy.pct / 100)) recenter(P, h.ts) }
    else if (policy.kind === 'weekly' && h.ts - lastWeekly >= 7 * 86400) recenter(P, h.ts)
  }
  const Pend = hs[hs.length - 1].p; const k = yUsd(Pend); const lpEnd = pv(L, Pend, Pl, Pu), hodlEnd = hx * Pend + hy
  return { fees: fees * k, costs: costs * k, recenters, lpEnd: lpEnd * k, hodlEnd: hodlEnd * k, net: (fees - costs + lpEnd - hodlEnd) * k, inRange: inR / hs.length, hours: hs.length }
}
