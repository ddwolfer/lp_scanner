import { ZERO, HOOK_ZH, feeLabel } from '../api'
export function RankArrow({ today, prev }: { today: number | null; prev: number | null }) {
  if (today === null) return <span className="arrow">—</span>
  if (prev === null) return <span className="arrow new">NEW</span>
  if (prev === today) return <span className="arrow">{prev} =</span>
  return <span className={'arrow ' + (prev > today ? 'up' : 'down')}>{prev} {prev > today ? '↑' : '↓'}</span>
}
const BAD = new Set(['wash_suspect', 'fake_stock', 'halted', 'corp_action_pending', 'asset_inactive', 'has_hooks', 'fee_out_of_range', 'tvl_too_small', 'too_new', 'not_stock', 'non_usd_quote'])
const NOISE = ['short_history', 'sigma_from_pool', 'tvl_unknown', 'rvol_fallback', 'wash_sampled', 'tvl_stale']   // 資訊性 flag，總覽不顯示（單池頁 max 大時仍顯示）
export function FlagChips({ flags, max = 3 }: { flags: string[]; max?: number }) {
  const f = [...new Set(flags)].filter(x => max >= 8 || !NOISE.includes(x))
  return <>{f.slice(0, max).map(x => <span key={x} className={'chip ' + (BAD.has(x) ? 'bad' : '')}>{x}</span>)}{f.length > max && <span className="chip">+{f.length - max}</span>}</>
}
export function PoolName({ symbol, fee_ppm, fee_ppm_observed = null, hooks, hook_kind, hook_flags = [], protocol }: { symbol: string; fee_ppm: number | null; fee_ppm_observed?: number | null; hooks: string; hook_kind?: string | null; hook_flags?: string[]; protocol: string }) {
  const kind = hook_kind ?? (hooks === ZERO ? 'none' : 'liquidity')
  const title = hook_flags.length ? 'hook 介入時機：' + hook_flags.map(f => HOOK_ZH[f] ?? f).join('、') : ''
  return <><b>{symbol}</b><span className="muted">/USDG</span> <span className="chip">{protocol}</span><span className="chip num" title={fee_ppm === null ? '動態費率（hook 每筆決定），顯示今日中位數' : ''}>{feeLabel(fee_ppm, fee_ppm_observed)}</span>
    {kind === 'fee_only' && <span className="chip hooks" title={title}>hook·費率</span>}
    {kind === 'liquidity' && <span className="chip bad" title={title}>hook·流動性</span>}</>
}
export const Seg = ({ value, options, onChange }: { value: string; options: [string, string][]; onChange: (v: string) => void }) =>
  <span className="seg">{options.map(([v, l]) => <button key={v} className={v === value ? 'on' : ''} onClick={() => onChange(v)}>{l}</button>)}</span>
