import { describe, expect, it } from 'vitest'
import { switchHint, compareAlt, stabilityReasons, formatSwitchHint, type AltPool, type DailyReplay } from '../scanner/metrics/poolSwitch.js'
const cfg = { ratio: 1.3, days: 3, min_extra_usd: 0.5, min_age_days: 14, tvl_multiple: 20, tvl_stability: 0.5, cold_usd_per_day: 1, cold_min_days: 5 }
const D = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25']
const daily = (xs: (number | null)[]): DailyReplay => new Map(xs.flatMap((x, i) => x === null ? [] : [[D[i], x] as [string, number]]))
const alt = (id: string, xs: (number | null)[], o: Partial<AltPool> = {}): AltPool => ({ poolId: id, label: id, hookKind: 'none', ageDays: 60, tvlNow: 1_000_000, tvlMin7: 800_000, tvlMax7: 1_000_000, daily: daily(xs), ...o })
const held = daily([2, 2, 2, 2, 2])
const base = { held, depositUsd: 2000, weekdayPace: 2, tradingDaysHeld: 10, inRange: true, cfg }

describe('poolSwitch D67', () => {
  it('穩定的替代池在你的區間重放每天多賺且連續 → consider', () => {
    const h = switchHint({ ...base, alts: [alt('a', [3, 3, 3, 3, 3])] })
    expect(h.verdict).toBe('consider'); expect(h.best).toMatchObject({ poolId: 'a', extraPerDay: 1, daysAbove: 5, commonDays: 5 })
    expect(formatSwitchHint(h)).toBe('⚖️ 考慮換 → a（你的區間重放多 $1.00/日）')
  })
  it('裝不下的小池（TVL < 投入 × 20）完全不列入比較，不會顯示觀察', () => {
    const tiny = alt('tiny', [11, 11, 11, 11, 11], { tvlNow: 11_000, tvlMin7: 10_000, tvlMax7: 12_000 })
    const h = switchHint({ ...base, alts: [tiny] })
    expect(h.verdict).toBe('stay'); expect(h.best).toBeNull(); expect(formatSwitchHint(h)).toBe('⚖️ 留')
  })
  it('裝不裝得下看 7 天內最低 TVL，當天剛變大不算', () => {
    const jumped = alt('j', [5, 5, 5, 5, 5], { tvlNow: 53_000, tvlMin7: 36_600, tvlMax7: 53_000 })   // 2000 × 20 = 40,000
    expect(switchHint({ ...base, alts: [jumped] }).verdict).toBe('stay')
  })
  it('hook / 新池 / TVL 不穩 → 只能 watch，並列出原因', () => {
    const a = alt('fables', [4, 4, 4, 4, 4], { hookKind: 'fee_only', ageDays: 11, tvlNow: 76_000, tvlMin7: 50_000, tvlMax7: 114_000 })   // 最低仍裝得下，但起伏超過一半
    expect(stabilityReasons(a, 2000, cfg)).toEqual(['hook', '新池', 'TVL不穩'])
    const h = switchHint({ ...base, alts: [a] })
    expect(h.verdict).toBe('watch'); expect(formatSwitchHint(h)).toBe('⚖️ 觀察 → fables⚠️hook·新池·TVL不穩（你的區間重放多 $2.00/日）')
  })
  it('穩定池優先於多賺更多但不穩的池', () => {
    const h = switchHint({ ...base, alts: [alt('wild', [9, 9, 9, 9, 9], { hookKind: 'fee_only' }), alt('calm', [3, 3, 3, 3, 3])] })
    expect(h.verdict).toBe('consider'); expect(h.best!.poolId).toBe('calm')
  })
  it('只比兩邊都有資料的交易日；共同日不足 → 待累積（pending）', () => {
    const r = compareAlt(daily([2, 2, 10, null, null]), alt('a', [null, 3, 3, 3, 3]), 2000, cfg)
    expect(r).toBeNull()   // 共同只有 09-22、09-23 兩天
    const h = switchHint({ ...base, held: daily([2, 2, 2, null, null]), alts: [alt('a', [null, null, 3, 3, 3])] })
    expect(h.altsPending).toBe(1); expect(h.verdict).toBe('stay')
  })
  it('只多一點（< ratio 或 < $0.5/日）→ 留', () => {
    expect(switchHint({ ...base, alts: [alt('a', [2.4, 2.4, 2.4, 2.4, 2.4])] }).verdict).toBe('stay')   // 1.2 倍
    expect(switchHint({ ...base, held: daily([0.5, 0.5, 0.5, 0.5, 0.5]), alts: [alt('a', [0.9, 0.9, 0.9, 0.9, 0.9])] }).verdict).toBe('stay')   // 1.8 倍但只多 $0.4
  })
  it('單日暴衝不夠：要至少 3 個交易日 ≥ 1.3 倍', () => {
    expect(switchHint({ ...base, alts: [alt('a', [2, 2, 2, 2, 20])] }).verdict).toBe('stay')
  })
  it('量已冷：在區間、≥5 個交易日、實收 < $1/日、沒有更好的池；有待累積的池時改待累積；出區間不判冷', () => {
    const quiet = { ...base, held: daily([0.3, 0.3, 0.3, 0.3, 0.3]), weekdayPace: 0.4 }
    expect(switchHint({ ...quiet, alts: [alt('a', [0.3, 0.3, 0.3, 0.3, 0.3])] }).verdict).toBe('cold')
    expect(switchHint({ ...quiet, alts: [alt('a', [0.3, 0.3, 0.3, 0.3, 0.3]), alt('b', [null, null, null, null, 1])] }).verdict).toBe('no_data')
    expect(switchHint({ ...quiet, inRange: false, alts: [] }).verdict).toBe('stay')
    expect(switchHint({ ...quiet, tradingDaysHeld: 3, alts: [] }).verdict).toBe('stay')
  })
  it('自己的池交易日資料 < 3 天 → 待累積', () => {
    const h = switchHint({ ...base, held: daily([2, 2, null, null, null]), alts: [alt('a', [9, 9, 9, 9, 9])] })
    expect(h.verdict).toBe('no_data'); expect(formatSwitchHint(h)).toBe('⚖️ 待累積')
  })
})

import { replayDaily, weekdayPace, isUsTradingUtcDay, snapshotToUtcDay } from '../scanner/metrics/poolSwitch.js'
describe('poolSwitch 組裝', () => {
  it('UTC 交易日與快照日對應', () => {
    expect(isUsTradingUtcDay('2026-09-26')).toBe(false)   // 週六
    expect(isUsTradingUtcDay('2026-09-28')).toBe(true)    // 週一
    expect(snapshotToUtcDay('2026-09-29')).toBe('2026-09-28')
  })
  it('replayDaily：只留有效交易日、資料完整但沒成交算 0、週末丟掉', () => {
    const t0 = Date.parse('2026-09-25T00:00:00Z') / 1000   // 週五
    const hours = [0, 1, 24, 25, 72].map(h => ({ ts: t0 + h * 3600, priceUsd: 100, feesUsd: 10, liquidity: String(10n ** 15n) }))   // 週五、週六、週一
    const valid = new Set(['2026-09-25', '2026-09-26', '2026-09-28', '2026-09-29'])
    const r = replayDaily(hours, 1000, 90, 110, valid)
    expect([...r.keys()].sort()).toEqual(['2026-09-25', '2026-09-28', '2026-09-29'])
    expect(r.get('2026-09-25')!).toBeGreaterThan(0); expect(r.get('2026-09-29')).toBe(0)
    expect(r.get('2026-09-25')! / 2).toBeCloseTo(r.get('2026-09-28')!, 6)   // 週五兩小時、週一一小時
  })
  it('weekdayPace：跳過週末快照（週日、週一快照日）與不連續的日子', () => {
    const snaps = [['09-25', 0], ['09-26', 2], ['09-27', 2.1], ['09-28', 2.2], ['09-29', 4.2], ['09-30', 6.2], ['10-01', 8.2]].map(([d, e]) => ({ date: '2026-' + d, earned: e as number }))
    const wp = weekdayPace(snaps); expect(wp.pace!).toBeCloseTo(2); expect(wp.days).toBe(4)   // 09-26(週五)、09-29(週一)、09-30、10-01；快照日 09-27、09-28 對應 UTC 週六、週日
    expect(weekdayPace(snaps.slice(0, 4)).pace).toBeNull()
  })
})
