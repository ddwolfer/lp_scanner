import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resolveNote, listNotes, readNote, noteTitle } from '../server/notes.js'

describe('備忘錄檔案存取（D76）', () => {
  let root: string, dir: string
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'notes-'))
    dir = path.join(root, 'notes'); mkdirSync(dir)
    mkdirSync(path.join(root, 'notes-backup'))
    writeFileSync(path.join(root, 'notes-backup', 'leak.md'), '# 不該被讀到')
    writeFileSync(path.join(root, 'secret.md'), '# 秘密')
    writeFileSync(path.join(dir, 'a.md'), '前言\n```\n# 不是標題\n```\n# 第一篇\n內容')
    writeFileSync(path.join(dir, 'b.md'), '沒有標題')
    writeFileSync(path.join(dir, 'c.txt'), '# 不是 md')
    mkdirSync(path.join(dir, 'dir.md'))
    symlinkSync(path.join(root, 'secret.md'), path.join(dir, 'link.md'))
    symlinkSync(path.join(root, 'notes-backup', 'leak.md'), path.join(dir, 'leak.md'))
    utimesSync(path.join(dir, 'a.md'), new Date('2026-10-01'), new Date('2026-10-01'))
    utimesSync(path.join(dir, 'b.md'), new Date('2026-10-02'), new Date('2026-10-02'))
  })
  it('只回 notes 目錄內的一般 .md 檔', () => {
    expect(resolveNote(dir, 'a.md')).toBeTruthy()
    for (const bad of ['../secret.md', '..%2Fsecret.md', 'c.txt', 'dir.md', 'link.md', 'leak.md', '.hidden.md', 'none.md', '']) expect(resolveNote(dir, bad)).toBeNull()
  })
  it('清單也套用同一個驗證：不含 symlink 外洩、目錄、非 md；依修改時間新到舊', () => {
    const l = listNotes(dir)
    expect(l.map(x => x.name)).toEqual(['b.md', 'a.md'])
    expect(l.find(x => x.name === 'a.md')!.title).toBe('第一篇')
    expect(l.find(x => x.name === 'b.md')!.title).toBe('b')
  })
  it('讀單篇與標題解析', () => {
    expect(readNote(dir, 'a.md')).toContain('# 第一篇')
    expect(readNote(dir, 'link.md')).toBeNull()
    expect(noteTitle('## 二級\n# 一級 #', 'x')).toBe('一級')
    expect(listNotes(path.join(root, 'nope'))).toEqual([])
  })
})
