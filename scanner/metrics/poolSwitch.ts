// scanner/metrics/poolSwitch.ts — 頭寸「是否該換池」提示（DECISIONS D65），純函式。只提示、不動作（SPEC §10）
export interface PoolDay { date: string; feesUsd: number; tvlUsd: number | null; ok: boolean }   // ok=false：當天 swap 抓取失敗，跳過
export interface PoolSeries { poolId: string; label: string; swapFeeRate: number; days: PoolDay[] }   // swapFeeRate：交易者付的總費比例（含協議費）
export interface SwitchCfg { ratio: number; days: number; recover_days_max: number; cold_usd_per_day: number; cold_min_days: number; gas_usd_per_tx: number; lifecycle_txs: number; capacity_share: number }
export interface SwitchInput { held: PoolSeries; alts: PoolSeries[]; depositUsd: number; paceUsdPerDay: number | null; heldDays: number; inRange: boolean; asOf: string; cfg: SwitchCfg }   // asOf：最新快照日（不管有沒有抓到），新鮮度以它為準
export type SwitchVerdict = 'stay' | 'consider' | 'cold' | 'no_data'
export interface SwitchHint {
  verdict: SwitchVerdict; heldRate7: number | null; validDays: number
  altsPending: number   // 裝得下但資料不足/不夠新、所以還沒法比的替代池數
  best: { poolId: string; label: string; rate7: number } | null
  daysAbove: number; extraPerDay: number | null; switchCostUsd: number | null; recoverDays: number | null
}
const SLIPPAGE = 0.001
/** 日費率 = 當日 LP 實得費 ÷ 當日 TVL；只算 ok 且 TVL > 0 的日子 */
export function dailyRates(days: PoolDay[]): { date: string; rate: number }[] {
  return days.filter(d => d.ok && d.tvlUsd !== null && d.tvlUsd > 0).map(d => ({ date: d.date, rate: d.feesUsd / (d.tvlUsd as number) }))
}
/** 7 日費率 = Σ費 ÷ Σ TVL（有效日），等於以 TVL 加權的日費率平均。給 dates 時只算那些日子（held/alt 要比同一批日子，Codex plan review） */
export function rate7(days: PoolDay[], dates?: Set<string>): number | null {
  const v = days.filter(d => d.ok && d.tvlUsd !== null && d.tvlUsd > 0 && (!dates || dates.has(d.date)))
  const tvl = v.reduce((a, d) => a + (d.tvlUsd as number), 0); if (!v.length || tvl <= 0) return null
  return v.reduce((a, d) => a + d.feesUsd, 0) / tvl
}
/** 兩邊都有效的日期 */
export function commonDates(a: PoolDay[], b: PoolDay[]): string[] {
  const bs = new Set(dailyRates(b).map(r => r.date)); return dailyRates(a).map(r => r.date).filter(d => bs.has(d)).sort()
}
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000)
/** 最近 n 個「兩邊都有效」的日子裡，alt 日費率 ≥ ratio × held 的天數 */
export function daysAboveRatio(held: PoolDay[], alt: PoolDay[], ratio: number, n: number): number {
  const h = new Map(dailyRates(held).map(r => [r.date, r.rate])); const a = new Map(dailyRates(alt).map(r => [r.date, r.rate]))
  const common = [...h.keys()].filter(d => a.has(d)).sort().slice(-n)
  return common.filter(d => (a.get(d) as number) >= ratio * (h.get(d) as number)).length
}
export function switchHint(i: SwitchInput): SwitchHint {
  const heldRate = rate7(i.held.days); const validDays = dailyRates(i.held.days).length
  const empty: SwitchHint = { verdict: 'no_data', heldRate7: heldRate, validDays, altsPending: 0, best: null, daysAbove: 0, extraPerDay: null, switchCostUsd: null, recoverDays: null }
  // 冷掉的判定放在比較之後：替代池熱、自己冷是「該換」不是「冷」；出區間時費速本來就低，不判冷（Codex plan review）
  const cold = i.inRange && i.paceUsdPerDay !== null && i.heldDays >= i.cfg.cold_min_days && i.paceUsdPerDay < i.cfg.cold_usd_per_day
  if (heldRate === null || validDays < 3) return empty   // 自己的資料不足就是 no_data，不能拿「沒觀察到」當「沒有更好的池」（Codex code review）
  const heldLatest = dailyRates(i.held.days).map(r => r.date).sort().at(-1) as string
  if (daysBetween(heldLatest, i.asOf) > 2) return empty   // 自己最後一個有效日離最新快照日太遠（連續抓失敗）→ 任何結論都是舊資料，no_data（Codex code review）
  // 替代池要裝得下：最新 TVL ≥ 投入 ÷ capacity_share（預設 10 倍），否則搬過去就是在稀釋自己，費/TVL 再高也不算
  const latestTvl = (p: PoolSeries) => [...p.days].reverse().find(d => d.tvlUsd !== null)?.tvlUsd ?? 0
  // 只比共同有效日：至少 cfg.days 天，且最新共同日離「最新快照日」不超過 2 天（以快照日而不是最後一次抓到的日子為準，RPC 連續失敗時才不會拿舊資料互比，Codex code review）
  const eligible = i.alts.filter(a => latestTvl(a) >= i.depositUsd / i.cfg.capacity_share)
  const ranked = eligible
    .map(a => { const cd = commonDates(i.held.days, a.days); const fresh = cd.length >= i.cfg.days && daysBetween(cd[cd.length - 1], i.asOf) <= 2
      return { a, cd, r: fresh ? rate7(a.days, new Set(cd)) : null, h: fresh ? rate7(i.held.days, new Set(cd)) : null } })
    .filter((x): x is { a: PoolSeries; cd: string[]; r: number; h: number } => x.r !== null && x.h !== null)
    .sort((x, y) => (y.r - y.h) - (x.r - x.h) || y.r - x.r)   // 以「多出的費率」排序，held 為 0 時比值會變 Infinity/NaN（Codex code review）；同分取費率高者
  // 有裝得下的替代池但還比不了（資料不足/不夠新）→ no_data，不能說「沒有更好的池」；真的沒有可比的池才看冷不冷（Codex code review）
  const altsPending = eligible.length - ranked.length
  if (!ranked.length) return altsPending ? { ...empty, altsPending } : { ...empty, verdict: cold ? 'cold' : 'stay' }
  // 每個可比的替代池都算一次條件；有達標的就推達標裡多賺最多的，否則顯示多賺最多的（費率最高但單日暴衝的池不會擋住穩定達標的池，Codex code review）
  const evaluated = ranked.map(({ a, r, h }) => {
    const daysAbove = daysAboveRatio(i.held.days, a.days, i.cfg.ratio, i.cfg.days)
    const extraPerDay = i.depositUsd * (r - h)
    // 換池成本：出場換回一半（held 費率 + 滑價）+ 進場換一半（alt 費率 + 滑價）+ 生命週期 gas（同 lifecycleCost 的近似）
    const switchCostUsd = i.depositUsd / 2 * (i.held.swapFeeRate + SLIPPAGE) + i.depositUsd / 2 * (a.swapFeeRate + SLIPPAGE) + i.cfg.gas_usd_per_tx * i.cfg.lifecycle_txs
    const recoverDays = extraPerDay > 0 ? switchCostUsd / extraPerDay : null
    const consider = daysAbove >= i.cfg.days && recoverDays !== null && recoverDays <= i.cfg.recover_days_max
    return { a, r, h, daysAbove, extraPerDay, switchCostUsd, recoverDays, consider }
  })
  const pick = evaluated.find(e => e.consider) ?? evaluated[0]
  const { a: best, r: bestRate, h: heldOnCommon, daysAbove, extraPerDay, switchCostUsd, recoverDays, consider } = pick
  // 「冷」要比較結果也支持：最佳替代池 7 日費率沒有到 ratio 倍（沒有明顯更好的池）、也沒有還沒資料的替代池；替代池已經明顯更好但天數/回本未達標 → stay（等確認），不是 cold（Codex code review）
  const noBetterAlt = evaluated.every(e => e.r <= 0 || e.r < i.cfg.ratio * e.h)   // 所有可比池各用自己的共同日比；兩邊都零收益也算「沒有更好的池」（Codex code review）
  const verdict: SwitchVerdict = consider ? 'consider' : cold ? (altsPending ? 'no_data' : noBetterAlt ? 'cold' : 'stay') : 'stay'
  return { verdict, heldRate7: heldOnCommon, validDays, altsPending, best: { poolId: best.poolId, label: best.label, rate7: bestRate }, daysAbove, extraPerDay, switchCostUsd, recoverDays }
}
/** 日報 / 卡片用的一行文字 */
export function formatSwitchHint(h: SwitchHint | null | undefined): string | null {
  if (!h) return null
  const pct = (v: number) => (v * 100).toFixed(2) + '%/日'
  if (h.verdict === 'no_data') return h.altsPending ? `⚖️ 費/TVL 7日 ${pct(h.heldRate7 as number)}，${h.altsPending} 個替代池資料不足、待累積` : `⚖️ 費/TVL 7日 ${h.heldRate7 === null ? '—' : pct(h.heldRate7)}（資料不足 ${h.validDays} 天）`
  if (h.verdict === 'cold') return `⚖️ 量已冷：實收費速低於門檻，同股票也沒有更好的池`
  if (!h.best) return `⚖️ 費/TVL 7日 ${pct(h.heldRate7 as number)}，無可比替代池 → 留`
  const base = `⚖️ 費/TVL 7日 ${pct(h.heldRate7 as number)} vs 最佳替代 ${h.best.label} ${pct(h.best.rate7)}`
  // 多賺/成本是全池費/TVL 與「兩邊各換一半」的粗估，沒算頭寸區間與活躍流動性（Codex plan review）
  if (h.verdict === 'consider') return `${base} ×${h.daysAbove}天 → 考慮換（粗估多賺 $${(h.extraPerDay as number).toFixed(2)}/日，換池成本 $${(h.switchCostUsd as number).toFixed(2)}，${(h.recoverDays as number).toFixed(1)} 天回本）`
  return `${base} → 留`
}
