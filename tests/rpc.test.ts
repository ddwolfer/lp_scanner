import { it, expect } from 'vitest'
import { chunkRanges, Limiter } from '../scanner/sources/rpc.js'
it('chunkRanges 切成 ≤ chunk 的閉區間', () => {
  expect(chunkRanges(0n, 250n, 100n)).toEqual([[0n, 99n], [100n, 199n], [200n, 250n]])
})
it('Limiter 同時最多 N 個', async () => {
  const lim = new Limiter(2); let active = 0, max = 0
  await Promise.all([1,2,3,4,5].map(() => lim.run(async () => { active++; max = Math.max(max, active); await new Promise(r => setTimeout(r, 5)); active-- })))
  expect(max).toBe(2)
})
