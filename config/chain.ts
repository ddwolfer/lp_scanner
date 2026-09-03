// config/chain.ts — 鏈常數唯一來源（DECISIONS 11.4 驗證過）
import { readFileSync } from 'node:fs'
import { z } from 'zod'

export const CHAIN = {
  id: 4663,
  name: 'Robinhood Chain',
  publicRpc: 'https://rpc.mainnet.chain.robinhood.com',
  alchemyRpc: (key: string) => `https://robinhood-mainnet.g.alchemy.com/v2/${key}`,
  blocksPerDay: 830_000,          // 實測 ~0.104 s/塊
  getLogsChunk: 100_000,          // public RPC 實測可用範圍
} as const

export const ADDR = {
  poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
  stateView:   '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
  usdg:        '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
  weth:        '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
  zero:        '0x0000000000000000000000000000000000000000',
} as const

export const USDG_DECIMALS = 6
export const STOCK_DECIMALS = 18
export const DYNAMIC_FEE_FLAG = 0x800000

const ScoringSchema = z.object({
  sort_key: z.string(),
  weights: z.object({
    net_apr: z.number(), in_range_pct: z.number(), vol7_cv: z.number(),
    trader_count: z.number(), price_dev: z.number(), all_day_tradable: z.number(),
  }),
  exclusions: z.object({
    fee_ppm_min: z.number(), fee_ppm_max: z.number(), min_age_days: z.number(),
    min_tvl_usd: z.number(), corp_action_window_days: z.number(),
    wash_top1_share: z.number(), wash_pingpong_ratio: z.number(),
    wash_overlap_volume_share: z.number(),
  }),
  wash_analysis_top_n: z.number(),
  scan: z.object({ swap_fetch_min_tvl_usd: z.number(), wash_sample_swaps: z.number() }),
})
export type Scoring = z.infer<typeof ScoringSchema>
export function loadScoring(path: URL | string = new URL('./scoring.json', import.meta.url)): Scoring {
  return ScoringSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
}
