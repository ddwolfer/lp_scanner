import { ZERO } from '../api'
export function RankArrow({ today, prev }: { today: number | null; prev: number | null }) {
  if (today === null) return <span className="arrow">—</span>
  if (prev === null) return <span className="arrow new">NEW</span>
  if (prev === today) return <span className="arrow">{prev} =</span>
  return <span className={'arrow ' + (prev > today ? 'up' : 'down')}>{prev} {prev > today ? '↑' : '↓'}</span>
}
const BAD = new Set(['wash_suspect', 'fake_stock', 'halted', 'corp_action_pending', 'asset_inactive', 'has_hooks', 'fee_out_of_range', 'tvl_too_small', 'too_new', 'not_stock', 'non_usd_quote'])
export function FlagChips({ flags, max = 3 }: { flags: string[]; max?: number }) {
  const f = [...new Set(flags)].filter(x => !['short_history', 'sigma_from_pool', 'tvl_unknown'].includes(x))
  return <>{f.slice(0, max).map(x => <span key={x} className={'chip ' + (BAD.has(x) ? 'bad' : '')}>{x}</span>)}{f.length > max && <span className="chip">+{f.length - max}</span>}</>
}
export function PoolName({ symbol, fee_ppm, hooks, protocol }: { symbol: string; fee_ppm: number | null; hooks: string; protocol: string }) {
  return <><b>{symbol}</b><span className="muted">/USDG</span> <span className="chip">{protocol}</span><span className="chip num">{fee_ppm === null ? '動態' : (fee_ppm / 1e4).toFixed(2) + '%'}</span>{hooks !== ZERO && <span className="chip hooks">hooks</span>}</>
}
export const Seg = ({ value, options, onChange }: { value: string; options: [string, string][]; onChange: (v: string) => void }) =>
  <span className="seg">{options.map(([v, l]) => <button key={v} className={v === value ? 'on' : ''} onClick={() => onChange(v)}>{l}</button>)}</span>
