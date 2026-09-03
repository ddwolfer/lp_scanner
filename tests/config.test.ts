import { it, expect } from 'vitest'
import { ADDR, CHAIN, loadScoring } from '../config/chain.js'
it('地址皆為 lowercase 且 chain id 正確', () => {
  expect(CHAIN.id).toBe(4663)
  for (const a of Object.values(ADDR)) expect(a).toBe(a.toLowerCase())
})
it('scoring.json 權重加總為 1', () => {
  const s = loadScoring()
  const sum = Object.values(s.weights).reduce((a, b) => a + b, 0)
  expect(Math.abs(sum - 1)).toBeLessThan(1e-9)
  expect(s.exclusions.wash_overlap_volume_share).toBe(0.5)
})
