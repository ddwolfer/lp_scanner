import { expect, it } from 'vitest'
import { openDb } from '../db/index.js'
import { ApiUsage } from '../scanner/sources/usage.js'
import { needsOrigin, withTimeout, runPositionsStage, mintSearchRange, olderMintRange, withTimeoutTagged, TIMEOUT } from '../scanner/positionsStage.js'
import { fetchV4Positions } from '../scanner/sources/positions.js'

it('needsOrigin：只有鏈上、投入仍估計、沒有 mint_tx、沒有加減倉才補', () => {
  const n = { source: 'onchain', deposit_estimated: true }
  expect(needsOrigin(n, [])).toBe(true)
  expect(needsOrigin({ ...n, mint_tx: '0x1' }, [])).toBe(false)
  expect(needsOrigin({ ...n, deposit_estimated: false }, [])).toBe(false)
  expect(needsOrigin({ ...n, liquidity_changes: [{ at: 'x', from: '1', to: '2' }] }, [])).toBe(false)   // 加減倉過：不覆蓋調整後本金
  expect(needsOrigin(n, ['open', 'adjust'])).toBe(false)
  expect(needsOrigin({ source: 'manual', deposit_estimated: true }, [])).toBe(false)
})
it('withTimeout：逾時回 null、失敗回 null、成功回值', async () => {
  expect(await withTimeout(new Promise(() => {}), 20)).toBeNull()
  expect(await withTimeout(Promise.reject(new Error('x')), 1000)).toBeNull()
  expect(await withTimeout(Promise.resolve(5), 1000)).toBe(5)
})
it('fetchV4Positions：沒有 Alchemy key 時列 tokenId 的 getLogs 走 logsRpc，讀狀態走 readRpc 且帶固定區塊', async () => {
  const calls: string[] = []
  const logsRpc: any = { getBlockNumber: async () => 100n, getLogsChunked: async () => { calls.push('logs:getLogs'); return [] }, call: (f: any) => f(), client: {} }
  const readRpc: any = { getBlockNumber: async () => 100n, getLogsChunked: async () => { calls.push('read:getLogs'); return [] }, call: (f: any) => f(), client: {} }
  await fetchV4Positions(readRpc, '0xabc', new ApiUsage(), undefined, { logsRpc, at: 99n })
  expect(calls).toEqual(['logs:getLogs'])
})

// 一個 v3 頭寸的假讀取端（readContract 依函式名回應），用來跑整段 stage
const OWNER = '0x18a080b0e02eb2017c860d9444c504fcfd29454f', STOCK = '0xaaa0000000000000000000000000000000000001', USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
function fakeRead(seenBlocks: (bigint | undefined)[], block = 500n): any {
  const sqrt = BigInt(Math.round(Math.sqrt(10 * 1e6 / 1e18) * 2 ** 96))
  const rc = async (o: any) => { seenBlocks.push(o.blockNumber); switch (o.functionName) {
    case 'balanceOf': return 1n; case 'tokenOfOwnerByIndex': return 77n
    case 'positions': return [0n, OWNER, STOCK, USDG, 3000, -10000, 10000, 10n ** 15n, 0n, 0n, 0n, 0n]
    case 'getPool': return '0x00000000000000000000000000000000000000p1'.replace('p1', 'f1'); case 'slot0': return [sqrt, 0]
    default: throw new Error('unexpected ' + o.functionName) } }
  return { getBlockNumber: async () => block, call: (f: any) => f(), getLogsChunked: async () => [], client: { readContract: rc, simulateContract: async (o: any) => { seenBlocks.push(o.blockNumber); return { result: [0n, 0n] } } } }
}
it('runPositionsStage：讀狀態都帶同一個區塊；補查開倉交易逾時仍寫入快照、投入維持估計', async () => {
  const db = openDb(':memory:')
  db.prepare(`INSERT INTO tokens(address,symbol,kind) VALUES (?,?,?),(?,?,?)`).run(STOCK, 'AAA', 'stock', USDG, 'USDG', 'stable')
  const seen: (bigint | undefined)[] = []
  let n = 0   // 第一次 getLogs 是沒有 Alchemy key 時列 v4 tokenId（回空），之後找 mint 的都卡住
  const slowLogs: any = { getBlockNumber: async () => 500n, call: (f: any) => f(), getLogsChunked: () => n++ === 0 ? Promise.resolve([]) : new Promise(() => {}), client: { getLogs: () => new Promise(() => {}) } }
  const prevKey = process.env.ALCHEMY_KEY, prevCp = process.env.CAPITAL_COUNTERPARTIES; delete process.env.ALCHEMY_KEY; delete process.env.CAPITAL_COUNTERPARTIES
  try {
    const logs: string[] = []
    await runPositionsStage(db, new ApiUsage(), OWNER, '2026-10-10', new Date('2026-10-09T22:00:00Z'), m => logs.push(m), 'force', { readRpc: fakeRead(seen), logsRpc: slowLogs, originBudgetMs: 30 })
    expect(seen.length).toBeGreaterThan(0); expect(seen.every(b => b === 500n)).toBe(true)
    expect((db.prepare('SELECT COUNT(*) c FROM position_snapshots').get() as any).c).toBe(1)
    const notes = JSON.parse((db.prepare('SELECT notes FROM positions').get() as any).notes)
    expect(notes.deposit_estimated).toBe(true); expect(notes.mint_tx).toBeUndefined()
    expect(logs.some(l => l.includes('逾時'))).toBe(true)
    expect(notes.mint_searched_from).toBeUndefined()   // 逾時不算查過，下次重查同一段
  } finally { if (prevKey) process.env.ALCHEMY_KEY = prevKey; if (prevCp) process.env.CAPITAL_COUNTERPARTIES = prevCp }
})

it('mintSearchRange：以第一次看到的時間推算區塊，往前 2 天往後 1 天，不超過目前區塊', () => {
  const day = 830_769n
  const r = mintSearchRange(100_000_000n, Date.parse('2026-10-01T00:00:00Z'), Date.parse('2026-10-03T00:00:00Z'))
  expect(r.toBlock - r.fromBlock).toBe(3n * day)
  expect(100_000_000n - r.toBlock).toBe(day)   // 兩天前看到 → 估計區塊在 2 天前，往後 1 天
  expect(mintSearchRange(100n, Date.now(), Date.now()).toBlock).toBe(100n)
  expect(mintSearchRange(100n, Date.now(), Date.now()).fromBlock).toBe(0n)
})

it('沒找到 mint 時記下查過的最舊區塊，下次往前 3 天；逾時與「沒有」分得開', async () => {
  const d3 = BigInt(Math.round(3 * 86400 / 0.104))
  expect(olderMintRange(10n * d3)).toEqual({ fromBlock: 9n * d3, toBlock: 10n * d3 })
  expect(olderMintRange(5n)).toEqual({ fromBlock: 0n, toBlock: 5n })
  expect(await withTimeoutTagged(new Promise(() => {}), 10)).toBe(TIMEOUT)
  expect(await withTimeoutTagged(Promise.resolve(null), 1000)).toBeNull()
  expect(await withTimeoutTagged(Promise.reject(new Error('403')), 1000)).toBe(TIMEOUT)
})
it('runPositionsStage：mint 查完沒有 → 記 mint_searched_from，下次從更舊的區塊查', async () => {
  const db = openDb(':memory:')
  db.prepare(`INSERT INTO tokens(address,symbol,kind) VALUES (?,?,?),(?,?,?)`).run(STOCK, 'AAA', 'stock', USDG, 'USDG', 'stable')
  const ranges: [bigint, bigint][] = []
  const emptyLogs: any = { getBlockNumber: async () => 50_000_000n, call: (f: any) => f(), getLogsChunked: async (_p: any, from: bigint, to: bigint) => { ranges.push([from, to]); return [] }, client: {} }
  const prevKey = process.env.ALCHEMY_KEY, prevCp = process.env.CAPITAL_COUNTERPARTIES; delete process.env.ALCHEMY_KEY; delete process.env.CAPITAL_COUNTERPARTIES
  try {
    const run = () => runPositionsStage(db, new ApiUsage(), OWNER, '2026-10-10', new Date('2026-10-09T22:00:00Z'), () => {}, 'force', { readRpc: fakeRead([], 50_000_000n), logsRpc: emptyLogs, originBudgetMs: 5000 })
    await run(); const first = JSON.parse((db.prepare('SELECT notes FROM positions').get() as any).notes).mint_searched_from
    expect(first).toBeDefined()
    await run(); const second = JSON.parse((db.prepare('SELECT notes FROM positions').get() as any).notes).mint_searched_from
    expect(BigInt(second)).toBeLessThan(BigInt(first))
    expect(ranges[ranges.length - 1][1]).toBe(BigInt(first))   // 第二次從上次最舊的地方往前查
  } finally { if (prevKey) process.env.ALCHEMY_KEY = prevKey; if (prevCp) process.env.CAPITAL_COUNTERPARTIES = prevCp }
})

import { isRevert } from '../scanner/sources/positions.js'
it('fetchV4Positions 固定區塊時：ownerOf revert（那時還不存在）跳過，連線錯誤往上丟', async () => {
  const revert = Object.assign(new Error('x'), { cause: { name: 'ContractFunctionRevertedError' } })
  expect(isRevert(revert)).toBe(true); expect(isRevert(new Error('HTTP 429'))).toBe(false)
  const mk = (err: unknown): any => ({ getBlockNumber: async () => 9n, call: (f: any) => f(), getLogsChunked: async () => [{ args: { tokenId: 1n } }], client: { readContract: async (o: any) => { if (o.functionName === 'ownerOf') { if (o.blockNumber === undefined) return '0xabc'; throw err } throw new Error('unexpected') } } })
  expect(await fetchV4Positions(mk(revert), '0xabc', new ApiUsage(), undefined, { at: 9n })).toEqual([])
  await expect(fetchV4Positions(mk(new Error('HTTP 429')), '0xabc', new ApiUsage(), undefined, { at: 9n })).rejects.toThrow('429')
})
