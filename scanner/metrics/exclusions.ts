// scanner/metrics/exclusions.ts — SPEC §8.1 硬排除，純函式（wash 第三條件依 DECISIONS C2 改為成交量佔比）
import { ADDR } from '../../config/chain.js'
import type { Scoring } from '../../config/chain.js'
export interface ExclusionCtx {
  stockAddress: string | null; otherIsUsdg: boolean; symbolLooksLikeStock: boolean; hooks: string; hookKind?: 'none' | 'fee_only' | 'liquidity'; feePpm: number | null
  ageDays: number | null; tvlUsd: number | null; pendingMultiplier: string; corpActionDaysAhead: number | null
  isTradingHalt: boolean | null; rhStatus: string | null
  wash: { top1Share: number; pingpongRatio: number; overlapVolumeShare: number } | null
  quoteKind: 'usdg' | 'eth' | 'other'
}
export function hardExclusions(c: ExclusionCtx, th: Scoring['exclusions']): string[] {
  const f: string[] = []
  if (!c.stockAddress) f.push(c.symbolLooksLikeStock ? 'fake_stock' : 'not_stock')
  // D36 兩層：會碰本金的 hook 才排除；純費率 hook 放行並標記
  const kind = c.hookKind ?? (c.hooks === ADDR.zero ? 'none' : 'liquidity')
  if (kind === 'liquidity') f.push('has_hooks')
  if (kind === 'fee_only') f.push('hook_fee_only')
  if (c.feePpm === null || c.feePpm > th.fee_ppm_max || c.feePpm < th.fee_ppm_min) f.push('fee_out_of_range')
  if (c.ageDays !== null && c.ageDays < th.min_age_days) f.push('too_new')
  if (c.tvlUsd === null) f.push('tvl_unknown', 'tvl_too_small')
  else if (c.tvlUsd < th.min_tvl_usd) f.push('tvl_too_small')
  if (c.pendingMultiplier !== '' && c.corpActionDaysAhead !== null && c.corpActionDaysAhead <= th.corp_action_window_days) f.push('corp_action_pending')
  if (c.isTradingHalt) f.push('halted')
  if (c.rhStatus !== null && c.rhStatus !== 'ASSET_STATUS_ACTIVE') f.push('asset_inactive')
  if (c.wash && (c.wash.top1Share > th.wash_top1_share || c.wash.pingpongRatio > th.wash_pingpong_ratio || c.wash.overlapVolumeShare > th.wash_overlap_volume_share)) f.push('wash_suspect')
  if (c.quoteKind === 'other') f.push('non_usd_quote')
  return f
}
