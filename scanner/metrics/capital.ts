// scanner/metrics/capital.ts — 錢包對淨入金（D70），純函式
export interface Xfer { from: string; to: string; contract: string; value: number; hash: string; logIndex?: string | number | null }
/** 指定對手地址與自己之間某代幣的淨流入（轉入 − 轉出）。以 hash + logIndex 去重，地址大小寫不敏感 */
export function netDeposits(xs: Xfer[], me: string, counterparties: string[], token: string): { net: number; in: number; out: number; n: number } {
  const m = me.toLowerCase(), cps = new Set(counterparties.map(c => c.toLowerCase())), t = token.toLowerCase(); const seen = new Set<string>()
  let inn = 0, out = 0, n = 0
  for (const x of xs) {
    if (x.contract.toLowerCase() !== t) continue
    const k = `${x.hash}:${x.logIndex ?? ''}`; if (seen.has(k)) continue; seen.add(k)
    const f = x.from.toLowerCase(), to = x.to.toLowerCase()
    if (cps.has(f) && to === m) { inn += x.value; n++ } else if (f === m && cps.has(to)) { out += x.value; n++ }
  }
  return { net: inn - out, in: inn, out, n }
}
export interface WalletSnap { date: string; status: string; wallet_usd: number | null; lp_usd: number | null; lp_fees_usd: number | null; net_deposit_usd: number | null; adjust_usd: number | null }
/** 日報的錢包行。沒設定對手地址 → null（不顯示）；今天沒有快照或失敗 → 明確寫不可用 */
export function formatWalletLine(s: WalletSnap | null, configured: boolean, today: string): string | null {
  if (!configured) return null
  if (!s || s.date !== today || s.status === 'error' || s.wallet_usd === null || s.net_deposit_usd === null) return '⚠️ 錢包對帳資料不可用'
  const total = s.wallet_usd + (s.lp_usd ?? 0) + (s.lp_fees_usd ?? 0), base = s.net_deposit_usd + (s.adjust_usd ?? 0), diff = total - base
  const money = (v: number) => `$${Math.round(v).toLocaleString('en-US')}`
  const pct = base > 0 ? `（${diff >= 0 ? '+' : '−'}${(Math.abs(diff) / base * 100).toFixed(1)}%）` : ''   // 淨入金 ≤ 0（出金多於入金）不算百分比（Codex review）
  return `錢包 ${money(total)} vs OKX 淨入金 ${money(base)} → ${diff >= 0 ? '+' : '−'}$${Math.abs(diff).toFixed(0)}${pct}${s.status === 'incomplete' ? '（部分代幣無價格，低估）' : ''}`
}
