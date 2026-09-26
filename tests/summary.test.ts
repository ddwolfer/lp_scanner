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
      feesLastDay: { usd: 2.59, hours: 24, from: 'a', to: 'b' }, switchHint: { verdict: 'consider', best: { label: 'v4 ~0.15%' }, extraPerDay: 3.41, recoverDays: 1.8 } },
    { symbol: 'IBM', label: '#2', closed_at: '2026-09-01', est: { net_usd: -1, hours: 24, in_range: false } },
    { symbol: 'AMD', label: '#3', closed_at: null, est: null },
    { symbol: 'TSLA', label: 'TSLA #1233', closed_at: null, deposit_usd: 1056.92, actual: { fees_cum_usd: 24.04, value_usd: 1067.09, net_usd: 33.84, days: 16, in_range: true, fees_withdrawn_usd: 0, fees_reinvested_usd: 0 }, est: null,
      feesLastDay: { usd: 3.2, hours: 31, from: 'a', to: 'b' }, switchHint: { verdict: 'stay' } },
    { symbol: 'GOOGL', label: 'GOOGL #7005', closed_at: null, deposit_usd: 2106.92, actual: { fees_cum_usd: 1.8, value_usd: 2114, net_usd: 9.28, days: 3, in_range: true, fees_withdrawn_usd: 0, fees_reinvested_usd: 0 }, est: null,
      feesLastDay: { usd: 1.26, hours: 24, from: 'a', to: 'b' }, switchHint: { verdict: 'no_data' } },
  ] as any
  expect(formatPositions(rows)).toEqual([
    'SOFI #1 (7d)  估算 +$18.40',
    'MSTR #2b (1d)  昨日費 +$2.59  ✗ 出區間  ⚖️ 考慮換 → v4 ~0.15%（多賺 $3.41/日，1.8 天回本）',
    'AMD #3  無小時資料',
    'TSLA #1233 (16d)  昨日費 +$3.20 (31h)  ⚖️ 留',
    'GOOGL #7005 (3d)  昨日費 +$1.26  ⚖️ 待累積',
  ])
  expect(formatFeesTotal(rows)).toBe('Σ 昨日費 +$7.05（0.17%/日） · 累積手續費 +$29.71 · 累積淨 +$57.25')   // 平均 26.3h，偏離 < 3h 不印時數
  expect(formatFeesTotal([rows[0], rows[2]])).toBeNull()
  // 年化：Σ投入×天數 = 645.45×1 + 1056.92×16 + 2106.92×3 = 23876.93；手續費 29.71 → 45%，淨 57.25 → 88%；加權天數 23876.93/3809.29 = 6.3
  expect(formatApr(rows)).toBe('年化 手續費 45% · 含價差 88%（投入 $3809，加權 6.3 天）')
  expect(formatApr([rows[0]])).toBeNull()
  const text = formatDailySummary({ date: 'd', weekdayZh: '一', poolsScanned: 1, candidates: 0, sortKey: 'd1000.r25', top: [], changes: [], positions: [...formatPositions(rows), formatFeesTotal(rows)!, formatApr(rows)!] })
  expect(text).toContain('⚖️ 待累積\n\nΣ 昨日費'); expect(text).not.toContain('- Σ'); expect(text).toContain('\n年化 手續費'); expect(text).not.toContain('- 年化')
})
