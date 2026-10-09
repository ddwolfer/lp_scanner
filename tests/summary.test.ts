import { it, expect, vi } from 'vitest'
import { formatDailySummary } from '../scanner/notify/summary.js'
import { sendTelegram } from '../scanner/notify/telegram.js'
it('格式符合 §13', () => {
  const s = formatDailySummary({ date: '2026-09-10', weekdayZh: '三', poolsScanned: 312, candidates: 14, sortKey: 'd1000.r25',
    top: [{ label: 'SOFI/USDG v4', feePct: '3.29%', netApr: 4.12, inRangePct: 0.91, traderCount: 34 }],
    changes: [{ label: 'IBM/USDG', kind: 'dropped', reason: 'corp_action_pending' }, { label: 'AAPL/USDG', kind: 'added' }], positions: ['SPY/USDG #1  實際 +$13.88 / 模擬 +$16.37 (6d)  在區間 ✓'], dashboardUrl: 'http://192.168.0.18:3000' })
  expect(s).toContain('📊 LP 掃描 2026-09-10 (三)')
  expect(s).toContain('掃描 312 池，候選 14')
  expect(s).toContain('Top 5 (投入 $1000, ±25%)')
  expect(s).toContain('1. SOFI/USDG v4 3.29%  net APR 412%  在區間 91%  交易者 34')
  expect(s).not.toContain('異動')
  expect(s).toContain('💼 我的頭寸\n- SPY/USDG #1')
  expect(s.trim().endsWith('📈 http://192.168.0.18:3000')).toBe(true)
  expect(formatDailySummary({ date: 'd', weekdayZh: '一', poolsScanned: 1, candidates: 0, sortKey: 'd1000.r25', top: [], changes: [], positions: [] })).not.toContain('我的頭寸')
})
it('沒有 token 時回 not_configured 且不打網路', async () => {
  const f = vi.fn(); expect(await sendTelegram('hi', {}, f)).toBe('not_configured'); expect(f).not.toHaveBeenCalled()
})
it('有 token 時 POST sendMessage', async () => {
  const f = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) })
  expect(await sendTelegram('hi', { token: 'T', chatId: 'C' }, f as any)).toBe('sent')
  expect(f.mock.calls[0][0]).toBe('https://api.telegram.org/botT/sendMessage')
})
it('有 topicId 時帶 message_thread_id', async () => {
  const f = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) })
  await sendTelegram('hi', { token: 'T', chatId: 'C', topicId: '42' }, f as any)
  expect(JSON.parse(f.mock.calls[0][1].body)).toMatchObject({ chat_id: 'C', message_thread_id: 42 })
})
import { formatPositions, shouldFetchSwaps, formatFeesTotal, formatApr } from '../scanner/run.js'
it('formatPositions 一行一個頭寸：標籤、天數、昨日費、換池結論；出區間才標', () => {
  const rows = [
    { symbol: 'SOFI', label: '#1', closed_at: null, est: { net_usd: 18.4, hours: 168, in_range: true } },
    { symbol: 'MSTR', label: 'MSTR #2b', closed_at: null, deposit_usd: 645.45, actual: { fees_cum_usd: 3.87, value_usd: 655.71, net_usd: 14.13, days: 1, in_range: false, fees_withdrawn_usd: 0, fees_reinvested_usd: 0 }, est: null,
      feesLastDay: { usd: 2.59, hours: 24, from: 'a', to: 'b' }, switchHint: { verdict: 'watch', heldDays: 5, altsPending: 0, best: { poolId: 'x', label: 'v4 動態', heldPerDay: 2, altPerDay: 3.2, extraPerDay: 1.2, daysAbove: 3, commonDays: 5, reasons: ['hook', '新池'] } } },
    { symbol: 'IBM', label: '#2', closed_at: '2026-09-01', est: { net_usd: -1, hours: 24, in_range: false } },
    { symbol: 'AMD', label: '#3', closed_at: null, est: null },
    { symbol: 'TSLA', label: 'TSLA #1233', closed_at: null, deposit_usd: 1056.92, actual: { fees_cum_usd: 24.04, value_usd: 1067.09, net_usd: 33.84, days: 16, in_range: true, fees_withdrawn_usd: 0, fees_reinvested_usd: 0 }, est: null,
      feesLastDay: { usd: 3.2, hours: 31, from: 'a', to: 'b' }, switchHint: { verdict: 'stay' } },
    { symbol: 'GOOGL', label: 'GOOGL #7005', closed_at: null, deposit_usd: 2106.92, actual: { fees_cum_usd: 1.8, value_usd: 2114, net_usd: 9.28, days: 3, in_range: true, fees_withdrawn_usd: 0, fees_reinvested_usd: 0 }, est: null,
      feesLastDay: { usd: 1.26, hours: 24, from: 'a', to: 'b' }, switchHint: { verdict: 'no_data' } },
  ] as any
  expect(formatPositions(rows)).toEqual([
    'SOFI #1 (7d)  估算 +$18.40',
    'MSTR #2b (1d)  昨日費 +$2.59  ✗ 出區間  ⚖️ 觀察 → v4 動態⚠️hook·新池（你的區間重放多 $1.20/日）',
    'AMD #3  無小時資料',
    'TSLA #1233 (16d)  昨日費 +$3.20 (31h)  ⚖️ 留',
    'GOOGL #7005 (3d)  昨日費 +$1.26  ⚖️ 待累積',
  ])
  expect(formatFeesTotal(rows)).toBe('Σ 昨日費 +$7.05（0.17%/日） · 累積手續費 +$29.71 · 累積淨 +$57.25（已實現 +$0.00、未實現 +$57.25）')   // 平均 26.3h，偏離 < 3h 不印時數
  expect(formatFeesTotal([rows[0], rows[2]])).toBeNull()
  // 年化：Σ投入×天數 = 645.45×1 + 1056.92×16 + 2106.92×3 = 23876.93；手續費 29.71 → 45%，淨 57.25 → 88%；加權天數 23876.93/3809.29 = 6.3
  expect(formatApr(rows)).toBe('年化 手續費 45% · 含價差 88%（含已關閉；目前投入 $3809，加權 6.3 天）')
  expect(formatApr([rows[0]])).toBeNull()
  const text = formatDailySummary({ date: 'd', weekdayZh: '一', poolsScanned: 1, candidates: 0, sortKey: 'd1000.r25', top: [], changes: [], positions: [...formatPositions(rows), formatFeesTotal(rows)!, formatApr(rows)!] })
  expect(text).toContain('⚖️ 待累積\n\nΣ 昨日費'); expect(text).not.toContain('- Σ'); expect(text).toContain('\n年化 手續費'); expect(text).not.toContain('- 年化')
})

it('Σ 昨日費的 %/日 以「本金 × 時數」加權；年化用當時投入的本金天數（Codex review D69）', () => {
  const mk = (dep: number, usd: number, hours: number, days: any[]) => ({ symbol: 'X', label: 'X', closed_at: null, deposit_usd: dep, est: null, switchHint: null,
    actual: { fees_cum_usd: usd, value_usd: dep, net_usd: usd, days: 1, in_range: true, fees_withdrawn_usd: 0, fees_reinvested_usd: 0 }, feesLastDay: { usd, hours, from: 'a', to: 'b', capitalUsd: dep }, dailyFees: days }) as any
  const rows = [mk(9000, 90, 24, [{ date: 'd', usd: 90, capitalUsd: 9000, hours: 24 }]), mk(1000, 5, 12, [{ date: 'd', usd: 5, capitalUsd: 1000, hours: 12 }])]
  expect(formatFeesTotal(rows)).toContain('（1.00%/日')   // 95 / (9000×24 + 1000×12) × 24 = 1.00%
  // 先 1,000 持有 10 天、加倉到 3,000 再 10 天：本金天數 = 10,000 + 30,000
  const grown = mk(3000, 40, 24, [{ date: 'a', usd: 10, capitalUsd: 1000, hours: 240 }, { date: 'b', usd: 30, capitalUsd: 3000, hours: 240 }])
  expect(formatApr([grown])).toContain('手續費 37%')   // 40 / 40,000 × 365
})

it('區間內加倉：%/日 用切段後的本金小時（capHours）', () => {
  const row = { symbol: 'X', label: 'X', closed_at: null, deposit_usd: 10000, est: null, switchHint: null,
    actual: { fees_cum_usd: 3.3, value_usd: 10000, net_usd: 0, days: 1, in_range: true, fees_withdrawn_usd: 0, fees_reinvested_usd: 0 },
    feesLastDay: { usd: 3.3, hours: 24, from: 'a', to: 'b', capitalUsd: 10000, capHours: 1000 * 23 + 10000 * 1 }, dailyFees: [{ date: 'd', usd: 3.3, capitalUsd: 10000, hours: 24, capHours: 33000 }] } as any
  expect(formatFeesTotal([row])).toContain('（0.24%/日')   // 3.3 / 33,000 × 24
})

it('D70：累積含已關閉頭寸，close 日誌優先、沒有日誌標「含估計」', () => {
  const act = (fees: number, net: number) => ({ fees_cum_usd: fees, value_usd: 1000, net_usd: net, days: 5, in_range: true, fees_withdrawn_usd: 0, fees_reinvested_usd: 0 })
  const open = { symbol: 'A', label: 'A', closed_at: null, deposit_usd: 1000, est: null, switchHint: null, actual: act(10, 50), feesLastDay: { usd: 1, hours: 24, from: 'a', to: 'b', capitalUsd: 1000 } }
  const closedJ = { symbol: 'B', label: 'B', closed_at: '2026-10-06', deposit_usd: 1000, actual: act(16.68, 121.3), journal: [{ kind: 'close', data: { net_usd: 121.75, fees_lifetime_usd: 16.97 } }] }
  const closedSnap = { symbol: 'C', label: 'C', closed_at: '2026-09-29', deposit_usd: 1000, actual: act(7, -29.61), journal: [] }
  expect(formatFeesTotal([open, closedJ] as any)).toBe('Σ 昨日費 +$1.00（0.10%/日） · 累積手續費 +$26.97 · 累積淨 +$171.75（已實現 +$121.75、未實現 +$50.00）')
  expect(formatFeesTotal([open, closedJ, closedSnap] as any)).toContain('含估計')
})

it('D70：全部關倉仍顯示累積；只有日誌沒快照的關倉也算', () => {
  const noSnap = { symbol: 'D', label: 'D', closed_at: '2026-09-01', deposit_usd: 500, actual: null, journal: [{ kind: 'close', data: { net_usd: 6.08, fees_lifetime_usd: 6.08 } }] }
  const closedJ = { symbol: 'B', label: 'B', closed_at: '2026-10-06', deposit_usd: 1000, actual: { fees_cum_usd: 16.68, value_usd: 1000, net_usd: 121.3, days: 5, in_range: true, fees_withdrawn_usd: 0, fees_reinvested_usd: 0 }, journal: [{ kind: 'close', data: { net_usd: 121.75, fees_lifetime_usd: 16.97 } }] }
  expect(formatFeesTotal([noSnap, closedJ] as any)).toBe('累積手續費 +$23.05 · 累積淨 +$127.83（已實現 +$127.83、未實現 +$0.00）')
  expect(formatFeesTotal([{ ...noSnap, journal: [] }] as any)).toBeNull()
})

import { lifetimeTotals } from '../scanner/run.js'
it('D73：年化含已關閉頭寸；單位：$1,000 放 24 小時賺 $1 → 年化 36.5%；沒有本金時數的關倉分子分母都排除', () => {
  const day = (usd: number) => ({ date: 'd', usd, capitalUsd: 1000, hours: 24, capHours: 24000 })
  const base = { symbol: 'X', label: 'X', deposit_usd: 1000, est: null, switchHint: null }
  const open = { ...base, closed_at: null, actual: { fees_cum_usd: 1, value_usd: 1000, net_usd: 1, days: 1, in_range: true, fees_withdrawn_usd: 0, fees_reinvested_usd: 0 }, dailyFees: [day(1)] }
  expect(formatApr([open] as any)).toContain('手續費 37%')   // 1 / 1000 × 365 = 36.5%
  const closed = { ...base, closed_at: '2026-10-01', actual: { fees_cum_usd: 0, value_usd: 0, net_usd: 0, days: 1, in_range: false, fees_withdrawn_usd: 0, fees_reinvested_usd: 0 }, dailyFees: [day(1)], closeTailCapHours: 24000, journal: [{ kind: 'close', data: { net_usd: 3, fees_lifetime_usd: 2 } }] }
  expect(lifetimeTotals([open, closed] as any).rows.map(r => r.capHours)).toEqual([24000, 48000])   // 關倉頭寸含最後快照到關倉那段
  expect(formatApr([open, closed] as any)).toContain('手續費 37%')   // (1+2) / (1000×1 + 1000×2) × 365
  const noSnap = { ...base, closed_at: '2026-09-01', actual: null, journal: [{ kind: 'close', data: { net_usd: 50, fees_lifetime_usd: 50 } }] }
  const a = formatApr([open, noSnap] as any)!
  expect(a).toContain('手續費 37%'); expect(a).toContain('不含 1 筆無本金時數')
  expect(formatFeesTotal([open, noSnap] as any)).toContain('累積手續費 +$51.00')   // 累積照算
})
