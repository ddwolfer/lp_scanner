import { it, expect } from 'vitest'
import { analyzeWash } from '../scanner/metrics/wash.js'
const s = (trader: string, ts: number, dir: 'buy' | 'sell', v: number) => ({ trader, ts, dir, volumeUsd: v })
it('集中度、對打、LP 重疊', () => {
  const m = analyzeWash([s('a', 0, 'buy', 60), s('a', 100, 'sell', 60), s('b', 200, 'buy', 40), s('c', 5000, 'sell', 40)], new Set(['a']))
  expect(m.traderCount).toBe(3)
  expect(m.top1Share).toBeCloseTo(120 / 200, 9)
  expect(m.pingpongRatio).toBeCloseTo(1 / 4, 9)
  expect(m.lpTraderOverlap).toBe(1)
  expect(m.lpOverlapVolumeShare).toBeCloseTo(0.6, 9)
  expect(m.topTraders[0]).toMatchObject({ addr: 'a', n: 2, buy: 1, sell: 1 })
})
it('空輸入', () => { expect(analyzeWash([], new Set()).traderCount).toBe(0) })
