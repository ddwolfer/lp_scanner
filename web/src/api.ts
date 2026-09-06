export type SimResult = { fees_usd: number; value_end_usd: number; il_usd: number; net_usd: number; net_pct: number; net_apr: number; in_range_hours: number; in_range_pct: number; exits: number; hours: number; fees_trimmed_usd?: number; net_trimmed_usd?: number; net_apr_trimmed?: number; top_hour_share?: number; trimmed_hours?: number }
export type SimJson = { meta: { hours: number; sigma7: number | null; rvol_R: number }; d200: any; d1000: any; d5000: any }
export type Row = {
  pool_id: string; symbol: string; protocol: string; fee_ppm: number | null; fee_ppm_observed: number | null; hooks: string; hook_kind: 'none' | 'fee_only' | 'liquidity' | null; hook_flags: string[]; age_days: number | null
  tvl_usd: number | null; volume_24h_usd: number; fees_24h_usd: number; vol7_avg_usd: number; vol7_cv: number
  trader_count: number | null; top1_share: number | null; price_usd: number | null; price_ref_usd: number | null; price_dev_pct: number | null
  raw_apr: number | null; score: number | null; excluded: number; flags: string[]; sim: SimJson | null; all_day_tradable: string | null
  vol_6h_usd: number | null; heat_6h: number | null
  rank_today: number | null; rank_prev: number | null
}
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { headers: { 'content-type': 'application/json' }, ...init })
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`)
  return r.json()
}
export const ZERO = '0x0000000000000000000000000000000000000000'
export const fmtUsd = (v: number | null | undefined, d = 0) => v === null || v === undefined ? '—' : '$' + v.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d })
export const fmtPct = (v: number | null | undefined, d = 0) => v === null || v === undefined ? '—' : (v * 100).toFixed(d) + '%'
export const fmtNum = (v: number | null | undefined, d = 2) => v === null || v === undefined ? '—' : v.toFixed(d)
export const simOf = (r: Row, D: string, R: string): SimResult | null => r.sim?.[D as 'd1000']?.[R] ?? null

export const HOOK_ZH: Record<string, string> = { beforeInitialize: '初始化前', afterInitialize: '初始化後', beforeAddLiquidity: '加流動性前', afterAddLiquidity: '加流動性後', beforeRemoveLiquidity: '移除流動性前', afterRemoveLiquidity: '移除流動性後', beforeSwap: '交易前', afterSwap: '交易後', beforeDonate: '捐款前', afterDonate: '捐款後', beforeSwapReturnsDelta: '交易前改帳', afterSwapReturnsDelta: '交易後改帳', afterAddLiquidityReturnsDelta: '加流動性改帳', afterRemoveLiquidityReturnsDelta: '移除流動性改帳' }
export const HOOK_GROUPS: { zh: string; keys: string[]; note: string }[] = [
  { zh: '交易類（只能改費率或拒絕交易）', keys: ['beforeInitialize', 'afterInitialize', 'beforeSwap', 'afterSwap'], note: '碰不到本金' },
  { zh: '流動性類（可擋你進出）', keys: ['beforeAddLiquidity', 'afterAddLiquidity', 'beforeRemoveLiquidity', 'afterRemoveLiquidity', 'beforeDonate', 'afterDonate'], note: '有任一項即排除' },
  { zh: '改帳類（可拿走金額）', keys: ['beforeSwapReturnsDelta', 'afterSwapReturnsDelta', 'afterAddLiquidityReturnsDelta', 'afterRemoveLiquidityReturnsDelta'], note: '有任一項即排除' },
]
export const feeLabel = (fee_ppm: number | null, observed: number | null) => fee_ppm !== null ? (fee_ppm / 1e4).toFixed(2) + '%' : observed !== null ? '~' + (observed / 1e4).toFixed(2) + '%' : '動態'

/** 手續費年化：只算修剪後手續費 ÷ 投入，不含股價漲跌與 IL */
export const feeApr = (s: SimResult | null, D: string): number | null => {
  if (!s || !s.hours) return null
  const dep = Number(D.replace('d', '')); const fees = s.fees_trimmed_usd ?? s.fees_usd
  return fees / dep * 365 / (s.hours / 24)
}

/** 欄位說明（總覽表頭 tooltip 與「欄位說明」面板共用） */
export const COL_HELP: Record<string, string> = {
  rank_today: '今日排名：依 score 由高到低，只排未被硬排除的池。',
  arrow: '昨→今：昨天的排名與方向。NEW = 昨天不在候選內。',
  symbol: '池：股票代幣 / USDG、協議（v3 或 v4）、費率。hook·費率 = 只能改費率的 hook（可放行）；hook·流動性 = 能碰本金的 hook（一律排除）。',
  tvl_usd: 'TVL：池子總鎖倉美元。低於 $5,000 排除。只當門檻，不進評分。',
  vol7_avg_usd: '7 日均量：最近 7 個快照的日成交量平均（不足 7 天用現有天數）。',
  vol7_cv: 'CV：成交量穩定度 = 平日成交量的標準差 ÷ 平均。0 最穩，>1 表示忽高忽低。週末不計入；平日樣本 < 3 顯示 —。評分佔 15%，越低越好。',
  heat_6h: '熱度 6h：最近 6 小時的成交速率 ÷ 全天平均速率。≥1 還在熱，<0.5 已經冷掉，24h 數字高估現在。不進評分。',
  trader_count: '交易者：過去一天不同交易地址數（真實 tx.from）。只有評分前 20 名有值。≥20 健康，評分佔 10%。',
  top1_share: 'top1：成交量最大的單一地址佔比。>60% 判定疑似刷量並排除。只有前 20 名有值。',
  price_dev_pct: '偏離：池價 vs Robinhood 官方報價。正常 ±0.5% 內；越大代表套利壓力越大或參考價異常。評分佔 10%。',
  raw_apr: '原始 APR：24h 手續費 × 365 ÷ TVL，全池平均、不含集中效果。只是參考。',
  fee_apr: '手續費 APR：$投入 在 ±區間 的模擬，只算修剪後的手續費 ÷ 投入，年化。這才是 LP 本身賺的。',
  net_apr: '含價差 net APR：手續費 + 期末市值 − 投入，再年化。含持有股票的漲跌與 IL。修剪版：砍掉手續費最高 5% 小時。',
  top_hour: '單時佔比：模擬收益裡最高的單一小時佔手續費的比例。>25% 黃、>50% 紅，代表收益來自一次性事件。',
  in_range: '在區間：模擬期間價格待在區間內的小時比例。評分佔 20%。',
  net_usd: '淨損益：該投入金額的模擬淨損益（修剪後），美元。',
  score: 'score：§8.3 加權總分（0–1）。net APR 百分位 40%、在區間 20%、CV 15%、交易者 10%、偏離 10%、24/5 可交易 5%。',
  flags: 'flags：排除原因或提示。紅色 = 硬排除；灰色 = 資訊性（例如 hook·費率、TVL 沿用前值）。',
}
