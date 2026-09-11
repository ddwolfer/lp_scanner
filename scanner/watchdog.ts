// scanner/watchdog.ts — 每日巡檢的判斷邏輯（純函式，D58）。原則：看產物不看 exit code；成功靜默；不確定時寧可通知。
export interface RunRow { started_at: string; finished_at: string | null; ok: number | null; degraded: number | null; alert_sent: number | null; error: string | null; pools_scanned: number | null }
export interface Facts { runsToday: RunRow[]; snapshotsToday: number; swapFailedToday: number; swapPoolsToday: number; dbError?: string }
const FIX = '補跑：cd ~/AI/lp_scanner && RPC_CONCURRENCY=2 RPC_GAP_MS=750 pnpm scan'
export interface Assessment { text: string; kinds: string[] }
/** 回傳警報（文字 + 問題種類，種類供同日去重）；null = 一切正常，保持靜默。 */
export function assess(f: Facts, now: Date, date: string, stuckHours = 3): Assessment | null {
  const gaps: string[] = []; const kinds: string[] = []; const push = (kind: string, g: string) => { kinds.push(kind); gaps.push(g) }
  if (f.dbError) return { text: `🩺 巡檢 ${date}：無法確認掃描狀態（打不開資料庫：${f.dbError.slice(0, 80)}）。請人工看 logs/scan.log。`, kinds: ['db_error'] }
  const runs = [...f.runsToday].sort((a, b) => a.started_at.localeCompare(b.started_at)); const last = runs[runs.length - 1]
  if (!last) push('not_started', `今天沒有任何掃描啟動（launchd 沒觸發？用 launchctl list | grep lp-scanner 查）→ ${FIX}`)
  else if (!last.finished_at) {
    const hrs = (now.getTime() - new Date(last.started_at).getTime()) / 3.6e6
    if (hrs >= stuckHours) push('stuck', `最後一次掃描 ${last.started_at.slice(11, 16)}Z 啟動，${hrs.toFixed(1)} 小時還沒結束，可能卡住 → 檢查 \`pgrep -fl scanner/run\`，必要時 kill 後 ${FIX}`)
    else return null   // 還在跑，下一次巡檢再看
  }
  else if (last.ok === 0) { if (!last.alert_sent) push('failed_unnotified', `最後一次掃描失敗且當時通知沒送出：${(last.error ?? '').split('\n')[0].slice(0, 120)} → ${FIX}`) }
  else if (last.degraded && !last.alert_sent) push('degraded_unnotified', `最後一次掃描資料不完整（swap 失敗 ${f.swapFailedToday}/${f.swapPoolsToday}）且通知沒送出 → ${FIX}`)
  if (last?.ok === 1 && f.snapshotsToday === 0) push('no_artifact', `掃描回報成功但今天沒有任何 pool_snapshots 列（產物缺失）→ ${FIX}`)
  if (!gaps.length) return null
  return { text: `🩺 巡檢 ${date}：發現 ${gaps.length} 個問題\n\n${gaps.map(g => '• ' + g).join('\n')}\n\n最常見原因：公用 RPC 限流（429）或 Mac 睡眠沒觸發 launchd。`, kinds }
}
