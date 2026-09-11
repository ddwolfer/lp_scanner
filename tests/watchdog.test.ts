import { describe, it, expect } from 'vitest'
import { assess, type RunRow } from '../scanner/watchdog.js'
const now = new Date('2026-09-11T05:30:00Z'); const date = '2026-09-11'   // 台北 13:30
const run = (o: Partial<RunRow>): RunRow => ({ started_at: '2026-09-10T23:30:00Z', finished_at: '2026-09-11T01:30:00Z', ok: 1, degraded: 0, alert_sent: null, error: null, pools_scanned: 7600, ...o })
const base = { snapshotsToday: 7600, swapFailedToday: 10, swapPoolsToday: 1200 }
describe('watchdog assess', () => {
  it('成功且有產物 → 靜默', () => expect(assess({ ...base, runsToday: [run({})] }, now, date)).toBeNull())
  it('今天沒啟動 → 警報', () => expect(assess({ ...base, runsToday: [], snapshotsToday: 0 }, now, date)?.text).toMatch(/沒有任何掃描啟動/))
  it('還在跑不到 3 小時 → 靜默', () => expect(assess({ ...base, runsToday: [run({ started_at: '2026-09-11T04:00:00Z', finished_at: null, ok: null })] }, now, date)).toBeNull())
  it('跑超過 3 小時沒結束 → 卡住警報', () => expect(assess({ ...base, runsToday: [run({ started_at: '2026-09-11T01:00:00Z', finished_at: null, ok: null })] }, now, date)?.text).toMatch(/卡住/))
  it('失敗但已通知 → 不重複', () => expect(assess({ ...base, runsToday: [run({ ok: 0, alert_sent: 1, error: 'x' })] }, now, date)).toBeNull())
  it('失敗且沒通知到 → 補報', () => expect(assess({ ...base, runsToday: [run({ ok: 0, alert_sent: 0, error: 'RPC 429\nstack' })] }, now, date)?.text).toMatch(/RPC 429/))
  it('降級且沒通知到 → 補報', () => expect(assess({ ...base, runsToday: [run({ degraded: 1, alert_sent: 0 })], swapFailedToday: 961 }, now, date)?.text).toMatch(/961/))
  it('成功但沒有快照列 → 產物缺失', () => expect(assess({ ...base, runsToday: [run({})], snapshotsToday: 0 }, now, date)?.text).toMatch(/產物缺失/))
  it('以當天最後一次為準：先失敗後成功 → 靜默', () => expect(assess({ ...base, runsToday: [run({ ok: 0, alert_sent: 0, started_at: '2026-09-10T23:30:00Z' }), run({ started_at: '2026-09-11T02:00:00Z', finished_at: '2026-09-11T04:00:00Z' })] }, now, date)).toBeNull())
  it('DB 打不開 → 無法確認也要報', () => expect(assess({ ...base, runsToday: [], dbError: 'SQLITE_CANTOPEN' }, now, date)?.text).toMatch(/無法確認/))
})
