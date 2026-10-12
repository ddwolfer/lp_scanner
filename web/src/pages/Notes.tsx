// web/src/pages/Notes.tsx — 備忘錄（D76）：notes/*.md 清單 + 內容。只讀，不送任何交易
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { NavLink, useParams } from 'react-router-dom'
import { api } from '../api'
import { parseMarkdown, type Block, type Inline } from '../lib/markdown'
type NoteMeta = { name: string; title: string; mtime: string }

/** 複製文字：區網 http 不是安全來源，Clipboard API 可能不存在或被拒，退回 execCommand；兩者都失敗回 false，不假裝成功 */
async function copyText(text: string): Promise<boolean> {
  try { if (window.isSecureContext && navigator.clipboard) { await navigator.clipboard.writeText(text); return true } } catch { /* 改用備援 */ }
  try {
    const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0'
    document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); document.body.removeChild(ta); return ok
  } catch { return false }
}
function CopyBtn({ text }: { text: string }) {
  const [s, setS] = useState<'idle' | 'ok' | 'fail'>('idle')
  return <button type="button" className={`copy ${s}`} title="複製原文" onClick={async () => { setS(await copyText(text) ? 'ok' : 'fail'); setTimeout(() => setS('idle'), 1800) }}>
    {s === 'ok' ? '已複製' : s === 'fail' ? '請手動選取' : '複製'}
  </button>
}
function renderInline(c: Inline[], key = ''): ReactNode[] {
  return c.map((x, i) => {
    const k = key + i
    if (x.t === 'text') return <span key={k}>{x.v}</span>
    if (x.t === 'b') return <strong key={k}>{renderInline(x.c, k + '-')}</strong>
    if (x.t === 'a') return <a key={k} href={x.href} target="_blank" rel="noopener noreferrer">{renderInline(x.c, k + '-')}</a>
    // 長的行內 code（地址、數字）旁邊放複製鍵，方便貼到 Blockscout
    return x.v.length >= 20 ? <span key={k} className="icode-wrap"><code className="icode">{x.v}</code><CopyBtn text={x.v} /></span> : <code key={k} className="icode">{x.v}</code>
  })
}
function renderBlocks(bs: Block[], key = ''): ReactNode[] {
  return bs.map((b, i) => {
    const k = key + i
    switch (b.t) {
      case 'h': { const H = (`h${Math.min(b.level + 1, 6)}`) as 'h2'; return <H key={k} className={`md-h md-h${b.level}`}>{renderInline(b.c)}</H> }
      case 'p': return <p key={k}>{renderInline(b.c)}</p>
      case 'ul': return <ul key={k}>{b.items.map((it, j) => <li key={j}>{renderInline(it)}</li>)}</ul>
      case 'ol': return <ol key={k} start={b.start}>{b.items.map((it, j) => <li key={j}>{renderInline(it)}</li>)}</ol>
      case 'hr': return <hr key={k} />
      case 'quote': return <blockquote key={k}>{renderBlocks(b.c, k + '-')}</blockquote>
      case 'code': return <div key={k} className="md-code"><CopyBtn text={b.text} /><pre><code>{b.text}</code></pre></div>
      case 'table': return <div key={k} className="md-table"><table>
        <thead><tr>{b.head.map((h, j) => <th key={j} style={{ textAlign: b.align[j] === 'r' ? 'right' : b.align[j] === 'c' ? 'center' : 'left' }}>{renderInline(h)}</th>)}</tr></thead>
        <tbody>{b.rows.map((r, j) => <tr key={j}>{r.map((c, m) => <td key={m} style={{ textAlign: b.align[m] === 'r' ? 'right' : b.align[m] === 'c' ? 'center' : 'left' }}>{renderInline(c)}</td>)}</tr>)}</tbody>
      </table></div>
    }
  })
}
export default function Notes() {
  const { name } = useParams()
  const [list, setList] = useState<NoteMeta[] | null>(null); const [listErr, setListErr] = useState<string | null>(null)
  const [text, setText] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null)
  useEffect(() => { api<NoteMeta[]>('/api/notes').then(setList).catch(e => { setList([]); setListErr(String(e)) }) }, [])
  const current = name ?? list?.[0]?.name
  useEffect(() => {
    if (!current) return
    // 換篇時清掉上一篇的錯誤；快速切換時中止舊請求，舊回應不會蓋掉目前這篇（Codex code review）
    setText(null); setErr(null); const ac = new AbortController()
    fetch(`/api/notes/${encodeURIComponent(current)}`, { signal: ac.signal })
      .then(async r => { if (!r.ok) throw new Error(r.status === 404 ? '找不到這篇筆記' : `${r.status}`); const t = await r.text(); if (!ac.signal.aborted) setText(t) })
      .catch(e => { if (!ac.signal.aborted) setErr(String(e?.message ?? e)) })
    return () => ac.abort()
  }, [current])
  const blocks = useMemo(() => text === null ? [] : parseMarkdown(text), [text])
  return <div className="notes">
    <aside className="notes-list">
      <h2>備忘錄</h2>
      {listErr ? <div className="alert">{listErr}</div> : list === null ? <div className="muted">載入中…</div> : list.length === 0 ? <div className="muted">notes/ 目錄沒有筆記</div> :
        list.map(n => <NavLink key={n.name} to={`/notes/${encodeURIComponent(n.name)}`} className={() => n.name === current ? 'active' : ''}>
          <span>{n.title}</span><small className="num">{n.mtime.slice(0, 10)}</small>
        </NavLink>)}
    </aside>
    <article className="md card">
      {err ? <div className="alert">{err}</div> : text === null ? <div className="muted">{current ? '載入中…' : ''}</div> : renderBlocks(blocks)}
    </article>
  </div>
}
