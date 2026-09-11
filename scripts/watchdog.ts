// scripts/watchdog.ts — 獨立於掃描器的每日巡檢（launchd com.lp-scanner.watchdog，10:30 與 13:30 台北）。有問題才送 Telegram（D58）
import 'dotenv/config'
import { openDb, getMeta, setMeta } from '../db/index.js'
import { assess, type Facts } from '../scanner/watchdog.js'
import { sendTelegram } from '../scanner/notify/telegram.js'
import { taipeiDate } from '../scanner/time.js'
const now = new Date(); const date = taipeiDate(now); const dayStartUtc = new Date(date + 'T00:00:00+08:00').toISOString()
let facts: Facts; let dbRef: ReturnType<typeof openDb> | null = null
try {
  const db = openDb('db/lp.sqlite')   // 走 openDb 才會套 migrate（degraded / alert_sent 欄位）
  const runsToday = db.prepare(`SELECT started_at, finished_at, ok, degraded, alert_sent, error, pools_scanned FROM scan_runs WHERE started_at >= ? ORDER BY started_at`).all(dayStartUtc) as any[]
  const snap = db.prepare(`SELECT COUNT(*) n, SUM(CASE WHEN flags LIKE '%swap_fetch_failed%' THEN 1 ELSE 0 END) f FROM pool_snapshots WHERE date=?`).get(date) as any
  const swapPools = (db.prepare(`SELECT COUNT(*) n FROM pool_snapshots WHERE date=? AND (swap_count > 0 OR flags LIKE '%swap_fetch_failed%')`).get(date) as any).n
  facts = { runsToday, snapshotsToday: snap.n, swapFailedToday: snap.f ?? 0, swapPoolsToday: swapPools }; dbRef = db
} catch (e) { facts = { runsToday: [], snapshotsToday: 0, swapFailedToday: 0, swapPoolsToday: 0, dbError: String((e as Error).message ?? e) } }
const a = assess(facts, now, date)
if (!a) { console.log(`[${now.toISOString()}] watchdog ok`); dbRef?.close(); process.exit(0) }
// 同一天同一組問題只送一次（agent_flow_studio 提醒：10:30 與 13:30 重複告警會訓練人忽略）；狀態變好會自然靜默
const key = `watchdog_alert:${date}:${[...a.kinds].sort().join(',')}`
if (dbRef && getMeta(dbRef, key)) { console.log(`[${now.toISOString()}] watchdog ALERT (already sent today, skip)`); dbRef.close(); process.exit(0) }
console.log(`[${now.toISOString()}] watchdog ALERT\n${a.text}`)
const r = await sendTelegram(a.text, { token: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID, topicId: process.env.TELEGRAM_TOPIC_ID }).catch(e => `error: ${e}`)
if (r === 'sent' && dbRef) setMeta(dbRef, key, now.toISOString())
dbRef?.close(); console.log('telegram', r)
