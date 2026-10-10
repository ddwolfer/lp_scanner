// scripts/sync-positions.ts — 立刻從鏈上同步 TRACK_ADDRESS 的頭寸（開完倉不用等隔天）。
// D66：預設不覆蓋當天已有的快照（06:00 排程寫的是每日切點）；`--snapshot` 強制覆蓋，06:00 的 launchd 用它
// D75：`--daily` 給排程用（06:00 起每兩小時一次）：當天還沒成功就強制寫快照並把頭寸日報送 TG，成功後當天其他次直接跳過；網路斷線時下一次再補
import 'dotenv/config'
import { openDb, getMeta, setMeta } from '../db/index.js'
import { ApiUsage } from '../scanner/sources/usage.js'
import { runPositionsStage } from '../scanner/positionsStage.js'
import { taipeiDate } from '../scanner/time.js'
import { listPositions } from '../server/queries.js'
const addr = process.env.TRACK_ADDRESS; if (!addr) { console.log('TRACK_ADDRESS 未設定'); process.exit(1) }
const db = openDb('db/lp.sqlite'); const now = new Date(); const usage = new ApiUsage()
const daily = process.argv.includes('--daily'); const today = taipeiDate(now)
if (daily && getMeta(db, 'daily_positions_done') === today) { console.log(`daily positions already done for ${today}`); process.exit(0) }
const vals = await runPositionsStage(db, usage, addr, today, now, m => console.log(m), process.argv.includes('--snapshot') || daily ? 'force' : 'if_missing')
const live = new Map(vals.map(v => [v.positionId, v]))   // D69：印這次同步讀到的即時值，不是當天 06:00 的快照（Codex review）
// 淨損益用「現在」的投入與已領費，快照後的加倉、領費也算進去（Codex review）
for (const p0 of listPositions(db)) if (!p0.closed_at) { const v = live.get(p0.id); const p = v && p0.actual ? { ...p0, actual: { ...p0.actual, value_usd: v.valueUsd, fees_cum_usd: v.feesUsd, in_range: v.inRange, net_usd: v.valueUsd + v.feesUsd + p0.liveBasis.withdrawn_usd - p0.liveBasis.capital_usd } } : p0; console.log(`${p.label}  區間 ${p.range_lower.toFixed(2)}–${p.range_upper.toFixed(2)}  投入 $${p.deposit_usd.toFixed(2)}  現值 $${p.actual?.value_usd.toFixed(2)}  未領費 $${p.actual?.fees_cum_usd.toFixed(2)}  淨 ${p.actual ? (p.actual.net_usd >= 0 ? '+' : '') + p.actual.net_usd.toFixed(2) : '—'}  ${p.actual?.in_range ? '在區間' : '出區間'}`) }
{ const { walletLine } = await import('../scanner/run.js'); const wl = walletLine(db, taipeiDate(now)); if (wl) console.log(wl) }
if (daily) {
  const { formatPositions, formatFeesTotal, formatApr, walletLine } = await import('../scanner/run.js')
  const { formatPositionsOnly } = await import('../scanner/notify/summary.js'); const { sendTelegram } = await import('../scanner/notify/telegram.js')
  // 星期用日期本身算（getUTCDay），不受主機時區影響（Codex review）
  const l = listPositions(db); const t = formatFeesTotal(l), a = formatApr(l), w = walletLine(db, today)
  const hr = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', hour: 'numeric', hourCycle: 'h23' }).format(now))
  const text = formatPositionsOnly({ date: today, weekdayZh: ['日', '一', '二', '三', '四', '五', '六'][new Date(today + 'T12:00:00Z').getUTCDay()], positions: [...formatPositions(l), ...(t ? [t] : []), ...(a ? [a] : []), ...(w ? [w] : [])],
    note: hr >= 7 ? `（${String(hr).padStart(2, '0')}:00 補跑：06:00 那次沒成功，昨日費的時數見括號）` : undefined, dashboardUrl: process.env.DASHBOARD_URL })
  const sent = await sendTelegram(text, { token: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID, topicId: process.env.TELEGRAM_TOPIC_ID })
  console.log('telegram', sent); if (sent === 'sent') setMeta(db, 'daily_positions_done', today)   // 送出才算完成，否則下一次排程再試
}
console.log('api_calls', usage.toJSON()); db.close()
process.exit(0)   // D74：補查開倉交易逾時後底下的公用 RPC 呼叫可能還在退避，不等它
