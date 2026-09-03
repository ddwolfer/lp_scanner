import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend } from 'recharts'
import { api, fmtNum, fmtUsd } from '../api'
export default function Positions() {
  const [list, setList] = useState<any[]>([]); const [err, setErr] = useState('')
  const [f, setF] = useState({ pool_id: '', label: '', range_lower: '', range_upper: '', deposit_usd: '', opened_at: new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16), notes: '' })
  const load = () => api<any[]>('/api/positions').then(setList).catch(e => setErr(String(e)))
  useEffect(() => { load() }, [])
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('')
    try {
      await api('/api/positions', { method: 'POST', body: JSON.stringify({ pool_id: f.pool_id.trim().toLowerCase(), label: f.label, range_lower: Number(f.range_lower), range_upper: Number(f.range_upper), deposit_usd: Number(f.deposit_usd), opened_at: new Date(f.opened_at).toISOString(), notes: f.notes }) })
      setF({ ...f, pool_id: '', label: '', range_lower: '', range_upper: '', deposit_usd: '' }); load()
    } catch (e) { setErr(String(e)) }
  }
  const close = async (p: any) => {
    const fees = prompt('實際領到的手續費 (USD)', p.est ? p.est.fees_cum_usd.toFixed(2) : '0'); if (fees === null) return
    const value = prompt('最終市值 (USD)', p.est ? p.est.value_usd.toFixed(2) : String(p.deposit_usd)); if (value === null) return
    await api(`/api/positions/${p.id}/close`, { method: 'PATCH', body: JSON.stringify({ closed_at: new Date().toISOString(), fees_final_usd: Number(fees), value_final_usd: Number(value) }) }); load()
  }
  const tsFmt = (t: number) => new Date(t * 1000).toISOString().slice(5, 16).replace('T', ' ')
  return <>
    <h2>登錄頭寸</h2>
    <form className="pos-form card" onSubmit={submit}>
      <label>pool_id<input required value={f.pool_id} onChange={e => setF({ ...f, pool_id: e.target.value })} placeholder="0x…" /></label>
      <label>標籤<input required value={f.label} onChange={e => setF({ ...f, label: e.target.value })} placeholder="SOFI #1" /></label>
      <label>區間下限 (USD)<input required type="number" step="any" value={f.range_lower} onChange={e => setF({ ...f, range_lower: e.target.value })} /></label>
      <label>區間上限 (USD)<input required type="number" step="any" value={f.range_upper} onChange={e => setF({ ...f, range_upper: e.target.value })} /></label>
      <label>投入 (USD)<input required type="number" step="any" value={f.deposit_usd} onChange={e => setF({ ...f, deposit_usd: e.target.value })} /></label>
      <label>開倉時間<input required type="datetime-local" value={f.opened_at} onChange={e => setF({ ...f, opened_at: e.target.value })} /></label>
      <label style={{ gridColumn: 'span 5' }}>備註<input value={f.notes} onChange={e => setF({ ...f, notes: e.target.value })} /></label>
      <button className="primary" type="submit">登錄</button>
    </form>
    {err && <p className="neg">{err}</p>}
    <h2>頭寸（{list.length}）</h2>
    <div className="cards">
      {list.map(p => <div className="card" key={p.id}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <b>{p.label}</b><Link to={`/pool/${p.pool_id}`}>{p.symbol}/USDG {(p.fee_ppm / 1e4).toFixed(2)}%</Link>
        </div>
        <div className="muted num" style={{ fontSize: 11 }}>{p.opened_at.slice(0, 16)} → {p.closed_at ? p.closed_at.slice(0, 16) : '持有中'} · 區間 {fmtNum(p.range_lower, 2)}–{fmtNum(p.range_upper, 2)} · 投入 {fmtUsd(p.deposit_usd)}</div>
        {p.final ? <div style={{ marginTop: 8 }}><span className="stat">{fmtUsd(p.final.value_usd + p.final.fees_cum_usd - p.deposit_usd, 1)}<small>實際淨損益（市值 {fmtUsd(p.final.value_usd, 1)} + 手續費 {fmtUsd(p.final.fees_cum_usd, 1)}）</small></span></div>
          : p.est ? <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginTop: 8 }}>
              <div><div className="muted" style={{ fontSize: 11 }}>估計現值</div><div className="stat">{fmtUsd(p.est.value_usd, 1)}</div></div>
              <div><div className="muted" style={{ fontSize: 11 }}>估計累積手續費</div><div className="stat pos">{fmtUsd(p.est.fees_cum_usd, 1)}</div></div>
              <div><div className="muted" style={{ fontSize: 11 }}>估計淨損益</div><div className={'stat ' + (p.est.net_usd >= 0 ? 'pos' : 'neg')}>{fmtUsd(p.est.net_usd, 1)}</div></div>
            </div>
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{p.est.in_range ? '✓ 在區間內' : '✗ 出區間'} · 池價 {fmtNum(p.est.price, 3)} · {p.est.hours} 小時 · 以 pool_hourly 模擬估算，P5 回填實際值</div>
            <ResponsiveContainer width="100%" height={120}><LineChart data={p.curve}><CartesianGrid stroke="#262b34" /><XAxis dataKey="ts" tickFormatter={tsFmt} minTickGap={50} /><YAxis width={50} tickFormatter={v => '$' + v.toFixed(0)} /><Tooltip labelFormatter={v => tsFmt(Number(v))} /><Legend /><Line type="monotone" dataKey="net" name="模擬淨損益" stroke="#f2b135" dot={false} /></LineChart></ResponsiveContainer>
          </> : <p className="muted">此池尚無小時資料，無法估算。</p>}
        {!p.closed_at && <div style={{ marginTop: 8 }}><button className="ghost" onClick={() => close(p)}>關閉頭寸（記錄實際手續費與市值）</button></div>}
      </div>)}
    </div>
  </>
}
