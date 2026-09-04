import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend, ReferenceDot } from 'recharts'
import { api, fmtNum, fmtPct, fmtUsd, ZERO } from '../api'
import { FlagChips } from '../components/bits'
const tsFmt = (t: number) => new Date(t * 1000).toISOString().slice(5, 16).replace('T', ' ')
const C = { tvl: '#6db3f2', vol: '#f2b135', fee: '#4fd18b', pool: '#f2b135', ref: '#98a1ad', r10: '#f0625d', r25: '#f2b135', rvol: '#4fd18b' }
export default function Pool() {
  const { id } = useParams(); const [d, setD] = useState<any>(null); const [err, setErr] = useState('')
  useEffect(() => { api<any>(`/api/pool/${id}`).then(setD).catch(e => setErr(String(e))) }, [id])
  if (err) return <p className="neg">{err}</p>
  if (!d) return <p className="muted">載入中…</p>
  const { pool, snapshots, hourly, curves, corporateActions, latest } = d
  const sim = latest?.sim; const wash = latest?.wash_detail
  const pending = corporateActions.filter((c: any) => c.status.includes('IN_PROGRESS'))
  const merged = curves ? curves.r25.map((p: any, i: number) => ({ ts: p.ts, r10: curves.r10[i]?.net, r25: p.net, rvol: curves.rvol[i]?.net })) : []
  const exits: { k: "r10" | "r25" | "rvol"; ts: number; net: number }[] = curves ? (['r10', 'r25', 'rvol'] as const).flatMap(k => curves[k].filter((p: any, i: number) => i > 0 && curves[k][i - 1].inRange && !p.inRange).map((p: any) => ({ k, ts: p.ts, net: p.net }))) : []
  return <>
    <p className="muted"><Link to="/">← 總覽</Link></p>
    <h1><span className="sym">{pool.symbol}</span>/USDG <span className="chip">{pool.protocol}</span> <span className="chip num">{pool.fee_ppm === null ? '動態費率' : (pool.fee_ppm / 1e4).toFixed(3) + '%'}</span>{pool.hooks !== ZERO && <span className="chip hooks">hooks {pool.hooks.slice(0, 10)}</span>}</h1>
    <div className="muted num" style={{ fontSize: 14 }}>{pool.pool_id}</div>
    {pending.length > 0 && <div className="alert">⚠️ 公司行動進行中：{pending.map((c: any) => `${c.type.replace('CORPORATE_ACTION_TYPE_', '')} ${c.effective_at}`).join('、')}</div>}
    <div className="cards" style={{ marginTop: 10 }}>
      <div className="card"><dl className="kv">
        <dt>代幣</dt><dd>{pool.token_name}</dd><dt>Robinhood 狀態</dt><dd>{pool.rh_status?.replace('ASSET_STATUS_', '')}</dd>
        <dt>24/5 可交易</dt><dd>{pool.all_day_tradable ?? '—'}</dd><dt>multiplier</dt><dd>{pool.current_multiplier ?? '—'}</dd>
        <dt>開池</dt><dd>{pool.created_at?.slice(0, 10)} <span className="muted">block {pool.created_block}</span></dd>
      </dl></div>
      <div className="card"><dl className="kv">
        <dt>最新快照</dt><dd>{latest?.date ?? '—'}</dd><dt>TVL</dt><dd>{fmtUsd(latest?.tvl_usd)}</dd><dt>24h 量 / 費</dt><dd>{fmtUsd(latest?.volume_24h_usd)} / {fmtUsd(latest?.fees_24h_usd, 1)}</dd>
        <dt>池價 / 參考價</dt><dd>{fmtNum(latest?.price_usd, 3)} / {fmtNum(latest?.price_ref_usd, 3)} <span className={Math.abs(latest?.price_dev_pct ?? 0) > 0.03 ? 'warn' : ''}>({fmtPct(latest?.price_dev_pct, 2)})</span></dd>
        <dt>flags</dt><dd><FlagChips flags={latest?.flags ?? []} max={8} /></dd>
      </dl></div>
      <div className="card"><h2 style={{ margin: '0 0 6px' }}>模擬（$1000，{sim?.meta?.hours ?? 0} 小時）</h2>
        {sim ? <table className="grid"><thead><tr><th className="l">區間</th><th>手續費</th><th>IL</th><th>淨損益</th><th>net APR</th><th>在區間</th><th>出區間</th></tr></thead><tbody>
          {(['r10', 'r25', 'rvol'] as const).map(k => { const s = sim.d1000[k]; return <tr key={k}><td className="l">{k === 'rvol' ? `vol ±${(sim.meta.rvol_R * 100).toFixed(0)}%` : k === 'r10' ? '±10%' : '±25%'}</td><td className="num">{fmtUsd(s.fees_usd, 1)}</td><td className="num neg">{fmtUsd(s.il_usd, 1)}</td><td className={'num ' + (s.net_usd >= 0 ? 'pos' : 'neg')}>{fmtUsd(s.net_usd, 1)}</td><td className="num">{fmtPct(s.net_apr)}</td><td className="num">{fmtPct(s.in_range_pct)}</td><td className="num">{s.exits}</td></tr> })}
        </tbody></table> : <span className="muted">未模擬（被硬排除或無資料）</span>}
      </div>
    </div>
    <h2>30 天 TVL / 成交量 / 手續費</h2>
    <div className="charts">
      <div className="chart"><div className="t">每日快照</div><ResponsiveContainer width="100%" height={220}><LineChart data={snapshots}><CartesianGrid stroke="#262b34" /><XAxis dataKey="date" tickFormatter={v => v.slice(5)} /><YAxis yAxisId="l" width={60} tickFormatter={v => '$' + (v / 1000).toFixed(0) + 'k'} /><YAxis yAxisId="r" orientation="right" width={50} tickFormatter={v => '$' + v.toFixed(0)} /><Tooltip /><Legend />
        <Line yAxisId="l" type="monotone" dataKey="tvl_usd" name="TVL" stroke={C.tvl} dot={false} /><Line yAxisId="l" type="monotone" dataKey="volume_24h_usd" name="成交量" stroke={C.vol} dot={false} /><Line yAxisId="r" type="monotone" dataKey="fees_24h_usd" name="手續費" stroke={C.fee} dot={false} /></LineChart></ResponsiveContainer></div>
      <div className="chart"><div className="t">價格：池價 vs Robinhood 參考價</div><ResponsiveContainer width="100%" height={220}><LineChart data={snapshots}><CartesianGrid stroke="#262b34" /><XAxis dataKey="date" tickFormatter={v => v.slice(5)} /><YAxis domain={['auto', 'auto']} width={60} /><Tooltip /><Legend />
        <Line type="monotone" dataKey="price_usd" name="池價" stroke={C.pool} dot={false} /><Line type="monotone" dataKey="price_ref_usd" name="參考價" stroke={C.ref} dot={false} strokeDasharray="4 3" /></LineChart></ResponsiveContainer></div>
    </div>
    <h2>三種區間的模擬累積淨損益（$1000）</h2>
    <div className="chart"><div className="t">小時級 · ● = 出區間時點</div><ResponsiveContainer width="100%" height={260}><LineChart data={merged}><CartesianGrid stroke="#262b34" /><XAxis dataKey="ts" tickFormatter={tsFmt} minTickGap={40} /><YAxis width={60} tickFormatter={v => '$' + v.toFixed(0)} /><Tooltip labelFormatter={v => tsFmt(Number(v))} /><Legend />
      <Line type="monotone" dataKey="r10" name="±10%" stroke={C.r10} dot={false} /><Line type="monotone" dataKey="r25" name="±25%" stroke={C.r25} dot={false} /><Line type="monotone" dataKey="rvol" name="vol" stroke={C.rvol} dot={false} />
      {exits.map((e, i) => <ReferenceDot key={i} x={e.ts} y={e.net} r={4} fill={C[e.k]} stroke="none" />)}</LineChart></ResponsiveContainer></div>
    <div className="charts" style={{ marginTop: 14 }}>
      <div className="card"><h2 style={{ margin: '0 0 6px' }}>刷量分析{wash?.sampled && <span className="chip">取樣</span>}</h2>
        {wash ? <><dl className="kv"><dt>交易者</dt><dd>{latest.trader_count}</dd><dt>top1 佔比</dt><dd>{fmtPct(latest.top1_share)}</dd><dt>對打比例</dt><dd>{fmtPct(latest.pingpong_ratio)}</dd><dt>LP 重疊</dt><dd>{latest.lp_trader_overlap} 個地址，成交量 {fmtPct(latest.lp_overlap_volume_share)}</dd></dl>
          <table className="grid" style={{ marginTop: 8 }}><thead><tr><th className="l">地址</th><th>筆數</th><th>買/賣</th><th>佔比</th></tr></thead><tbody>{wash.topTraders.map((t: any) => <tr key={t.addr}><td className="l num">{t.addr.slice(0, 10)}…{t.addr.slice(-4)}</td><td className="num">{t.n}</td><td className="num">{t.buy}/{t.sell}</td><td className="num">{fmtPct(t.share, 1)}</td></tr>)}</tbody></table>
          <div className="num muted" style={{ fontSize: 13, marginTop: 8, lineHeight: 1.6 }}>{Object.entries(wash.hourly).map(([h, n]) => <div key={h}>{h.slice(5)} {'█'.repeat(Math.min(Number(n), 60))} {String(n)}</div>)}</div></> : <span className="muted">只有前 20 名池有刷量分析</span>}
      </div>
      <div className="card"><h2 style={{ margin: '0 0 6px' }}>公司行動</h2>
        {corporateActions.length ? <table className="grid"><thead><tr><th className="l">類型</th><th className="l">狀態</th><th>生效日</th><th>multiplier</th></tr></thead><tbody>{corporateActions.map((c: any) => <tr key={c.id}><td className="l">{c.type.replace('CORPORATE_ACTION_TYPE_', '')}</td><td className="l">{c.status.replace('CORPORATE_ACTION_STATUS_', '')}</td><td className="num">{c.effective_at}</td><td className="num">{c.pending_multiplier || '—'}</td></tr>)}</tbody></table> : <span className="muted">無</span>}
      </div>
    </div>
    <p className="muted" style={{ marginTop: 14 }}>小時資料 {hourly.length} 列</p>
  </>
}
