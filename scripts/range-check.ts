// scripts/range-check.ts — 開倉前評估一個自訂區間（DECISIONS D43）
// 用法：pnpm range <poolId> <下限> <上限> [投入=1000]
// 輸出：過去資料裡價格待在區間的比例、出區間次數、以現價開倉的兩邊配比、模擬手續費、份額、容量、回本天數
import 'dotenv/config'
import { openDb } from '../db/index.js'
import { loadHourly } from '../scanner/steps.js'
import { liquidityForDeposit, positionAmounts, positionValue, L_HUMAN_TO_RAW } from '../scanner/metrics/lp-math.js'
import { lifecycleCost } from '../scanner/metrics/economics.js'
import { loadScoring } from '../config/chain.js'
const [pid, loArg, hiArg, dArg] = process.argv.slice(2)
if (!pid || !loArg || !hiArg) { console.log('用法: pnpm range <poolId> <下限> <上限> [投入=1000]'); process.exit(1) }
const Pl = Number(loArg), Pu = Number(hiArg), D = Number(dArg ?? 1000); if (!(Pl < Pu)) { console.log('下限要小於上限'); process.exit(1) }
const db = openDb('db/lp.sqlite'); const cfg = loadScoring()
const pool = db.prepare(`SELECT p.*, t.symbol FROM pools p JOIN tokens t ON t.address = CASE WHEN p.stock_is_token0=1 THEN p.token0 ELSE p.token1 END WHERE p.pool_id=?`).get(pid.toLowerCase()) as any
if (!pool) { console.log('找不到池'); process.exit(1) }
const hours = loadHourly(db, pid.toLowerCase(), 24 * 45); if (!hours.length) { console.log('此池沒有小時資料'); process.exit(1) }
const P = hours.at(-1)!.priceUsd; const L = liquidityForDeposit(D, P, Pl, Pu); const Lraw = L * L_HUMAN_TO_RAW
const { x, y } = positionAmounts(L, P, Pl, Pu)
const inHours = hours.filter(h => h.priceUsd >= Pl && h.priceUsd <= Pu).length
let exits = 0; for (let i = 1; i < hours.length; i++) { const a = hours[i - 1].priceUsd, b = hours[i].priceUsd; const inA = a >= Pl && a <= Pu, inB = b >= Pl && b <= Pu; if (inA && !inB) exits++ }
let fees = 0, shareSum = 0, shareN = 0
for (const h of hours) { const inR = h.priceUsd >= Pl && h.priceUsd <= Pu; const Lp = h.liquidity ? Number(h.liquidity) : 0; const share = inR && Lp > 0 ? Lraw / (Lp + Lraw) : 0; fees += share * h.feesUsd; if (inR && Lp > 0) { shareSum += share; shareN++ } }
const days = hours.length / 24; const dailyFee = fees / days
const lastL = [...hours].reverse().find(h => h.liquidity)?.liquidity; const lPerDollar = liquidityForDeposit(1, P, Pl, Pu) * L_HUMAN_TO_RAW
const capacity = lastL ? (cfg.economics.capacity_share / (1 - cfg.economics.capacity_share)) * Number(lastL) / lPerDollar : null
const cost = lifecycleCost(D, pool.fee_ppm, dailyFee, cfg.economics.gas_usd_per_tx, cfg.economics.lifecycle_txs)
const lo = Math.min(...hours.map(h => h.priceUsd)), hi = Math.max(...hours.map(h => h.priceUsd))
const pct = (v: number) => (v * 100).toFixed(1) + '%'
console.log(`${pool.symbol}/USDG ${pool.protocol} ${pool.fee_ppm !== null ? (pool.fee_ppm / 1e4).toFixed(2) + '%' : '動態'}  ${pid}`)
console.log(`區間 ${Pl} – ${Pu}（現價 ${P.toFixed(2)}：−${pct(1 - Pl / P)} / +${pct(Pu / P - 1)}，總寬 ${pct((Pu - Pl) / P)}）· 投入 $${D}`)
console.log(`\n【歷史】${hours.length} 小時（${days.toFixed(1)} 天）價格 ${lo.toFixed(2)} – ${hi.toFixed(2)}`)
console.log(`  待在區間 ${pct(inHours / hours.length)}（${inHours}h）· 往外出去 ${exits} 次`)
console.log(`\n【以現價開倉】需要 ${x.toFixed(4)} ${pool.symbol}（$${(x * P).toFixed(2)}，${pct(x * P / D)}）+ ${y.toFixed(2)} USDG（${pct(y / D)}）`)
console.log(`  跌到 ${Pl} 時全變 ${pool.symbol}：${positionAmounts(L, Pl, Pl, Pu).x.toFixed(4)} 顆（市值 $${positionValue(L, Pl, Pl, Pu).toFixed(2)}）；漲到 ${Pu} 時全變 USDG：$${positionValue(L, Pu, Pl, Pu).toFixed(2)}`)
console.log(`\n【模擬手續費】用同一段歷史：合計 $${fees.toFixed(2)} → 每天 $${dailyFee.toFixed(2)}（${pct(dailyFee / D)}/日，年化 ${pct(dailyFee / D * 365)}）· 平均份額 ${shareN ? ((shareSum / shareN) * 100).toFixed(3) + '%' : '—'}`)
console.log(`【成本】進出 swap + ${cfg.economics.lifecycle_txs} 筆 gas ≈ $${cost.totalUsd.toFixed(2)} → 回本 ${cost.breakevenDays ? cost.breakevenDays.toFixed(1) + ' 天' : '—'}`)
console.log(`【容量】此區間投入超過 ${capacity ? '$' + Math.round(capacity).toLocaleString() : '—'} 就會佔到 active liquidity ${pct(cfg.economics.capacity_share)}，開始明顯稀釋自己`)
db.close()
