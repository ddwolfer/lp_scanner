import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, fmtNum, fmtPct, fmtUsd, simOf, type Row } from '../api'
import { FlagChips, PoolName, RankArrow, Seg } from '../components/bits'
type Col = { key: string; label: string; get: (r: Row) => number | string | null; cls?: (v: any, r: Row) => string; fmt?: (v: any) => string; left?: boolean }
export default function Overview() {
  const [dates, setDates] = useState<string[]>([]); const [date, setDate] = useState<string>('')
  const [rows, setRows] = useState<Row[]>([]); const [D, setD] = useState('d1000'); const [R, setR] = useState('r25')
  const [all, setAll] = useState(false); const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: 'score', dir: -1 })
  const [err, setErr] = useState('')
  useEffect(() => { api<string[]>('/api/dates').then(d => { setDates(d); setDate(d[0] ?? '') }).catch(e => setErr(String(e))) }, [])
  useEffect(() => { if (!date) return; api<{ rows: Row[] }>(`/api/overview?date=${date}`).then(r => setRows(r.rows)).catch(e => setErr(String(e))) }, [date])
  const cols: Col[] = useMemo(() => [
    { key: 'rank_today', label: '#', get: r => r.rank_today, fmt: v => v ?? '—' },
    { key: 'arrow', label: '昨→今', get: r => (r.rank_prev ?? 9999) - (r.rank_today ?? 9999) },
    { key: 'symbol', label: '池', get: r => r.symbol, left: true },
    { key: 'tvl_usd', label: 'TVL', get: r => r.tvl_usd, fmt: v => fmtUsd(v) },
    { key: 'vol7_avg_usd', label: '7日均量', get: r => r.vol7_avg_usd, fmt: v => fmtUsd(v) },
    { key: 'vol7_cv', label: 'CV', get: r => r.vol7_cv, fmt: v => fmtNum(v, 2) },
    { key: 'trader_count', label: '交易者', get: r => r.trader_count, fmt: v => v ?? '—' },
    { key: 'top1_share', label: 'top1', get: r => r.top1_share, fmt: v => fmtPct(v) },
    { key: 'price_dev_pct', label: '偏離', get: r => r.price_dev_pct, fmt: v => fmtPct(v, 1), cls: v => v !== null && Math.abs(v) > 0.03 ? 'warn' : '' },
    { key: 'raw_apr', label: '原始 APR', get: r => r.raw_apr, fmt: v => fmtPct(v) },
    { key: 'net_apr', label: '模擬 net APR', get: r => simOf(r, D, R)?.net_apr ?? null, fmt: v => fmtPct(v), cls: v => v === null ? '' : v >= 0 ? 'pos' : 'neg' },
    { key: 'in_range', label: '在區間', get: r => simOf(r, D, R)?.in_range_pct ?? null, fmt: v => fmtPct(v) },
    { key: 'net_usd', label: '淨損益', get: r => simOf(r, D, R)?.net_usd ?? null, fmt: v => fmtUsd(v, 1), cls: v => v === null ? '' : v >= 0 ? 'pos' : 'neg' },
    { key: 'score', label: 'score', get: r => r.score, fmt: v => fmtNum(v, 3) },
    { key: 'flags', label: 'flags', get: r => r.flags.length, left: true },
  ], [D, R])
  const shown = useMemo(() => {
    const col = cols.find(c => c.key === sort.key)!
    return rows.filter(r => all || !r.excluded).sort((a, b) => {
      const va = col.get(a), vb = col.get(b)
      if (va === null || va === undefined) return 1; if (vb === null || vb === undefined) return -1
      return (va < vb ? -1 : va > vb ? 1 : 0) * sort.dir
    })
  }, [rows, all, sort, cols])
  const cand = rows.filter(r => !r.excluded).length
  return <>
    <div className="toolbar">
      <span><label>日期</label><select value={date} onChange={e => setDate(e.target.value)}>{dates.map(d => <option key={d}>{d}</option>)}</select></span>
      <span><label>投入</label><Seg value={D} onChange={setD} options={[['d200', '$200'], ['d1000', '$1000'], ['d5000', '$5000']]} /></span>
      <span><label>區間</label><Seg value={R} onChange={setR} options={[['r10', '±10%'], ['r25', '±25%'], ['rvol', 'vol']]} /></span>
      <span><label>顯示</label><Seg value={all ? 'all' : 'cand'} onChange={v => setAll(v === 'all')} options={[['cand', `候選 ${cand}`], ['all', `全部 ${rows.length}`]]} /></span>
      {err && <span className="neg">{err}</span>}
    </div>
    <table className="grid">
      <thead><tr>{cols.map(c => <th key={c.key} className={(c.left ? 'l ' : '') + (sort.key === c.key ? 'sorted' : '')} onClick={() => setSort(s => ({ key: c.key, dir: s.key === c.key ? (s.dir === 1 ? -1 : 1) : -1 }))}>{c.label}{sort.key === c.key ? (sort.dir === -1 ? ' ▼' : ' ▲') : ''}</th>)}</tr></thead>
      <tbody>{shown.map(r => <tr key={r.pool_id} className={r.excluded ? 'excluded' : ''}>
        {cols.map(c => {
          const v = c.get(r)
          if (c.key === 'arrow') return <td key={c.key}><RankArrow today={r.rank_today} prev={r.rank_prev} /></td>
          if (c.key === 'symbol') return <td key={c.key} className="l"><Link to={`/pool/${r.pool_id}`}><PoolName symbol={r.symbol} fee_ppm={r.fee_ppm} hooks={r.hooks} protocol={r.protocol} /></Link></td>
          if (c.key === 'flags') return <td key={c.key} className="l"><FlagChips flags={r.flags} /></td>
          return <td key={c.key} className={'num ' + (c.cls?.(v, r) ?? '')}>{c.fmt ? c.fmt(v) : String(v ?? '—')}</td>
        })}
      </tr>)}</tbody>
    </table>
    {!shown.length && <p className="muted">此日期沒有資料。</p>}
  </>
}
