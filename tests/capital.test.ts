import { expect, it } from 'vitest'
import { netDeposits, formatWalletLine } from '../scanner/metrics/capital.js'
const ME = '0xAAA', OKX1 = '0xb995', OKX2 = '0x2BAF', USDG = '0xUSDG'
it('netDeposits：雙向、只算指定代幣與對手、大小寫不敏感、去重', () => {
  const xs = [
    { from: OKX1, to: ME.toLowerCase(), contract: USDG, value: 100, hash: 'a', logIndex: 1 },
    { from: OKX1, to: ME, contract: USDG, value: 100, hash: 'a', logIndex: 1 },          // 重複（跨頁）
    { from: ME, to: '0x2baf', contract: USDG.toLowerCase(), value: 30, hash: 'b', logIndex: 0 },
    { from: '0xother', to: ME, contract: USDG, value: 999, hash: 'c', logIndex: 0 },     // 非指定對手
    { from: OKX1, to: ME, contract: '0xETHlike', value: 5, hash: 'd', logIndex: 0 },     // 非 USDG
  ]
  expect(netDeposits(xs, ME, [OKX1, OKX2], USDG)).toEqual({ net: 70, in: 100, out: 30, n: 2 })
})
it('formatWalletLine：正常、低估標記、失敗或不是今天 → 不可用、未設定 → 不顯示', () => {
  const s = { date: '2026-10-07', status: 'ok', wallet_usd: 428.58, lp_usd: 10446.71, lp_fees_usd: 169.68, net_deposit_usd: 10530.27, adjust_usd: 0 }
  expect(formatWalletLine(s, true, '2026-10-07')).toBe('錢包 $11,045 vs OKX 淨入金 $10,530 → +$515（+4.9%）')
  expect(formatWalletLine({ ...s, status: 'incomplete' }, true, '2026-10-07')).toContain('低估')
  expect(formatWalletLine({ ...s, status: 'error' }, true, '2026-10-07')).toBe('⚠️ 錢包對帳資料不可用')
  expect(formatWalletLine(s, true, '2026-10-08')).toBe('⚠️ 錢包對帳資料不可用')
  expect(formatWalletLine(null, false, '2026-10-07')).toBeNull()
})

it('formatWalletLine：淨入金 ≤ 0 時不算百分比', () => {
  const s = { date: 'd', status: 'ok', wallet_usd: 100, lp_usd: 0, lp_fees_usd: 0, net_deposit_usd: 0, adjust_usd: 0 }
  expect(formatWalletLine(s, true, 'd')).toBe('錢包 $100 vs OKX 淨入金 $0 → +$100')
  expect(formatWalletLine({ ...s, net_deposit_usd: -500 }, true, 'd')).toBe('錢包 $100 vs OKX 淨入金 $-500 → +$600')
})
