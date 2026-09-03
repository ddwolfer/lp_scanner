// db/index.ts — 開啟 SQLite 並套用 schema（idempotent）
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
export function openDb(path: string): Database.Database {
  const db = new Database(path)
  if (path !== ':memory:') db.pragma('journal_mode = WAL')
  db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'))
  migrate(db)
  return db
}
export function getMeta(db: Database.Database, key: string): string | undefined {
  return (db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | undefined)?.value
}
export function setMeta(db: Database.Database, key: string, value: string) {
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value)
}

/** 既有 DB 的欄位補齊（CREATE TABLE IF NOT EXISTS 不會加新欄位） */
function migrate(db: Database.Database) {
  const cols = new Set((db.prepare('PRAGMA table_info(pool_snapshots)').all() as { name: string }[]).map(c => c.name))
  if (!cols.has('wash_detail')) db.exec('ALTER TABLE pool_snapshots ADD COLUMN wash_detail TEXT')
}
