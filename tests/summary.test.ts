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
import { formatPositions } from '../scanner/run.js'
it('formatPositions 只列未關閉頭寸', () => {
  const rows = [
    { symbol: 'SOFI', label: '#1', closed_at: null, est: { net_usd: 18.4, hours: 168, in_range: true } },
    { symbol: 'MSTR', label: '#2b', closed_at: null, deposit_usd: 645.45, actual: { fees_cum_usd: 3.87, value_usd: 655.71, net_usd: 14.13, days: 1, in_range: true }, est: { net_usd: 11.34, hours: 10, in_range: true } },
    { symbol: 'IBM', label: '#2', closed_at: '2026-09-01', est: { net_usd: -1, hours: 24, in_range: false } },
    { symbol: 'AMD', label: '#3', closed_at: null, est: null },
  ] as any
  expect(formatPositions(rows)).toEqual(['SOFI/USDG #1  +$18.40 (7d, 估算)  在區間 ✓', 'MSTR/USDG #2b (1d)  手續費 +$3.87 + 價差 +$10.26 = +$14.13（模擬 +$11.34）  在區間 ✓', 'AMD/USDG #3  無小時資料'])
})
