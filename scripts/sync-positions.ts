// scripts/sync-positions.ts — 立刻從鏈上同步 TRACK_ADDRESS 的頭寸（開完倉不用等隔天）
import 'dotenv/config'
import { openDb } from '../db/index.js'
import { ApiUsage } from '../scanner/sources/usage.js'
import { runPositionsStage } from '../scanner/positionsStage.js'
import { taipeiDate } from '../scanner/time.js'
import { listPositions } from '../server/queries.js'
const addr = process.env.TRACK_ADDRESS; if (!addr) { console.log('TRACK_ADDRESS 未設定'); process.exit(1) }
const db = openDb('db/lp.sqlite'); const now = new Date(); const usage = new ApiUsage()
await runPositionsStage(db, usage, addr, taipeiDate(now), now, m => console.log(m))
for (const p of listPositions(db)) if (!p.closed_at) console.log(`${p.label}  區間 ${p.range_lower.toFixed(2)}–${p.range_upper.toFixed(2)}  投入 $${p.deposit_usd.toFixed(2)}  現值 $${p.actual?.value_usd.toFixed(2)}  未領費 $${p.actual?.fees_cum_usd.toFixed(2)}  淨 ${p.actual ? (p.actual.net_usd >= 0 ? '+' : '') + p.actual.net_usd.toFixed(2) : '—'}  ${p.actual?.in_range ? '在區間' : '出區間'}`)
console.log('api_calls', usage.toJSON()); db.close()
