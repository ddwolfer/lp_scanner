// db/index.ts — 開啟 SQLite 並套用 schema（idempotent）
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
export function openDb(path: string): Database.Database {
  const db = new Database(path)
  if (path !== ':memory:') db.pragma('journal_mode = WAL')
  db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'))
  return db
}
export function getMeta(db: Database.Database, key: string): string | undefined {
  return (db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | undefined)?.value
}
export function setMeta(db: Database.Database, key: string, value: string) {
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value)
}
