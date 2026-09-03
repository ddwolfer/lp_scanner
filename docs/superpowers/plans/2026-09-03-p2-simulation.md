# P2 Simulation & Scoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 實作 SPEC §7 模擬淨收益（純函式 + §7.4 三個單元測試）、§8.3 評分、`scripts/sim-check.ts` 人工核對工具，並接進每日 scanner 與 §13 Telegram 格式。

**Architecture:** `metrics/simulate.ts` 是純函式：輸入小時列（價格、手續費、池流動性）與參數 (D, R)，輸出 §7.3 的結果物件。`metrics/volatility.ts` 算 σ₇。`metrics/score.ts` 依 `config/scoring.json` 打分。`scanner/run.ts` 在快照寫完後，對未硬排除的池讀 `pool_hourly` 最近 30 天跑 9 組模擬，回寫 `sim` 與 `score`。份額用 v4 Swap 事件的 `liquidity`（DECISIONS D1）。

**Tech Stack:** TypeScript、vitest、better-sqlite3（既有）。

**Spec:** `SPEC.md` §7、§8.2–8.4、§13、§12 P2；`DECISIONS.md` D1、D2、D4、D13。

## Global Constraints

- §7 評分公式與 §7.3 輸出欄位名稱不可更動：`fees_usd, value_end_usd, il_usd, net_usd, net_pct, net_apr, in_range_hours, in_range_pct, exits`。
- D ∈ {200, 1000, 5000}；R ∈ {r10: ±10%, r25: ±25%, rvol: ±2σ₇ 夾在 [5%, 40%]，資料 < 5 天退回 ±25% 並 `flags += "rvol_fallback"`}。
- N = min(30, 可用天數)。`sim` JSON 結構：`{ d200: { r10, r25, rvol }, d1000: …, d5000: … }`。
- `metrics/simulate.ts` 必須是純函式，附 §7.4 三個測試。
- 權重與 `sort_key` 讀 `config/scoring.json`，不寫死；程式要支援任意 (D, R) 當排序鍵。
- 價格軸：`price_usd` = 股票 / USDG（D13）。X = 股票代幣、Y = USDG。
- 流動性單位換算（推導見 Task 1 註解）：人類單位的 L 轉成鏈上 raw 單位為 `L × 1e12`，不論股票在 token0 或 token1。

---

## File Structure

```
scanner/metrics/lp-math.ts      v3 集中流動性公式（純）：liquidityForDeposit、positionValue、positionAmounts
scanner/metrics/simulate.ts     simulate(hours, {D,R}) → SimResult；simulateAll(hours, sigma) → SimJson + flags
scanner/metrics/volatility.ts   weeklySigma(prices) → σ₇ | null
scanner/metrics/score.ts        scorePools(rows, scoring) → Map<poolId, score>；getSimField(sim, sortKey, field)
scanner/steps.ts                +loadHourly(db, poolId, hours)、updateSim(db, poolId, date, sim, score, flags)
scanner/run.ts                  快照迴圈後新增「模擬與評分」階段；摘要改 §13 格式
scanner/notify/summary.ts       Top 5 行改為 net APR / 在區間 / 交易者
scripts/sim-check.ts            逐小時表格
tests/lp-math.test.ts, simulate.test.ts, volatility.test.ts, score.test.ts（+ 修改 summary.test.ts, steps.test.ts）
```

---

### Task 1: 集中流動性數學 `metrics/lp-math.ts`

**Files:** Create `scanner/metrics/lp-math.ts`, `tests/lp-math.test.ts`

**Interfaces:**
- `liquidityForDeposit(D: number, P0: number, Pl: number, Pu: number): number` — 使區間頭寸在 P0 的市值恰為 D 的 L（人類單位）。
- `positionAmounts(L, P, Pl, Pu): { x: number; y: number }` — 在價格 P 的持有量（X = 股票、Y = USDG），區間外為單邊。
- `positionValue(L, P, Pl, Pu): number` = x × P + y。
- `L_HUMAN_TO_RAW = 1e12`。

推導（寫在檔案註解）：區間內 x = L(1/√P − 1/√Pu)、y = L(√P − √Pl)；價值 V(P) = L(2√P − √Pl − P/√Pu)；L = D / (2√P0 − √Pl − P0/√Pu)。P < Pl：x = L(1/√Pl − 1/√Pu)、y = 0；P > Pu：x = 0、y = L(√Pu − √Pl)。raw 換算：USDG_raw = L_raw × Δ√P_raw，Δ√P_raw = Δ√P_h × 1e−6（股票在 token0 時 P_raw = P_h × 1e−12；在 token1 時 1/√P'_raw = √P_h × 1e−6，同結果），USDG_raw = USDG_h × 1e6 → L_raw = L_h × 1e12。

- [ ] **Step 1: 失敗測試**

```ts
// tests/lp-math.test.ts
import { it, expect } from 'vitest'
import { liquidityForDeposit, positionAmounts, positionValue } from '../scanner/metrics/lp-math.js'
const P0 = 100, Pl = 75, Pu = 125, D = 1000
const L = liquidityForDeposit(D, P0, Pl, Pu)
it('在 P0 的市值 = D，且兩邊價值接近各半', () => {
  expect(positionValue(L, P0, Pl, Pu)).toBeCloseTo(D, 6)
  const { x, y } = positionAmounts(L, P0, Pl, Pu)
  expect(x * P0).toBeGreaterThan(400); expect(y).toBeGreaterThan(400)   // 對稱區間，非精確一半
})
it('低於 Pl 全是股票，高於 Pu 全是 USDG', () => {
  expect(positionAmounts(L, 50, Pl, Pu).y).toBe(0)
  expect(positionAmounts(L, 200, Pl, Pu).x).toBe(0)
  expect(positionValue(L, 200, Pl, Pu)).toBeCloseTo(positionValue(L, Pu, Pl, Pu), 6)   // 出區間後不再變
})
it('市值對價格單調不減，且低於持有對照（IL ≥ 0）', () => {
  const { x: x0, y: y0 } = positionAmounts(L, P0, Pl, Pu)
  for (const P of [60, 80, 100, 120, 140]) expect(positionValue(L, P, Pl, Pu)).toBeLessThanOrEqual(x0 * P + y0 + 1e-9)
})
```

- [ ] **Step 2: 跑** `pnpm test tests/lp-math.test.ts` → FAIL。
- [ ] **Step 3: 實作**

```ts
// scanner/metrics/lp-math.ts — Uniswap v3/v4 集中流動性公式，純函式。X = 股票代幣，Y = USDG，P = X 以 Y 計價
// 區間內：x = L(1/√P − 1/√Pu)，y = L(√P − √Pl)，V = L(2√P − √Pl − P/√Pu)
// L_raw = L_human × 1e12（股票 18 decimals、USDG 6 decimals，推導見 docs/superpowers/plans/2026-09-03-p2-simulation.md Task 1）
export const L_HUMAN_TO_RAW = 1e12
export function liquidityForDeposit(D: number, P0: number, Pl: number, Pu: number): number {
  const s0 = Math.sqrt(P0), sl = Math.sqrt(Pl), su = Math.sqrt(Pu)
  return D / (2 * s0 - sl - P0 / su)
}
export function positionAmounts(L: number, P: number, Pl: number, Pu: number): { x: number; y: number } {
  const sl = Math.sqrt(Pl), su = Math.sqrt(Pu)
  if (P <= Pl) return { x: L * (1 / sl - 1 / su), y: 0 }
  if (P >= Pu) return { x: 0, y: L * (su - sl) }
  const s = Math.sqrt(P)
  return { x: L * (1 / s - 1 / su), y: L * (s - sl) }
}
export function positionValue(L: number, P: number, Pl: number, Pu: number): number {
  const { x, y } = positionAmounts(L, P, Pl, Pu)
  return x * P + y
}
```

- [ ] **Step 4: 跑** → PASS。
- [ ] **Step 5: Commit** `git commit -m "feat: concentrated liquidity math"`

---

### Task 2: 波動率 `metrics/volatility.ts`

**Files:** Create `scanner/metrics/volatility.ts`, `tests/volatility.test.ts`

**Interfaces:** `weeklySigma(prices: (number | null)[]): number | null` — 取最後 168 個小時價格，null 跳過，算對數報酬標準差 × √(24×7)；有效小時 < 120（5 天）回 null。`rvolRange(sigma: number | null): { R: number; fallback: boolean }` — R = clamp(2σ, 0.05, 0.40)，sigma null → { R: 0.25, fallback: true }。

- [ ] **Step 1: 失敗測試**

```ts
// tests/volatility.test.ts
import { it, expect } from 'vitest'
import { weeklySigma, rvolRange } from '../scanner/metrics/volatility.js'
it('價格不動 σ = 0；不足 5 天回 null', () => {
  expect(weeklySigma(Array(168).fill(10))).toBe(0)
  expect(weeklySigma(Array(100).fill(10))).toBeNull()
})
it('每小時 ±1% 交替 → 週波動率 ≈ 0.01 × √168', () => {
  const p: number[] = [100]; for (let i = 1; i < 168; i++) p.push(p[i - 1] * (i % 2 ? 1.01 : 1 / 1.01))
  expect(weeklySigma(p)).toBeCloseTo(Math.log(1.01) * Math.sqrt(168), 2)
})
it('rvolRange 夾在 [0.05, 0.40]，null 退回 0.25', () => {
  expect(rvolRange(0.01)).toEqual({ R: 0.05, fallback: false })
  expect(rvolRange(0.10)).toEqual({ R: 0.20, fallback: false })
  expect(rvolRange(0.50)).toEqual({ R: 0.40, fallback: false })
  expect(rvolRange(null)).toEqual({ R: 0.25, fallback: true })
})
```

- [ ] **Step 2: 跑** → FAIL。
- [ ] **Step 3: 實作**

```ts
// scanner/metrics/volatility.ts — §7.1 σ₇，純函式
export function weeklySigma(prices: (number | null)[]): number | null {
  const p = prices.slice(-168).filter((v): v is number => v !== null && v > 0)
  if (p.length < 120) return null
  const r: number[] = []; for (let i = 1; i < p.length; i++) r.push(Math.log(p[i] / p[i - 1]))
  const m = r.reduce((a, b) => a + b, 0) / r.length
  const sd = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / r.length)
  return sd * Math.sqrt(24 * 7)
}
export function rvolRange(sigma: number | null): { R: number; fallback: boolean } {
  if (sigma === null) return { R: 0.25, fallback: true }
  return { R: Math.min(0.40, Math.max(0.05, 2 * sigma)), fallback: false }
}
```

- [ ] **Step 4: 跑** → PASS。
- [ ] **Step 5: Commit** `git commit -m "feat: weekly volatility and rvol range"`

---

### Task 3: 模擬引擎 `metrics/simulate.ts`（§7.4 三個測試）

**Files:** Create `scanner/metrics/simulate.ts`, `tests/simulate.test.ts`

**Interfaces:**
- `SimHour = { ts: number; priceUsd: number; feesUsd: number; liquidity: string | null }`（呼叫端先過濾掉 price null 的開頭小時）
- `SimResult = { fees_usd, value_end_usd, il_usd, net_usd, net_pct, net_apr, in_range_hours, in_range_pct, exits, hours: number }`（`hours` 是額外欄位，方便 sim-check）
- `simulate(hours: SimHour[], D: number, R: number): SimResult`；`hours` 為空時所有數值 0。
- `simulateHourly(hours, D, R): { row: SimHour; inRange: boolean; share: number; feeH: number; valueH: number; cumFees: number }[]`（sim-check 用；`simulate` 內部呼叫它）
- `simulateAll(hours: SimHour[], sigma: number | null): { sim: SimJson; flags: string[] }`，`SimJson = Record<'d200'|'d1000'|'d5000', Record<'r10'|'r25'|'rvol', SimResult>>`，flags 可能含 `rvol_fallback`。
- 份額：`L_raw = L × 1e12`；`share = L_raw / (L_pool + L_raw)`，`L_pool = Number(liquidity)`；`liquidity` null → share 0（記 `share_method: 'liquidity'` 於 SimJson 頂層 `meta`）。
- IL：`il_usd = value_end − (x0 × P_end + y0)`，x0/y0 為 P0 時的初始持有量（真正的 IL，負值 = 相對持有虧損）。
- `exits`：in_range 從 true 變 false 的次數。`net_apr = net_pct × 365 / (hours / 24)`。

- [ ] **Step 1: 失敗測試（§7.4 三條 + 邊界）**

```ts
// tests/simulate.test.ts
import { it, expect } from 'vitest'
import { simulate, simulateAll } from '../scanner/metrics/simulate.js'
import { liquidityForDeposit, L_HUMAN_TO_RAW } from '../scanner/metrics/lp-math.js'
const H = (prices: number[], feesEach = 10, liq: number | null = 1e18) => prices.map((p, i) => ({ ts: 3600 * i, priceUsd: p, feesUsd: feesEach, liquidity: liq === null ? null : String(liq) }))
it('§7.4-1 價格不動 → IL = 0，fees = 累積手續費 × 份額', () => {
  const hours = H(Array(48).fill(100), 10, 1e18)
  const r = simulate(hours, 1000, 0.25)
  const L = liquidityForDeposit(1000, 100, 75, 125); const share = L * L_HUMAN_TO_RAW / (1e18 + L * L_HUMAN_TO_RAW)
  expect(r.il_usd).toBeCloseTo(0, 6)
  expect(r.fees_usd).toBeCloseTo(48 * 10 * share, 6)
  expect(r.in_range_pct).toBe(1); expect(r.exits).toBe(0); expect(r.hours).toBe(48)
  expect(r.net_apr).toBeCloseTo(r.net_pct * 365 / 2, 9)
})
it('§7.4-2 單邊漲 30%、R = 10% → 期末 100% USDG，突破後 in_range = 0', () => {
  const prices = Array.from({ length: 24 }, (_, i) => 100 * (1 + 0.30 * i / 23))   // 100 → 130
  const r = simulate(H(prices), 1000, 0.10)
  const L = liquidityForDeposit(1000, 100, 90, 110)
  expect(r.value_end_usd).toBeCloseTo(L * (Math.sqrt(110) - Math.sqrt(90)), 6)   // 全部是 y
  expect(r.exits).toBe(1)
  const above = prices.filter(p => p > 110).length
  expect(r.in_range_hours).toBe(24 - above)
})
it('§7.4-3 對稱漲跌回到原點 → value_end ≈ D（誤差 < 1%）', () => {
  const prices = [100, 110, 120, 110, 100, 90, 80, 90, 100]
  const r = simulate(H(prices, 0), 1000, 0.25)
  expect(Math.abs(r.value_end_usd - 1000) / 1000).toBeLessThan(0.01)
  expect(r.il_usd).toBeCloseTo(0, 6)
})
it('空資料與 liquidity null', () => {
  expect(simulate([], 1000, 0.25).net_usd).toBe(0)
  expect(simulate(H([100, 100], 10, null), 1000, 0.25).fees_usd).toBe(0)
})
it('simulateAll 產生 9 組並在 sigma null 時標 rvol_fallback', () => {
  const { sim, flags } = simulateAll(H(Array(30).fill(100)), null)
  expect(Object.keys(sim.d1000)).toEqual(['r10', 'r25', 'rvol'])
  expect(sim.d1000.rvol).toEqual(sim.d1000.r25); expect(flags).toContain('rvol_fallback')
  expect(sim.d5000.r10.fees_usd).toBeGreaterThan(sim.d200.r10.fees_usd)
})
```

- [ ] **Step 2: 跑** → FAIL。
- [ ] **Step 3: 實作**

```ts
// scanner/metrics/simulate.ts — SPEC §7 模擬淨收益，純函式
import { liquidityForDeposit, positionAmounts, positionValue, L_HUMAN_TO_RAW } from './lp-math.js'
import { rvolRange } from './volatility.js'
export interface SimHour { ts: number; priceUsd: number; feesUsd: number; liquidity: string | null }
export interface SimResult { fees_usd: number; value_end_usd: number; il_usd: number; net_usd: number; net_pct: number; net_apr: number; in_range_hours: number; in_range_pct: number; exits: number; hours: number }
export interface SimHourRow { row: SimHour; inRange: boolean; share: number; feeH: number; valueH: number; cumFees: number }
export const DEPOSITS = [200, 1000, 5000] as const
export type SimJson = { meta: { share_method: 'liquidity'; hours: number; sigma7: number | null; rvol_R: number }; d200: RangeSet; d1000: RangeSet; d5000: RangeSet }
export type RangeSet = { r10: SimResult; r25: SimResult; rvol: SimResult }

export function simulateHourly(hours: SimHour[], D: number, R: number): SimHourRow[] {
  if (!hours.length) return []
  const P0 = hours[0].priceUsd, Pl = P0 * (1 - R), Pu = P0 * (1 + R)
  const L = liquidityForDeposit(D, P0, Pl, Pu); const Lraw = L * L_HUMAN_TO_RAW
  let cum = 0
  return hours.map(row => {
    const inRange = row.priceUsd >= Pl && row.priceUsd <= Pu
    const Lpool = row.liquidity === null ? null : Number(row.liquidity)
    const share = inRange && Lpool !== null ? Lraw / (Lpool + Lraw) : 0   // DECISIONS D1
    const feeH = share * row.feesUsd; cum += feeH
    return { row, inRange, share, feeH, valueH: positionValue(L, row.priceUsd, Pl, Pu), cumFees: cum }
  })
}
const zero = (): SimResult => ({ fees_usd: 0, value_end_usd: 0, il_usd: 0, net_usd: 0, net_pct: 0, net_apr: 0, in_range_hours: 0, in_range_pct: 0, exits: 0, hours: 0 })
export function simulate(hours: SimHour[], D: number, R: number): SimResult {
  const rows = simulateHourly(hours, D, R); if (!rows.length) return zero()
  const P0 = hours[0].priceUsd, Pl = P0 * (1 - R), Pu = P0 * (1 + R)
  const L = liquidityForDeposit(D, P0, Pl, Pu); const { x: x0, y: y0 } = positionAmounts(L, P0, Pl, Pu)
  const last = rows[rows.length - 1]; const Pend = last.row.priceUsd
  let exits = 0; for (let i = 1; i < rows.length; i++) if (rows[i - 1].inRange && !rows[i].inRange) exits++
  const inRangeHours = rows.filter(r => r.inRange).length
  const fees = last.cumFees, valueEnd = last.valueH
  const net = fees + valueEnd - D, netPct = net / D
  return { fees_usd: fees, value_end_usd: valueEnd, il_usd: valueEnd - (x0 * Pend + y0), net_usd: net, net_pct: netPct,
    net_apr: netPct * 365 / (rows.length / 24), in_range_hours: inRangeHours, in_range_pct: inRangeHours / rows.length, exits, hours: rows.length }
}
export function simulateAll(hours: SimHour[], sigma: number | null): { sim: SimJson; flags: string[] } {
  const { R: rvolR, fallback } = rvolRange(sigma)
  const set = (D: number): RangeSet => ({ r10: simulate(hours, D, 0.10), r25: simulate(hours, D, 0.25), rvol: simulate(hours, D, rvolR) })
  return { sim: { meta: { share_method: 'liquidity', hours: hours.length, sigma7: sigma, rvol_R: rvolR }, d200: set(200), d1000: set(1000), d5000: set(5000) }, flags: fallback ? ['rvol_fallback'] : [] }
}
```

- [ ] **Step 4: 跑** → PASS（§7.4-2 的 `value_end` 斷言若因浮點差一點，容差用 `toBeCloseTo(…, 4)`）。
- [ ] **Step 5: Commit** `git commit -m "feat: §7 simulation engine with §7.4 tests"`

---

### Task 4: 評分 `metrics/score.ts`

**Files:** Create `scanner/metrics/score.ts`, `tests/score.test.ts`

**Interfaces:**
- `getSimField(sim: SimJson | null, sortKey: string, field: keyof SimResult): number | null` — `sortKey` 形如 `d1000.r25`。
- `ScoreInput = { poolId: string; sim: SimJson | null; vol7Cv: number; traderCount: number | null; priceDevPct: number | null; allDayTradable: boolean }`
- `scorePools(rows: ScoreInput[], scoring: Scoring): Map<string, number>` — 依 §8.3；`rank_norm` = 該池 net_apr 在 rows 內的百分位（rank / (n−1)，n = 1 時 1）；sim null 的池 score = null（不放進 Map）；traderCount null 視為 0；priceDevPct null 視為 0.05（沒有參考價 = 最差）。

- [ ] **Step 1: 失敗測試**

```ts
// tests/score.test.ts
import { it, expect } from 'vitest'
import { scorePools, getSimField } from '../scanner/metrics/score.js'
import { loadScoring } from '../config/chain.js'
const mk = (apr: number, inr: number) => ({ meta: { share_method: 'liquidity', hours: 24, sigma7: null, rvol_R: 0.25 },
  d200: null as any, d5000: null as any, d1000: { r10: null as any, rvol: null as any, r25: { fees_usd: 0, value_end_usd: 0, il_usd: 0, net_usd: 0, net_pct: 0, net_apr: apr, in_range_hours: 0, in_range_pct: inr, exits: 0, hours: 24 } } })
it('getSimField 依 sort_key 取值', () => { expect(getSimField(mk(1.5, 0.9) as any, 'd1000.r25', 'net_apr')).toBe(1.5); expect(getSimField(null, 'd1000.r25', 'net_apr')).toBeNull() })
it('分數落在 [0,1]，各項符合權重', () => {
  const s = loadScoring()
  const rows = [
    { poolId: 'a', sim: mk(2.0, 1.0) as any, vol7Cv: 0, traderCount: 50, priceDevPct: 0, allDayTradable: true },
    { poolId: 'b', sim: mk(1.0, 0.5) as any, vol7Cv: 2, traderCount: 0, priceDevPct: 0.05, allDayTradable: false },
    { poolId: 'c', sim: null, vol7Cv: 0, traderCount: 0, priceDevPct: 0, allDayTradable: false },
  ]
  const m = scorePools(rows, s)
  expect(m.get('a')).toBeCloseTo(1, 9)                      // 全部滿分
  expect(m.get('b')).toBeCloseTo(0.20 * 0.5, 9)             // 只有 in_range 0.5 得分
  expect(m.has('c')).toBe(false)
})
```

- [ ] **Step 2: 跑** → FAIL。
- [ ] **Step 3: 實作**

```ts
// scanner/metrics/score.ts — SPEC §8.3，權重來自 config/scoring.json
import type { Scoring } from '../../config/chain.js'
import type { SimJson, SimResult } from './simulate.js'
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
export function getSimField(sim: SimJson | null, sortKey: string, field: keyof SimResult): number | null {
  if (!sim) return null
  const [d, r] = sortKey.split('.') as [keyof SimJson, string]
  const set = sim[d] as any; const res: SimResult | undefined = set?.[r]
  return res ? res[field] : null
}
export interface ScoreInput { poolId: string; sim: SimJson | null; vol7Cv: number; traderCount: number | null; priceDevPct: number | null; allDayTradable: boolean }
export function scorePools(rows: ScoreInput[], s: Scoring): Map<string, number> {
  const withSim = rows.filter(r => getSimField(r.sim, s.sort_key, 'net_apr') !== null)
  const sorted = [...withSim].sort((a, b) => getSimField(a.sim, s.sort_key, 'net_apr')! - getSimField(b.sim, s.sort_key, 'net_apr')!)
  const n = sorted.length; const rank = new Map(sorted.map((r, i) => [r.poolId, n > 1 ? i / (n - 1) : 1]))
  const w = s.weights; const out = new Map<string, number>()
  for (const r of withSim) {
    const inRange = getSimField(r.sim, s.sort_key, 'in_range_pct') ?? 0
    const dev = r.priceDevPct === null ? 0.05 : Math.abs(r.priceDevPct)
    out.set(r.poolId,
      w.net_apr * rank.get(r.poolId)! +
      w.in_range_pct * inRange +
      w.vol7_cv * (1 - clamp(r.vol7Cv, 0, 2) / 2) +
      w.trader_count * clamp((r.traderCount ?? 0) / 50, 0, 1) +
      w.price_dev * (1 - clamp(dev, 0, 0.05) / 0.05) +
      w.all_day_tradable * (r.allDayTradable ? 1 : 0))
  }
  return out
}
```

- [ ] **Step 4: 跑** → PASS。
- [ ] **Step 5: Commit** `git commit -m "feat: §8.3 scoring"`

---

### Task 5: DB 步驟與 scanner 整合、§13 摘要

**Files:** Modify `scanner/steps.ts`, `scanner/run.ts`, `scanner/notify/summary.ts`, `tests/steps.test.ts`, `tests/summary.test.ts`

**Interfaces:**
- `loadHourly(db, poolId, maxHours = 720): SimHour[]` — 取最近 720 列（30 天）按 ts 升冪，丟掉開頭 price null 的列，之後 price null 的列以前值填補（`aggregateHourly` 已做前值填補，這裡只是保險）。
- `updateSim(db, poolId, date, sim: SimJson, score: number | null, flags: string[]): void` — 更新 `pool_snapshots.sim / score / flags`。
- `SummaryInput.top[]` 改為 `{ label; feePct; netApr: number | null; inRangePct: number | null; traderCount: number | null }`；標題行改為 `Top 5 (投入 $1000, ±25%)`（依 sort_key 動態產生：`d1000` → `$1000`，`r25` → `±25%`，`rvol` → `vol`）。
- run.ts 新階段（在快照迴圈之後、摘要之前）：對 `excluded = 0` 的池：`loadHourly` → `weeklySigma(prices)` → `simulateAll` → 收集 `ScoreInput` → `scorePools` → `updateSim`。摘要 Top 5 改依 `score` 降冪。

- [ ] **Step 1: 失敗測試**

```ts
// 追加到 tests/steps.test.ts
import { loadHourly, updateSim, writeHourly } from '../scanner/steps.js'
it('loadHourly 丟掉開頭 null 價並升冪；updateSim 回寫', () => {
  const db = openDb(':memory:'); db.prepare(`INSERT INTO pools(pool_id,protocol) VALUES ('0x1','v4')`).run()
  writeHourly(db, '0x1', [{ ts: 3600, priceUsd: null, volumeUsd: 0, feesUsd: 0, liquidity: null, swapCount: 0 }, { ts: 7200, priceUsd: 10, volumeUsd: 1, feesUsd: 0.1, liquidity: '5', swapCount: 1 }, { ts: 10800, priceUsd: 11, volumeUsd: 0, feesUsd: 0, liquidity: '5', swapCount: 0 }])
  expect(loadHourly(db, '0x1')).toEqual([{ ts: 7200, priceUsd: 10, feesUsd: 0.1, liquidity: '5' }, { ts: 10800, priceUsd: 11, feesUsd: 0, liquidity: '5' }])
  writeSnapshot(db, snap('0x1', '2026-09-03', []))
  updateSim(db, '0x1', '2026-09-03', { meta: {} } as any, 0.5, ['rvol_fallback'])
  expect(db.prepare('SELECT score, flags, sim FROM pool_snapshots WHERE pool_id=? AND date=?').get('0x1', '2026-09-03')).toEqual({ score: 0.5, flags: '["rvol_fallback"]', sim: '{"meta":{}}' })
})
```

```ts
// tests/summary.test.ts 的第一個測試改為
it('格式符合 §13', () => {
  const s = formatDailySummary({ date: '2026-09-10', weekdayZh: '三', poolsScanned: 312, candidates: 14, sortKey: 'd1000.r25',
    top: [{ label: 'SOFI/USDG v4', feePct: '3.29%', netApr: 4.12, inRangePct: 0.91, traderCount: 34 }],
    changes: [{ label: 'IBM/USDG', kind: 'dropped', reason: 'corp_action_pending' }, { label: 'AAPL/USDG', kind: 'added' }], positions: [] })
  expect(s).toContain('📊 LP 掃描 2026-09-10 (三)')
  expect(s).toContain('掃描 312 池，候選 14')
  expect(s).toContain('Top 5 (投入 $1000, ±25%)')
  expect(s).toContain('1. SOFI/USDG v4 3.29%  net APR 412%  在區間 91%  交易者 34')
  expect(s).toContain('- IBM/USDG 掉出候選: corp_action_pending')
  expect(s).toContain('- AAPL/USDG 新進候選')
})
```

- [ ] **Step 2: 跑** → FAIL。
- [ ] **Step 3: 實作 steps.ts 追加**

```ts
import type { SimHour, SimJson } from './metrics/simulate.js'
export function loadHourly(db: Database.Database, poolId: string, maxHours = 720): SimHour[] {
  const rows = (db.prepare('SELECT ts, price_usd, fees_usd, liquidity FROM pool_hourly WHERE pool_id=? ORDER BY ts DESC LIMIT ?').all(poolId, maxHours) as any[]).reverse()
  const out: SimHour[] = []; let last: number | null = null
  for (const r of rows) {
    if (r.price_usd === null && last === null) continue
    if (r.price_usd !== null) last = r.price_usd
    out.push({ ts: r.ts, priceUsd: last!, feesUsd: r.fees_usd ?? 0, liquidity: r.liquidity ?? null })
  }
  return out
}
export function updateSim(db: Database.Database, poolId: string, date: string, sim: SimJson, score: number | null, flags: string[]) {
  db.prepare('UPDATE pool_snapshots SET sim=?, score=?, flags=? WHERE pool_id=? AND date=?').run(JSON.stringify(sim), score, JSON.stringify(flags), poolId, date)
}
```

- [ ] **Step 4: 實作 summary.ts 改動**

```ts
export interface SummaryInput {
  date: string; weekdayZh: string; poolsScanned: number; candidates: number; sortKey: string
  top: { label: string; feePct: string; netApr: number | null; inRangePct: number | null; traderCount: number | null }[]
  changes: { label: string; kind: 'dropped' | 'added'; reason?: string }[]
  positions: string[]
}
export function describeSortKey(k: string): string {
  const [d, r] = k.split('.'); const dep = '$' + d.replace('d', ''); const rng = r === 'rvol' ? 'vol' : '±' + r.replace('r', '') + '%'
  return `投入 ${dep}, ${rng}`
}
const pct = (v: number | null) => v === null ? '—' : Math.round(v * 100) + '%'
export function formatDailySummary(i: SummaryInput): string {
  const lines = [`📊 LP 掃描 ${i.date} (${i.weekdayZh})`, `掃描 ${i.poolsScanned} 池，候選 ${i.candidates}`, '', `Top 5 (${describeSortKey(i.sortKey)})`]
  i.top.slice(0, 5).forEach((t, n) => lines.push(`${n + 1}. ${t.label} ${t.feePct}  net APR ${pct(t.netApr)}  在區間 ${pct(t.inRangePct)}  交易者 ${t.traderCount ?? '—'}`))
  if (!i.top.length) lines.push('（今日無候選）')
  lines.push('', '⚠️ 異動')
  if (!i.changes.length) lines.push('- 無')
  for (const c of i.changes) lines.push(c.kind === 'dropped' ? `- ${c.label} 掉出候選: ${c.reason ?? ''}`.trimEnd() : `- ${c.label} 新進候選`)
  lines.push('', '💼 我的頭寸', ...(i.positions.length ? i.positions.map(p => `- ${p}`) : ['- 無']))
  return lines.join('\n')
}
```

- [ ] **Step 5: 實作 run.ts 新階段**（插在「// 5. 摘要」之前）

```ts
    // 5. 模擬與評分（SPEC §7 / §8.3）：只對未硬排除的池
    const candRows = db.prepare(`SELECT s.pool_id, s.flags, s.vol7_cv, s.trader_count, s.price_dev_pct, t.all_day_tradable FROM pool_snapshots s JOIN pools p ON p.pool_id=s.pool_id
      JOIN tokens t ON t.address = CASE WHEN p.stock_is_token0=1 THEN p.token0 ELSE p.token1 END WHERE s.date=? AND s.excluded=0`).all(date) as any[]
    const simById = new Map<string, { sim: SimJson; flags: string[] }>()
    for (const r of candRows) {
      const hours = loadHourly(db, r.pool_id)
      const { sim, flags } = simulateAll(hours, weeklySigma(hours.map(h => h.priceUsd)))
      simById.set(r.pool_id, { sim, flags: [...JSON.parse(r.flags), ...flags] })
    }
    const scores = scorePools(candRows.map(r => ({ poolId: r.pool_id, sim: simById.get(r.pool_id)!.sim, vol7Cv: r.vol7_cv ?? 0, traderCount: r.trader_count, priceDevPct: r.price_dev_pct, allDayTradable: r.all_day_tradable === 'tradable' })), scoring)
    for (const [id, v] of simById) updateSim(db, id, date, v.sim, scores.get(id) ?? null, v.flags)
    log(`simulated ${simById.size} candidate pools`)
```

摘要段改為：`cands` 依 `score` 降冪（`SELECT … ORDER BY score DESC`），`top` 每列 `netApr: getSimField(JSON.parse(r.sim), scoring.sort_key, 'net_apr')`、`inRangePct: getSimField(…, 'in_range_pct')`，並傳 `sortKey: scoring.sort_key`。import `simulateAll`、`weeklySigma`、`scorePools`、`getSimField`、`loadHourly`、`updateSim`、`type SimJson`。

- [ ] **Step 6: 跑全部** `pnpm test && pnpm typecheck` → PASS。
- [ ] **Step 7: Commit** `git commit -m "feat: simulation + scoring integrated into daily scan; §13 summary"`

---

### Task 6: `scripts/sim-check.ts`

**Files:** Create `scripts/sim-check.ts`；README 加用法。

**Interfaces:** `pnpm sim-check <poolId> [D=1000] [R=0.25] [fromDate] [toDate]`（日期 YYYY-MM-DD，UTC；省略 = 最近 30 天）。印：池資訊、P0/Pl/Pu/L、逐小時表（時間、價格、在區間、池 L、份額、當小時費、累積費、頭寸市值），最後印 §7.3 結果 JSON。

- [ ] **Step 1: 實作**

```ts
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
const pool = db.prepare(`SELECT p.*, t.symbol FROM pools p JOIN tokens t ON t.address = CASE WHEN p.stock_is_token0=1 THEN p.token0 ELSE p.token1 END WHERE p.pool_id=?`).get(poolId) as any
if (!pool) { console.log('找不到池'); process.exit(1) }
let hours = loadHourly(db, poolId, 24 * 45)
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
  console.log(`${t} | ${r.row.priceUsd.toFixed(4).padStart(8)} | ${r.inRange ? ' ✓' : ' ✗'} | ${(r.row.liquidity ?? '-').slice(0, 11).padStart(11)} | ${r.share.toExponential(2)} | ${r.feeH.toFixed(3).padStart(7)} | ${r.cumFees.toFixed(2).padStart(7)} | ${r.valueH.toFixed(2)}`)
}
console.log('\n結果 (§7.3):', JSON.stringify(simulate(hours, D, R), null, 1))
db.close()
```

- [ ] **Step 2: package.json 加** `"sim-check": "tsx scripts/sim-check.ts"`；README「測試」段後加：

```markdown
## 人工核對模擬（P2 驗收）
pnpm sim-check 0xb6a881c32ed115cb8790c182580c71607ee7b7b008b4e1c3c65b1bc29b891b53 1000 0.25
```

- [ ] **Step 3: 實跑** `pnpm sim-check 0xb6a881…1b53 1000 0.25`，確認印出表格與結果。
- [ ] **Step 4: Commit** `git commit -m "feat: sim-check script"`

---

### Task 7: DECISIONS.md 補記與合併

- [ ] D18：份額用 Swap 事件 `liquidity`（raw）與 `L × 1e12` 換算；D19：IL 定義為相對「初始持有量不動」的差額；D20：`rank_norm` 為 (rank)/(n−1) 百分位；D21：無參考價的池 `price_dev` 項給 0 分；D22：模擬只對未硬排除的池跑（省時間，排除池的 `sim` 為 NULL，dashboard 顯示「未模擬」）。
- [ ] 記錄首次帶模擬的 scan 耗時。
- [ ] Commit、合併到 main（使用者已授權「你合併」的模式沿用）。

---

## Self-Review

- §7.1 參數 ✓ Task 3；σ₇ 來源：§7.1 說股票代幣優先用 Robinhood 歷史，DECISIONS 11.3 已定為累積前用池價 → Task 5 用 `pool_hourly` 價格，`flags` 未加 `sigma_from_pool`（補：Task 5 的 flags 加上 `'sigma_from_pool'`）。
- §7.2 公式 ✓ Task 1/3；`share_h` 用 D1 方法（優於 D/(tvl+D)）。
- §7.3 欄位 ✓；§7.4 三測試 ✓ Task 3；`sim-check.ts` ✓ Task 6。
- §8.2/8.3/8.4 ✓ Task 4，`sort_key` 任意 (D,R) ✓ `getSimField`。
- §13 格式 ✓ Task 5。
- 型別：`SimHour`/`SimJson`/`SimResult` 在 Task 3 定義，Task 4/5/6 一致；`loadHourly` 回 `SimHour[]`。
