// server/notes.ts — 備忘錄：讀 repo 的 notes/*.md（唯讀，D76）
// 清單與單篇共用同一個驗證：檔名白名單 + realpath 必須仍在 notes 目錄內 + 必須是一般檔案（擋 symlink 指到外面、擋目錄）
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
export const NOTE_NAME = /^[\w.-]+\.md$/
export interface NoteMeta { name: string; title: string; mtime: string }
/** 名稱合法且解析後確實在 dir 底下的一般檔案才回傳實際路徑，否則 null */
export function resolveNote(dir: string, name: string): string | null {
  if (!NOTE_NAME.test(name) || path.basename(name) !== name || name.startsWith('.')) return null
  let root: string, real: string
  try { root = realpathSync(dir); real = realpathSync(path.join(dir, name)) } catch { return null }
  // 不用字串前綴比對（notes-backup 也會以 notes 開頭），改看相對路徑
  const rel = path.relative(root, real)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) return null
  try { if (!statSync(real).isFile()) return null } catch { return null }
  return real
}
/** 第一個「# 標題」行；fenced code 裡的 # 不算 */
export function noteTitle(text: string, fallback: string): string {
  let fence = false
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) { fence = !fence; continue }
    if (!fence) { const m = line.match(/^#\s+(.+?)\s*#*\s*$/); if (m) return m[1] }
  }
  return fallback
}
export function listNotes(dir: string): NoteMeta[] {
  let names: string[]; try { names = readdirSync(dir) } catch { return [] }
  const out: NoteMeta[] = []
  for (const n of names) {
    const f = resolveNote(dir, n); if (!f) continue
    out.push({ name: n, title: noteTitle(readFileSync(f, 'utf8'), n.replace(/\.md$/, '')), mtime: statSync(f).mtime.toISOString() })
  }
  return out.sort((a, b) => b.mtime.localeCompare(a.mtime))
}
export function readNote(dir: string, name: string): string | null {
  const f = resolveNote(dir, name); return f ? readFileSync(f, 'utf8') : null
}
