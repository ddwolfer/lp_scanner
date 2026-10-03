// D68：每週手續費。長條圖看週與週的變化，點一週看逐日與各頭寸
import { useEffect, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api, fmtUsd } from '../api'
type WeekDay = { usDay: string; weekday: string; total: number; byPos: { id: number; label: string; usd: number }[] }
type Week = { weekStart: string; days: WeekDay[]; weekend: number; total: number; capital: number; byPos: { id: number; label: string; usd: number }[] }
const md = (ymd: string) => { const [, m, d] = ymd.split('-'); return `${+m}/${+d}` }
const pct = (usd: number, cap: number) => cap > 0 ? (usd / cap * 100).toFixed(2) + '%' : '—'
export default function WeeklyFees({ reloadToken }: { reloadToken?: unknown }) {   // reloadToken：父頁重新載入頭寸時一併重抓（關倉、登錄後，Codex review）
  const [weeks, setWeeks] = useState<Week[]>([]); const [sel, setSel] = useState(0)
  useEffect(() => { api<Week[]>('/api/fees/weekly').then(ws => { setWeeks(ws); setSel(i => Math.min(i, Math.max(0, ws.length - 1))) }).catch(() => setWeeks([])) }, [reloadToken])
  if (!weeks.length) return null
  const w = weeks[sel]
  // 前一週要剛好早 7 天；中間有空白週時不拿更早的週來比（Codex review）
  const prevStart = new Date(Date.parse(w.weekStart + 'T00:00:00Z') - 7 * 86400000).toISOString().slice(0, 10)
  const prev = weeks.find(x => x.weekStart === prevStart)
  const chart = weeks.slice(0, 10).map((x, i) => ({ i, label: md(x.weekStart), total: Number(x.total.toFixed(2)) })).reverse()
  const tradingAvg = w.days.length ? w.days.reduce((a, d) => a + d.total, 0) / w.days.length : 0
  const prevBy = new Map((prev?.byPos ?? []).map(x => [x.id, x.usd]))
  const delta = (v: number) => <span className={v >= 0 ? 'pos' : 'neg'}>{v >= 0 ? '+' : '−'}{fmtUsd(Math.abs(v), 2)}</span>
  return <>
    <h2>每週手續費</h2>
    <div className="card">
      <div className="muted" style={{ fontSize: 13 }}>每根是一週（美股週一到週日）所有頭寸已賺手續費合計，含已領的。點長條看那一週。</div>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={chart} margin={{ top: 16, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="#262b34" vertical={false} />
          <XAxis dataKey="label" tickFormatter={v => v + ' 週'} />
          <YAxis width={48} tickFormatter={v => '$' + v} />
          <Tooltip formatter={(v: any) => [fmtUsd(Number(v), 2), '合計']} labelFormatter={l => l + ' 那週'} cursor={{ fill: 'rgba(242,177,53,.08)' }} />
          <Bar dataKey="total" radius={[3, 3, 0, 0]} onClick={(d: any) => setSel(d.i)} style={{ cursor: 'pointer' }} label={{ position: 'top', fill: '#9aa3b2', fontSize: 12, formatter: (v: any) => '$' + Number(v).toFixed(0) }}>
            {chart.map(c => <Cell key={c.i} fill={c.i === sel ? '#f2b135' : '#4a5263'} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 18px', alignItems: 'baseline', margin: '8px 0' }}>
        <b style={{ fontSize: 18 }}>{md(w.weekStart)} 那週 {fmtUsd(w.total, 2)}</b>
        {prev && <span className="muted">比前一週 {delta(w.total - prev.total)}</span>}
        <span className="muted">交易日平均 {fmtUsd(tradingAvg, 2)}/日（投入 {fmtUsd(w.capital)} 的 {pct(tradingAvg, w.capital)}）</span>
      </div>
      <div className="cards" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
        <table className="grid"><thead><tr><th className="l">日期</th><th className="l">星期</th><th>合計</th><th>佔投入</th></tr></thead><tbody>
          {w.days.map(d => <tr key={d.usDay} title={[...d.byPos].sort((a, b) => b.usd - a.usd).map(x => `${x.label} ${fmtUsd(x.usd, 2)}`).join('\n')}>
            <td className="l num">{md(d.usDay)}</td><td className="l">週{d.weekday}</td><td className="num">{fmtUsd(d.total, 2)}</td><td className="num muted">{pct(d.total, w.capital)}</td></tr>)}
          {w.weekend !== 0 && <tr><td className="l muted" colSpan={2}>週末</td><td className="num muted">{fmtUsd(w.weekend, 2)}</td><td></td></tr>}
          <tr><td className="l" colSpan={2}><b>一週</b></td><td className="num"><b>{fmtUsd(w.total, 2)}</b></td><td></td></tr>
        </tbody></table>
        <table className="grid"><thead><tr><th className="l">頭寸</th><th>這週</th><th>前一週</th><th>變化</th></tr></thead><tbody>
          {[...w.byPos, ...(prev?.byPos ?? []).filter(x => !w.byPos.some(y => y.id === x.id)).map(x => ({ ...x, usd: 0 }))].map(p => { const pv = prevBy.get(p.id); return <tr key={p.id}>   {/* 前一週有、這週沒有的頭寸（例如已關閉）也列出來，這週記 0（Codex review） */}
            <td className="l">{p.label}</td><td className="num">{fmtUsd(p.usd, 2)}</td><td className="num muted">{pv === undefined ? '—' : fmtUsd(pv, 2)}</td><td className="num">{pv === undefined ? '' : delta(p.usd - pv)}</td></tr> })}
        </tbody></table>
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>日期是美股交易日；每天的切點是台北 06:00 的頭寸快照（9/26 前是 07:30 掃描後）。頭寸第一筆快照含開倉以來的累積，所以開倉那週的第一天可能偏高。滑到某一天可看各頭寸明細。</div>
    </div>
  </>
}
