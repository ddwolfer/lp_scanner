// web/src/lib/markdown.ts — 備忘錄用的極簡 Markdown 解析（D76），純函式，輸出 AST 給 React 渲染，不產生 HTML 字串
// 支援：# 標題、段落、- / 1. 清單（單層）、表格、``` 區塊、`行內 code`、**粗體**、[文字](網址)、<網址>、---、> 引言
// 不支援的語法原樣顯示成文字。連結只允許 http(s)，其他協定（javascript: 等）當成一般文字。
export type Inline = { t: 'text'; v: string } | { t: 'code'; v: string } | { t: 'b'; c: Inline[] } | { t: 'a'; href: string; c: Inline[] }
export type Block =
  | { t: 'h'; level: number; c: Inline[] }
  | { t: 'p'; c: Inline[] }
  | { t: 'ul'; items: Inline[][] }
  | { t: 'ol'; start: number; items: Inline[][] }
  | { t: 'table'; head: Inline[][]; align: ('l' | 'r' | 'c' | null)[]; rows: Inline[][][] }
  | { t: 'code'; lang: string; text: string }
  | { t: 'hr' }
  | { t: 'quote'; c: Block[] }

export const safeHref = (u: string): string | null => /^https?:\/\/[^\s]+$/i.test(u.trim()) ? u.trim() : null

/** 行內解析：先切出 `code`（內容不再解析），再處理跳脫、粗體、連結 */
export function parseInline(s: string): Inline[] {
  const out: Inline[] = []
  const push = (v: string) => { if (!v) return; const last = out[out.length - 1]; if (last?.t === 'text') last.v += v; else out.push({ t: 'text', v }) }
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (ch === '\\' && i + 1 < s.length && /[\\`*_[\]()|#<>-]/.test(s[i + 1])) { push(s[i + 1]); i += 2; continue }
    if (ch === '`') {
      let n = 1; while (s[i + n] === '`') n++
      const fence = '`'.repeat(n), end = s.indexOf(fence, i + n)
      if (end > 0) { out.push({ t: 'code', v: s.slice(i + n, end).replace(/^ (.*) $/, '$1') }); i = end + n; continue }
      push(fence); i += n; continue
    }
    if (s.startsWith('**', i)) {
      const end = s.indexOf('**', i + 2)
      if (end > i + 2) { out.push({ t: 'b', c: parseInline(s.slice(i + 2, end)) }); i = end + 2; continue }
    }
    if (ch === '[') {
      const m = s.slice(i).match(/^\[([^\]]+)\]\(([^)\s]+)\)/)
      if (m) { const href = safeHref(m[2]); if (href) out.push({ t: 'a', href, c: parseInline(m[1]) }); else push(m[0]); i += m[0].length; continue }
    }
    if (ch === '<') {
      const m = s.slice(i).match(/^<(https?:\/\/[^>\s]+)>/i)
      if (m) { out.push({ t: 'a', href: m[1], c: [{ t: 'text', v: m[1] }] }); i += m[0].length; continue }
    }
    push(ch); i++
  }
  return out
}

/** 表格列切欄：`code` 內與 \| 跳脫的直線不算分隔 */
export function splitRow(line: string): string[] {
  let s = line.trim(); if (s.startsWith('|')) s = s.slice(1); if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  const cells: string[] = []; let cur = '', inCode = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\' && s[i + 1] === '|' && !inCode) { cur += '\\|'; i++; continue }
    if (c === '`') inCode = !inCode
    if (c === '|' && !inCode) { cells.push(cur.trim()); cur = ''; continue }
    cur += c
  }
  cells.push(cur.trim()); return cells
}
const SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/
const UL = /^\s{0,3}[-*+]\s+(.*)$/, OL = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/, FENCE = /^\s{0,3}(`{3,})\s*([\w-]*)\s*$/

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n'); const out: Block[] = []; let i = 0
  const blank = (l: string | undefined) => l === undefined || l.trim() === ''
  const startsBlock = (l: string, next?: string) => FENCE.test(l) || /^#{1,6}\s/.test(l) || UL.test(l) || OL.test(l) || /^\s*>/.test(l) || /^\s*(-{3,}|\*{3,})\s*$/.test(l) || (l.includes('|') && next !== undefined && SEP.test(next))
  while (i < lines.length) {
    const l = lines[i]
    if (blank(l)) { i++; continue }
    const f = l.match(FENCE)
    if (f) {
      const body: string[] = []; i++
      while (i < lines.length && !new RegExp(`^\\s{0,3}${f[1]}\`*\\s*$`).test(lines[i])) body.push(lines[i++])
      i++; out.push({ t: 'code', lang: f[2], text: body.join('\n') }); continue
    }
    const h = l.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (h) { out.push({ t: 'h', level: h[1].length, c: parseInline(h[2]) }); i++; continue }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(l)) { out.push({ t: 'hr' }); i++; continue }
    if (l.includes('|') && lines[i + 1] !== undefined && SEP.test(lines[i + 1])) {
      const head = splitRow(l), align = splitRow(lines[i + 1]).map(c => c.startsWith(':') && c.endsWith(':') ? 'c' as const : c.endsWith(':') ? 'r' as const : c.startsWith(':') ? 'l' as const : null)
      i += 2; const rows: Inline[][][] = []
      while (i < lines.length && !blank(lines[i]) && lines[i].includes('|')) { const r = splitRow(lines[i++]); rows.push(head.map((_, k) => parseInline(r[k] ?? ''))) }
      out.push({ t: 'table', head: head.map(parseInline), align, rows }); continue
    }
    if (/^\s*>/.test(l)) {
      const body: string[] = []; while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''))
      out.push({ t: 'quote', c: parseMarkdown(body.join('\n')) }); continue
    }
    const isUl = UL.test(l), om = l.match(OL)
    if (isUl || om) {
      const re = isUl ? UL : OL; const items: string[] = []
      while (i < lines.length) {
        const cur = lines[i], m = cur.match(re)
        if (m) { items.push(isUl ? m[1] : m[2]); i++; continue }
        // 縮排的續行併進上一項；空行後若下一行還是同類清單項就繼續
        if (!blank(cur) && /^\s{2,}\S/.test(cur) && items.length) { items[items.length - 1] += ' ' + cur.trim(); i++; continue }
        if (blank(cur) && lines[i + 1] !== undefined && re.test(lines[i + 1])) { i++; continue }
        break
      }
      const parsed = items.map(parseInline)
      out.push(isUl ? { t: 'ul', items: parsed } : { t: 'ol', start: Number(om![1]), items: parsed }); continue
    }
    const para: string[] = [l.trim()]; i++
    while (i < lines.length && !blank(lines[i]) && !startsBlock(lines[i], lines[i + 1])) para.push(lines[i++].trim())
    out.push({ t: 'p', c: parseInline(para.join(' ')) })
  }
  return out
}
/** 把行內節點攤平成純文字（複製、標題用） */
export const inlineText = (c: Inline[]): string => c.map(x => x.t === 'text' || x.t === 'code' ? x.v : inlineText(x.c)).join('')
