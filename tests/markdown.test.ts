import { describe, it, expect } from 'vitest'
import { parseMarkdown, parseInline, splitRow, safeHref, inlineText } from '../web/src/lib/markdown.js'

describe('備忘錄 Markdown 解析（D76）', () => {
  it('標題、段落、清單編號起點', () => {
    const b = parseMarkdown('# 標題\n第一行\n第二行\n\n3. 三\n4. 四\n\n- a\n  續行\n- b')
    expect(b[0]).toEqual({ t: 'h', level: 1, c: [{ t: 'text', v: '標題' }] })
    expect(b[1]).toEqual({ t: 'p', c: [{ t: 'text', v: '第一行 第二行' }] })
    expect(b[2]).toMatchObject({ t: 'ol', start: 3 })
    expect((b[3] as any).items.map(inlineText)).toEqual(['a 續行', 'b'])
  })
  it('fenced code 內不解析 # | **', () => {
    const b = parseMarkdown('```text\n# 不是標題\n| a | b |\n**不粗**\n```\n後文')
    expect(b[0]).toEqual({ t: 'code', lang: 'text', text: '# 不是標題\n| a | b |\n**不粗**' })
    expect(b[1].t).toBe('p')
  })
  it('表格：行內 code 與跳脫的直線不切欄、對齊', () => {
    expect(splitRow('| `a|b` | c \\| d | e |')).toEqual(['`a|b`', 'c \\| d', 'e'])
    const b = parseMarkdown('| 代幣 | 地址 |\n|:---|---:|\n| MSTR | `0xec26` |') as any
    expect(b[0].t).toBe('table'); expect(b[0].align).toEqual(['l', 'r'])
    expect(b[0].rows[0][1]).toEqual([{ t: 'code', v: '0xec26' }])
  })
  it('連結只允許 http(s)，其他協定原樣當文字', () => {
    expect(parseInline('[x](https://a.com/p?q=1)')).toEqual([{ t: 'a', href: 'https://a.com/p?q=1', c: [{ t: 'text', v: 'x' }] }])
    expect(parseInline('[x](javascript:alert(1))')).toEqual([{ t: 'text', v: '[x](javascript:alert(1))' }])
    expect(parseInline('<https://b.io>')[0]).toMatchObject({ t: 'a', href: 'https://b.io' })
    expect(safeHref('data:text/html,hi')).toBeNull()
  })
  it('粗體、行內 code、跳脫', () => {
    expect(parseInline('**粗** `**不粗**` \\*星')).toEqual([{ t: 'b', c: [{ t: 'text', v: '粗' }] }, { t: 'text', v: ' ' }, { t: 'code', v: '**不粗**' }, { t: 'text', v: ' *星' }])
    expect(parseInline('`未關閉')).toEqual([{ t: 'text', v: '`未關閉' }])
  })
  it('引言與分隔線', () => {
    const b = parseMarkdown('> **注意** 內容\n\n---') as any
    expect(b[0].t).toBe('quote'); expect(b[0].c[0].t).toBe('p'); expect(b[1].t).toBe('hr')
  })
})
