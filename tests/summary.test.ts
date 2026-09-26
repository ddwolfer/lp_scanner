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
import { formatPositions, shouldFetchSwaps, formatFeesTotal } from '../scanner/run.js'
it('formatPositions 只列未關閉頭寸', () => {
  const rows = [
    { symbol: 'SOFI', label: '#1', closed_at: null, est: { net_usd: 18.4, hours: 168, in_range: true } },
    { symbol: 'MSTR', label: '#2b', closed_at: null, deposit_usd: 645.45, actual: { fees_cum_usd: 3.87, value_usd: 655.71, net_usd: 14.13, days: 1, in_range: true }, est: { net_usd: 11.34, hours: 10, in_range: true } },
    { symbol: 'IBM', label: '#2', closed_at: '2026-09-01', est: { net_usd: -1, hours: 24, in_range: false } },
    { symbol: 'AMD', label: '#3', closed_at: null, est: null },
  ] as any
  expect(formatPositions(rows)).toEqual(['SOFI/USDG #1  +$18.40 (7d, 估算)  在區間 ✓', 'MSTR/USDG #2b (1d)  手續費 +$3.87 + 價差 +$10.26 = +$14.13（模擬 +$11.34）  在區間 ✓', 'AMD/USDG #3  無小時資料'])
})

it('formatPositions 有換池提示時加一行縮排（D65）', () => {
  const rows = [{ symbol: 'SPCX', label: '#7838', closed_at: null, deposit_usd: 1953.8, actual: { fees_cum_usd: 12.1, value_usd: 1949.6, net_usd: 7.9, days: 3, in_range: true }, est: null,
    switchHint: { verdict: 'consider', heldRate7: 0.0008, validDays: 7, altsPending: 0, best: { poolId: 'x', label: 'v3 0.05%', rate7: 0.0023 }, daysAbove: 3, extraPerDay: 3, switchCostUsd: 13.3, recoverDays: 4.43 } }] as any
  expect(formatPositions(rows)).toEqual(['SPCX/USDG #7838 (3d)  手續費 +$12.10 + 價差 −$4.20 = +$7.90（模擬 —）  在區間 ✓', '  ⚖️ 費/TVL 7日 0.08%/日 vs 最佳替代 v3 0.05% 0.23%/日 ×3天 → 考慮換（粗估多賺 $3.00/日，換池成本 $13.30，4.4 天回本）'])
})
it('shouldFetchSwaps：低費率池只為持有/觀察中的股票抓（D65）', () => {
  const base = { hookKind: 'none' as const, feeOk: false, lowFee: true, tvl: 20000, minTvl: 1000, lowFeeMinTvl: 5000 }
  expect(shouldFetchSwaps({ ...base, watched: true })).toBe(true)
  expect(shouldFetchSwaps({ ...base, watched: false })).toBe(false)
  expect(shouldFetchSwaps({ ...base, watched: true, tvl: 3000 })).toBe(false)              // 低費率池 TVL 要到候選門檻
  expect(shouldFetchSwaps({ ...base, watched: true, hookKind: 'liquidity' })).toBe(false)  // 流動性 hook 永遠不抓
  expect(shouldFetchSwaps({ ...base, watched: false, feeOk: true, lowFee: false, tvl: 1500 })).toBe(true)   // 一般池照 D16
  expect(shouldFetchSwaps({ ...base, watched: true, feeOk: false, lowFee: false })).toBe(false)             // 費率過高的池不抓
  expect(shouldFetchSwaps({ ...base, watched: true, tvl: null })).toBe(false)
})

it('D66：昨日費附在頭寸行尾，合計行不加 bullet', () => {
  const rows = [
    { symbol: 'TSLA', label: '#1', closed_at: null, deposit_usd: 1056.92, actual: { fees_cum_usd: 23.99, value_usd: 1067.09, net_usd: 34.17, days: 15, in_range: true }, est: null, feesLastDay: { usd: 3.57, hours: 24.2, from: 'a', to: 'b' } },
    { symbol: 'SPCX', label: '#2', closed_at: null, deposit_usd: 1953.8, actual: { fees_cum_usd: 1.29, value_usd: 1956.37, net_usd: 3.86, days: 2, in_range: true }, est: null, feesLastDay: { usd: 1.29, hours: 31, from: 'a', to: 'b' } },
    { symbol: 'IBM', label: '#3', closed_at: '2026-09-01', deposit_usd: 100, actual: { fees_cum_usd: 1, value_usd: 100, net_usd: 1, days: 1, in_range: true }, est: null, feesLastDay: { usd: 9, hours: 24, from: 'a', to: 'b' } },
  ] as any
  const lines = formatPositions(rows)
  expect(lines[0]).toMatch(/在區間 ✓  昨日費 \+\$3\.57$/)
  expect(lines[1]).toMatch(/昨日費 \+\$1\.29 \(31h\)$/)
  expect(formatFeesTotal(rows)).toBe('Σ 昨日手續費 +$4.86 / 投入 $3011（0.14%/日，28h）')   // 閉倉不算；平均 27.6h 偏離 24h > 3h → 印時數
  expect(formatFeesTotal([rows[2]])).toBeNull()
  const text = formatDailySummary({ date: 'd', weekdayZh: '一', poolsScanned: 1, candidates: 0, sortKey: 'd1000.r25', top: [], changes: [], positions: [...lines, formatFeesTotal(rows)!] })
  expect(text).toContain('\nΣ 昨日手續費'); expect(text).not.toContain('- Σ')
})
