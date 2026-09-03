import { it, expect } from 'vitest'
import { hardExclusions, type ExclusionCtx } from '../scanner/metrics/exclusions.js'
import { loadScoring } from '../config/chain.js'
const th = loadScoring().exclusions
const ok: ExclusionCtx = { stockAddress: '0xsofi', otherIsUsdg: true, symbolLooksLikeStock: true, hooks: '0x0000000000000000000000000000000000000000', feePpm: 32900, ageDays: 30, tvlUsd: 20000, pendingMultiplier: '', corpActionDaysAhead: null, isTradingHalt: false, rhStatus: 'ASSET_STATUS_ACTIVE', wash: { top1Share: 0.16, pingpongRatio: 0, overlapVolumeShare: 0.2 }, quoteKind: 'usdg' }
it('健康池無 flag', () => { expect(hardExclusions(ok, th)).toEqual([]) })
it('各規則各自命中', () => {
  expect(hardExclusions({ ...ok, stockAddress: null, symbolLooksLikeStock: false }, th)).toContain('not_stock')
  expect(hardExclusions({ ...ok, stockAddress: null, symbolLooksLikeStock: true }, th)).toContain('fake_stock')
  expect(hardExclusions({ ...ok, hooks: '0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544' }, th)).toContain('has_hooks')
  expect(hardExclusions({ ...ok, feePpm: null }, th)).toContain('fee_out_of_range')
  expect(hardExclusions({ ...ok, feePpm: 70000 }, th)).toContain('fee_out_of_range')
  expect(hardExclusions({ ...ok, ageDays: 3 }, th)).toContain('too_new')
  expect(hardExclusions({ ...ok, tvlUsd: 100 }, th)).toContain('tvl_too_small')
  expect(hardExclusions({ ...ok, tvlUsd: null }, th)).toEqual(expect.arrayContaining(['tvl_unknown', 'tvl_too_small']))
  expect(hardExclusions({ ...ok, pendingMultiplier: '2.0', corpActionDaysAhead: 5 }, th)).toContain('corp_action_pending')
  expect(hardExclusions({ ...ok, pendingMultiplier: '2.0', corpActionDaysAhead: 30 }, th)).not.toContain('corp_action_pending')
  expect(hardExclusions({ ...ok, isTradingHalt: true }, th)).toContain('halted')
  expect(hardExclusions({ ...ok, rhStatus: 'ASSET_STATUS_INACTIVE' }, th)).toContain('asset_inactive')
  expect(hardExclusions({ ...ok, wash: { top1Share: 0.7, pingpongRatio: 0, overlapVolumeShare: 0 } }, th)).toContain('wash_suspect')
  expect(hardExclusions({ ...ok, wash: { top1Share: 0.1, pingpongRatio: 0, overlapVolumeShare: 0.6 } }, th)).toContain('wash_suspect')
  expect(hardExclusions({ ...ok, wash: { top1Share: 0.1, pingpongRatio: 0, overlapVolumeShare: 0.4 } }, th)).not.toContain('wash_suspect')
  expect(hardExclusions({ ...ok, quoteKind: 'other' }, th)).toContain('non_usd_quote')
})
