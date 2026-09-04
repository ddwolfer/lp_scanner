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
  const [jText, setJText] = useState<Record<number, string>>({}); const [jKind, setJKind] = useState<Record<number, string>>({})
  const [jImgs, setJImgs] = useState<Record<number, { name: string; dataUrl: string }[]>>({})
  const readFiles = (id: number, files: FileList | File[]) => {
    for (const f of Array.from(files)) { if (!f.type.startsWith('image/')) continue; const r = new FileReader(); r.onload = () => setJImgs(m => ({ ...m, [id]: [...(m[id] ?? []), { name: f.name || 'paste.png', dataUrl: String(r.result) }] })); r.readAsDataURL(f) }
  }
  const onPaste = (id: number, e: React.ClipboardEvent) => { const fs = Array.from(e.clipboardData.items).filter(i => i.type.startsWith('image/')).map(i => i.getAsFile()!).filter(Boolean); if (fs.length) { e.preventDefault(); readFiles(id, fs) } }
  const addNote = async (id: number) => {
    const text = (jText[id] ?? '').trim(); const images = jImgs[id] ?? []; if (!text && !images.length) return
    try { await api(`/api/positions/${id}/journal`, { method: 'POST', body: JSON.stringify({ kind: jKind[id] ?? 'note', text, images }) }); setJText({ ...jText, [id]: '' }); setJImgs({ ...jImgs, [id]: [] }); load() } catch (e) { setErr(String(e)) }
  }
  const KINDS: [string, string][] = [['open', '開倉理由'], ['note', '筆記'], ['adjust', '調整'], ['collect', '領手續費'], ['close', '關倉'], ['review', '檢討']]
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
          <b>{p.label}</b>{p.notes_json?.source === 'onchain' && <span className="chip" style={{ marginLeft: 6 }}>鏈上</span>}<Link to={`/pool/${p.pool_id}`}>{p.symbol}/USDG {(p.fee_ppm / 1e4).toFixed(2)}%</Link>
        </div>
        <div className="muted num" style={{ fontSize: 11 }}>{p.opened_at.slice(0, 16)} → {p.closed_at ? p.closed_at.slice(0, 16) : '持有中'} · 區間 {fmtNum(p.range_lower, 2)}–{fmtNum(p.range_upper, 2)} · 投入 {fmtUsd(p.deposit_usd)}</div>
        {p.actual && !p.final && <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 8, marginTop: 8 }}>
            <div><div className="muted" style={{ fontSize: 11 }}>鏈上現值</div><div className="stat">{fmtUsd(p.actual.value_usd, 1)}</div></div>
            <div><div className="muted" style={{ fontSize: 11 }}>未領手續費</div><div className="stat pos">{fmtUsd(p.actual.fees_cum_usd, 1)}</div></div>
            <div><div className="muted" style={{ fontSize: 11 }}>實際淨損益</div><div className={'stat ' + (p.actual.net_usd >= 0 ? 'pos' : 'neg')}>{fmtUsd(p.actual.net_usd, 1)}</div></div>
            <div><div className="muted" style={{ fontSize: 11 }}>實際 − 模擬</div><div className={'stat ' + ((p.est ? p.actual.net_usd - p.est.net_usd : 0) >= 0 ? 'pos' : 'neg')}>{p.est ? fmtUsd(p.actual.net_usd - p.est.net_usd, 1) : '—'}</div></div>
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{p.actual.in_range ? '✓ 在區間內' : '✗ 出區間'} · 鏈上快照 {p.actual.date} · {p.actual.days} 天{p.actual.deposit_estimated && ' · 投入金額為首次看到時的市值（估）'}</div>
          {p.history.length > 1 && <ResponsiveContainer width="100%" height={140}><LineChart data={p.history}><CartesianGrid stroke="#262b34" /><XAxis dataKey="date" tickFormatter={(v: string) => v.slice(5)} /><YAxis width={50} tickFormatter={v => '$' + v.toFixed(0)} /><Tooltip /><Legend /><Line type="monotone" dataKey="actual" name="實際淨損益" stroke="#4fd18b" dot /><Line type="monotone" dataKey="sim" name="模擬淨損益" stroke="#f2b135" dot strokeDasharray="4 3" /></LineChart></ResponsiveContainer>}
        </>}
        {p.final ? <div style={{ marginTop: 8 }}><span className="stat">{fmtUsd(p.final.value_usd + p.final.fees_cum_usd - p.deposit_usd, 1)}<small>實際淨損益（市值 {fmtUsd(p.final.value_usd, 1)} + 手續費 {fmtUsd(p.final.fees_cum_usd, 1)}）</small></span></div>
          : p.actual ? null : p.est ? <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginTop: 8 }}>
              <div><div className="muted" style={{ fontSize: 11 }}>估計現值</div><div className="stat">{fmtUsd(p.est.value_usd, 1)}</div></div>
              <div><div className="muted" style={{ fontSize: 11 }}>估計累積手續費</div><div className="stat pos">{fmtUsd(p.est.fees_cum_usd, 1)}</div></div>
              <div><div className="muted" style={{ fontSize: 11 }}>估計淨損益</div><div className={'stat ' + (p.est.net_usd >= 0 ? 'pos' : 'neg')}>{fmtUsd(p.est.net_usd, 1)}</div></div>
            </div>
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{p.est.in_range ? '✓ 在區間內' : '✗ 出區間'} · 池價 {fmtNum(p.est.price, 3)} · {p.est.hours} 小時 · 以 pool_hourly 模擬估算，P5 回填實際值</div>
            <ResponsiveContainer width="100%" height={120}><LineChart data={p.curve}><CartesianGrid stroke="#262b34" /><XAxis dataKey="ts" tickFormatter={tsFmt} minTickGap={50} /><YAxis width={50} tickFormatter={v => '$' + v.toFixed(0)} /><Tooltip labelFormatter={v => tsFmt(Number(v))} /><Legend /><Line type="monotone" dataKey="net" name="模擬淨損益" stroke="#f2b135" dot={false} /></LineChart></ResponsiveContainer>
          </> : <p className="muted">此池尚無小時資料，無法估算。</p>}
        <div style={{ marginTop: 10, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
          <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>日誌（自動匯出到 data/positions/）</div>
          {(p.journal ?? []).map((j: any) => <div key={j.id} style={{ fontSize: 12, marginBottom: 6 }}><span className="chip">{KINDS.find(k => k[0] === j.kind)?.[1] ?? j.kind}</span><span className="muted num" style={{ fontSize: 10, marginRight: 6 }}>{j.ts.slice(0, 16).replace('T', ' ')}</span>{j.text}
            {j.data?.images?.length > 0 && <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>{j.data.images.map((im: string) => <a key={im} href={`/api/journal-image/${im}`} target="_blank" rel="noreferrer"><img src={`/api/journal-image/${im}`} style={{ height: 90, borderRadius: 4, border: '1px solid var(--line-2)' }} /></a>)}</div>}
          </div>)}
          <div style={{ display: 'flex', gap: 6, marginTop: 6, alignItems: 'center' }}>
            <select value={jKind[p.id] ?? 'note'} onChange={e => setJKind({ ...jKind, [p.id]: e.target.value })}>{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            <input style={{ flex: 1 }} placeholder="打字，或直接 Ctrl+V 貼截圖…" value={jText[p.id] ?? ''} onChange={e => setJText({ ...jText, [p.id]: e.target.value })} onKeyDown={e => e.key === 'Enter' && addNote(p.id)} onPaste={e => onPaste(p.id, e)} />
            <label className="ghost" style={{ padding: '5px 10px', cursor: 'pointer' }}>選圖<input type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={e => e.target.files && readFiles(p.id, e.target.files)} /></label>
            <button className="ghost" onClick={() => addNote(p.id)}>記錄</button>
          </div>
          {(jImgs[p.id]?.length ?? 0) > 0 && <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>{jImgs[p.id].map((im, i) => <div key={i} style={{ position: 'relative' }}><img src={im.dataUrl} style={{ height: 60, borderRadius: 4, border: '1px solid var(--amber)' }} /><button className="ghost" style={{ position: 'absolute', top: -6, right: -6, padding: '0 5px', fontSize: 10 }} onClick={() => setJImgs({ ...jImgs, [p.id]: jImgs[p.id].filter((_, k) => k !== i) })}>×</button></div>)}</div>}
        </div>
        {!p.closed_at && <div style={{ marginTop: 8 }}><button className="ghost" onClick={() => close(p)}>關閉頭寸（記錄實際手續費與市值）</button></div>}
      </div>)}
    </div>
  </>
}
