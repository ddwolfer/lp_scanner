import { describe, expect, it } from 'vitest'
import { switchHint, rate7, daysAboveRatio, formatSwitchHint, type PoolDay, type PoolSeries } from '../scanner/metrics/poolSwitch.js'
const cfg = { ratio: 1.5, days: 3, recover_days_max: 14, cold_usd_per_day: 1, cold_min_days: 5, gas_usd_per_tx: 0.2, lifecycle_txs: 4, capacity_share: 0.1 }
const days = (rates: (number | null)[], tvl = 1_000_000): PoolDay[] => rates.map((r, i) => ({ date: `2026-09-${String(18 + i).padStart(2, '0')}`, feesUsd: r === null ? 0 : r * tvl, tvlUsd: tvl, ok: r !== null }))
const series = (id: string, label: string, fee: number, d: PoolDay[]): PoolSeries => ({ poolId: id, label, swapFeeRate: fee, days: d })
const held = series('h', 'v4 1%', 0.01, days([0.0008, 0.0008, 0.0008, 0.0008, 0.0008, 0.0008, 0.0008]))

describe('poolSwitch', () => {
  it('rate7 以 TVL 加權，跳過失敗日', () => {
    expect(rate7(days([0.001, null, 0.003]))).toBeCloseTo(0.002)
    expect(rate7(days([null, null]))).toBeNull()
  })
  it('daysAboveRatio 只看兩邊都有效的最近 n 天', () => {
    const alt = days([0.0008, 0.002, null, 0.002, 0.002, 0.002, 0.0008])
    expect(daysAboveRatio(held.days, alt, 1.5, 3)).toBe(2)   // 最近 3 個共同日：09-22 ✓ 09-23 ✓ 09-24 ✗
  })
  it('替代池連續高於 1.5× 且成本 14 天內回本 → consider', () => {
    const alt = series('a', 'v3 0.05%', 0.0005, days([0.0023, 0.0023, 0.0023, 0.0023, 0.0023, 0.0023, 0.0023]))
    const h = switchHint({ held, alts: [alt], depositUsd: 2000, paceUsdPerDay: 5, heldDays: 10, inRange: true, asOf: '2026-09-24', cfg })
    expect(h.verdict).toBe('consider'); expect(h.best?.poolId).toBe('a'); expect(h.daysAbove).toBe(3)
    expect(h.extraPerDay).toBeCloseTo(2000 * 0.0015)                       // $3/日
    expect(h.switchCostUsd).toBeCloseTo(1000 * 0.011 + 1000 * 0.0015 + 0.8) // $13.30
    expect(h.recoverDays).toBeCloseTo(13.3 / 3, 1)
    expect(formatSwitchHint(h)).toContain('考慮換')
  })
  it('替代池只高一點（< 1.5×）→ stay', () => {
    const alt = series('a', 'v3 0.3%', 0.003, days([0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001]))
    const h = switchHint({ held, alts: [alt], depositUsd: 2000, paceUsdPerDay: 5, heldDays: 10, inRange: true, asOf: '2026-09-24', cfg })
    expect(h.verdict).toBe('stay'); expect(h.daysAbove).toBe(0); expect(formatSwitchHint(h)).toMatch(/→ 留$/)
  })
  it('高很多但投入太小、成本回不來 → stay', () => {
    const alt = series('a', 'v3 1%', 0.01, days([0.0012, 0.0012, 0.0012, 0.0012, 0.0012, 0.0012, 0.0012]))
    const h = switchHint({ held, alts: [alt], depositUsd: 100, paceUsdPerDay: 5, heldDays: 10, inRange: true, asOf: '2026-09-24', cfg })   // 多賺 $0.04/日，成本 $1.9 → 47 天
    expect(h.verdict).toBe('stay'); expect(h.recoverDays).toBeGreaterThan(14)
  })
  it('替代池只有最近一天暴衝 → 未達連續天數 → stay', () => {
    const alt = series('a', 'v4 0.25%', 0.0025, days([0.0008, 0.0008, 0.0008, 0.0008, 0.0008, 0.0008, 0.02]))
    expect(switchHint({ held, alts: [alt], depositUsd: 2000, paceUsdPerDay: 5, heldDays: 10, inRange: true, asOf: '2026-09-24', cfg }).verdict).toBe('stay')
  })
  it('替代池熱時不判冷；沒有更好的池、持有 ≥5 天、在區間內、費速 < $1 才是 cold', () => {
    const dull = series('d', 'v3 0.3%', 0.003, days([0.0008, 0.0008, 0.0008, 0.0008, 0.0008, 0.0008, 0.0008]))
    expect(switchHint({ held, alts: [dull], depositUsd: 2000, paceUsdPerDay: 0.4, heldDays: 6, inRange: true, asOf: '2026-09-24', cfg }).verdict).toBe('cold')
    expect(switchHint({ held, alts: [dull], depositUsd: 2000, paceUsdPerDay: 0.4, heldDays: 6, inRange: false, asOf: '2026-09-24', cfg }).verdict).toBe('stay')   // 出區間費速本來就低
    const alt = series('a', 'v3 0.05%', 0.0005, days([0.005, 0.005, 0.005, 0.005, 0.005, 0.005, 0.005]))
    expect(switchHint({ held, alts: [alt], depositUsd: 2000, paceUsdPerDay: 0.4, heldDays: 6, inRange: true, asOf: '2026-09-24', cfg }).verdict).toBe('consider')   // 替代池熱、自己冷 = 該換，不是冷（Codex plan review）
    expect(switchHint({ held, alts: [alt], depositUsd: 2000, paceUsdPerDay: 0.4, heldDays: 2, inRange: true, asOf: '2026-09-24', cfg }).verdict).toBe('consider')   // 新頭寸不判冷
  })
  it('自己的池有效日不足 3 天 → no_data', () => {
    const h2 = series('h', 'v3 0.05%', 0.0005, days([null, null, null, null, null, 0.002, 0.002]))
    const h = switchHint({ held: h2, alts: [held], depositUsd: 2000, paceUsdPerDay: 5, heldDays: 1, inRange: true, asOf: '2026-09-24', cfg })
    expect(h.verdict).toBe('no_data'); expect(formatSwitchHint(h)).toContain('資料不足 2 天')
  })
  it('沒有替代池 → stay 並說明', () => {
    const h = switchHint({ held, alts: [], depositUsd: 2000, paceUsdPerDay: 5, heldDays: 10, inRange: true, asOf: '2026-09-24', cfg })
    expect(h.verdict).toBe('stay'); expect(formatSwitchHint(h)).toContain('無可比替代池')
  })
  it('替代池太小（TVL < 投入 ÷ capacity_share）或有效日不足 → 不列入比較', () => {
    const tiny = series('t', 'v4 0.20%', 0.002, days([0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01], 15000))          // $1.5 萬 TVL 裝不下 $2,000
    const young = series('y', 'v4 0.80%', 0.008, days([null, null, null, null, null, 0.01, 0.01]))               // 只有 2 個有效日
    const h = switchHint({ held, alts: [tiny, young], depositUsd: 2000, paceUsdPerDay: 5, heldDays: 10, inRange: true, asOf: '2026-09-24', cfg })
    expect(h.verdict).toBe('no_data'); expect(h.best).toBeNull(); expect(h.altsPending).toBe(1)   // young 裝得下但資料不足 → 待累積；tiny 直接不算
    expect(switchHint({ held, alts: [tiny], depositUsd: 1000, paceUsdPerDay: 5, heldDays: 10, inRange: true, asOf: '2026-09-24', cfg }).best?.poolId).toBe('t')   // $1,000 就裝得下
  })
  it('held/alt 只比共同有效日，且替代池資料要夠新', () => {
    // alt 只有前 3 天資料（最近 4 天沒抓）→ 共同日過時 → 不比
    const stale = series('s', 'v3 0.05%', 0.0005, days([0.003, 0.003, 0.003, null, null, null, null]))
    const st = switchHint({ held, alts: [stale], depositUsd: 2000, paceUsdPerDay: 5, heldDays: 10, inRange: true, asOf: '2026-09-24', cfg })
    expect(st.best).toBeNull(); expect(st.verdict).toBe('no_data'); expect(st.altsPending).toBe(1); expect(formatSwitchHint(st)).toContain('替代池資料不足')
    // held 在 alt 缺資料的日子暴賺：只比共同日，所以 held 費率不被那天拉高
    const spikyHeld = series('h', 'v4 1%', 0.01, days([0.0008, 0.0008, 0.0008, 0.05, 0.0008, 0.0008, 0.0008]))
    const alt = series('a', 'v3 0.05%', 0.0005, days([0.0023, 0.0023, 0.0023, null, 0.0023, 0.0023, 0.0023]))
    const h = switchHint({ held: spikyHeld, alts: [alt], depositUsd: 2000, paceUsdPerDay: 5, heldDays: 10, inRange: true, asOf: '2026-09-24', cfg })
    expect(h.heldRate7).toBeCloseTo(0.0008); expect(h.verdict).toBe('consider')
  })
  it('自己的池零收益時仍能正確排序替代池；資料不足時 no_data 優先於 cold', () => {
    const dead = series('h', 'v4 1%', 0.01, days([0, 0, 0, 0, 0, 0, 0]))
    const weak = series('w', 'v4 0.10%', 0.001, days([0.0001, 0.0001, 0.0001, 0.0001, 0.0001, 0.0001, 0.0001]))
    const strong = series('s', 'v3 0.05%', 0.0005, days([0.003, 0.003, 0.003, 0.003, 0.003, 0.003, 0.003]))
    const h = switchHint({ held: dead, alts: [weak, strong], depositUsd: 2000, paceUsdPerDay: 0, heldDays: 10, inRange: true, asOf: '2026-09-24', cfg })
    expect(h.best?.poolId).toBe('s'); expect(h.verdict).toBe('consider')
    const sparse = series('h', 'v4 1%', 0.01, days([null, null, null, null, null, 0, 0]))
    expect(switchHint({ held: sparse, alts: [strong], depositUsd: 2000, paceUsdPerDay: 0, heldDays: 10, inRange: true, asOf: '2026-09-24', cfg }).verdict).toBe('no_data')
  })
  it('新鮮度以最新快照日為準：兩邊最近 4 天都抓失敗，舊的共同日不能拿來判斷', () => {
    const h4 = series('h', 'v4 1%', 0.01, days([0.0008, 0.0008, 0.0008, null, null, null, null]))
    const a4 = series('a', 'v3 0.05%', 0.0005, days([0.003, 0.003, 0.003, null, null, null, null]))
    const r = switchHint({ held: h4, alts: [a4], depositUsd: 2000, paceUsdPerDay: 5, heldDays: 10, inRange: true, asOf: '2026-09-24', cfg })
    expect(r.verdict).toBe('no_data')   // 自己的最後有效日就離快照日 4 天，直接 no_data
  })
  it('有可比的替代池但另一個裝得下的池還沒資料：不下 cold 結論', () => {
    const dull = series('d', 'v3 0.3%', 0.003, days([0.0008, 0.0008, 0.0008, 0.0008, 0.0008, 0.0008, 0.0008]))
    const pending = series('p', 'v3 0.05%', 0.0005, days([null, null, null, null, null, null, 0.003]))
    const r = switchHint({ held, alts: [dull, pending], depositUsd: 2000, paceUsdPerDay: 0.4, heldDays: 6, inRange: true, asOf: '2026-09-24', cfg })
    expect(r.verdict).toBe('no_data'); expect(r.altsPending).toBe(1); expect(r.best?.poolId).toBe('d')
    expect(switchHint({ held, alts: [dull, pending], depositUsd: 2000, paceUsdPerDay: 5, heldDays: 6, inRange: true, asOf: '2026-09-24', cfg }).verdict).toBe('stay')
  })
  it('替代池最近兩天明顯更好但未達 3 天確認：stay，不是 cold', () => {
    const rising = series('r', 'v3 0.05%', 0.0005, days([0.0008, 0.0008, 0.0008, 0.0008, 0.0008, 0.003, 0.003]))
    const r = switchHint({ held, alts: [rising], depositUsd: 2000, paceUsdPerDay: 0.4, heldDays: 6, inRange: true, asOf: '2026-09-24', cfg })
    expect(r.verdict).toBe('stay'); expect(r.daysAbove).toBe(2)
  })
  it('自己和所有替代池都零收益、持有 ≥5 天在區間內 → cold', () => {
    const dead = series('h', 'v4 1%', 0.01, days([0, 0, 0, 0, 0, 0, 0]))
    const deadAlt = series('a', 'v3 0.3%', 0.003, days([0, 0, 0, 0, 0, 0, 0]))
    expect(switchHint({ held: dead, alts: [deadAlt], depositUsd: 2000, paceUsdPerDay: 0, heldDays: 6, inRange: true, asOf: '2026-09-24', cfg }).verdict).toBe('cold')
  })
  it('自己的池最近 4 天都抓失敗、又沒有替代池 → no_data，不下 stay/cold', () => {
    const h4 = series('h', 'v4 1%', 0.01, days([0.0008, 0.0008, 0.0008, null, null, null, null]))
    expect(switchHint({ held: h4, alts: [], depositUsd: 2000, paceUsdPerDay: 0.4, heldDays: 6, inRange: true, asOf: '2026-09-24', cfg }).verdict).toBe('no_data')
  })
  it('費率最高的池只是單日暴衝時，推穩定達標的另一個池', () => {
    const spike = series('s', 'v4 0.25%', 0.0025, days([0.0008, 0.0008, 0.0008, 0.0008, 0.0008, 0.0008, 0.03]))
    const steady = series('t', 'v3 0.05%', 0.0005, days([0.0023, 0.0023, 0.0023, 0.0023, 0.0023, 0.0023, 0.0023]))
    const r = switchHint({ held, alts: [spike, steady], depositUsd: 2000, paceUsdPerDay: 5, heldDays: 10, inRange: true, asOf: '2026-09-24', cfg })
    expect(r.verdict).toBe('consider'); expect(r.best?.poolId).toBe('t')
  })
  it('cold 要所有可比池都不明顯更好：另一個池在自己的共同日明顯更好但未確認 → stay', () => {
    const lowHeld = series('h', 'v4 1%', 0.01, days([0.0001, 0.0001, 0.0001, 0.0001, 0.0001, 0.0001, 0.0001]))
    const flat = series('f', 'v3 0.3%', 0.003, days([0.00012, 0.00012, 0.00012, 0.00012, 0.00012, 0.00012, 0.00012]))   // 多賺最多但沒到 1.5×
    const better = series('b', 'v3 0.05%', 0.0005, days([null, null, null, null, 0.0004, 0.0004, 0.00005]))            // 共同 3 天，2 天 ≥ 1.5×
    const r = switchHint({ held: lowHeld, alts: [flat, better], depositUsd: 2000, paceUsdPerDay: 0.2, heldDays: 6, inRange: true, asOf: '2026-09-24', cfg })
    expect(r.verdict).toBe('stay')
    expect(switchHint({ held: lowHeld, alts: [flat], depositUsd: 2000, paceUsdPerDay: 0.2, heldDays: 6, inRange: true, asOf: '2026-09-24', cfg }).verdict).toBe('cold')
  })
})
