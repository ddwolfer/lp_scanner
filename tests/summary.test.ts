import { it, expect, vi } from 'vitest'
import { formatDailySummary } from '../scanner/notify/summary.js'
import { sendTelegram } from '../scanner/notify/telegram.js'
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
