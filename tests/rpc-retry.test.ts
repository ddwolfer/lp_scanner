import { describe, it, expect } from 'vitest'
import { isRetryable, isTooManyLogs } from '../scanner/sources/rpc.js'
const err = (o: Record<string, unknown>) => Object.assign(new Error(String(o.message ?? 'x')), o)
describe('isRetryable', () => {
  it('429 狀態', () => expect(isRetryable(err({ status: 429, message: 'HTTP request failed.' }))).toBe(true))
  it('Cloudflare 520/524（舊正則漏掉的）', () => {
    expect(isRetryable(err({ status: 520 }))).toBe(true)
    expect(isRetryable(err({ status: 524 }))).toBe(true)
  })
  it('viem HttpRequestError 不帶狀態', () => expect(isRetryable(err({ name: 'HttpRequestError', message: 'HTTP request failed.' }))).toBe(true))
  it('details 裡的 Too Many Requests', () => expect(isRetryable(err({ message: 'RPC Request failed.', details: 'Too Many Requests' }))).toBe(true))
  it('連線層錯誤', () => {
    for (const m of ['socket hang up', 'fetch failed', 'other side closed', 'terminated']) expect(isRetryable(err({ message: m }))).toBe(true)
  })
  it('>10k logs 不重試', () => expect(isTooManyLogs(err({ message: 'RPC Request failed.', details: 'logs matched by query exceeds limit of 10000' }))).toBe(true))
  it('一般錯誤不重試', () => expect(isRetryable(err({ message: 'invalid address', status: 400 }))).toBe(false))
  it('4xx 的 HttpRequestError 是永久錯誤（Codex）', () => expect(isRetryable(err({ name: 'HttpRequestError', status: 400, message: 'HTTP request failed.' }))).toBe(false))
  it('請求內文的數字不該誤判成 5xx（Codex）', () => expect(isRetryable(err({ message: 'RPC Request failed.', details: 'execution reverted', cause: err({ message: 'fromBlock 0x3502abc toBlock 0x3502fff' }) }))).toBe(false))
  it('包在 cause 裡的 429 要重試（Codex）', () => expect(isRetryable(err({ name: 'ContractFunctionExecutionError', message: 'read failed', cause: err({ name: 'HttpRequestError', status: 429, message: 'HTTP request failed.' }) }))).toBe(true))
  it('包在 cause 裡的 400 不重試（Codex）', () => expect(isRetryable(err({ name: 'ContractFunctionExecutionError', message: 'read failed', cause: err({ name: 'HttpRequestError', status: 400, message: 'HTTP request failed.' }) }))).toBe(false))
})

// D64：403 端點封鎖走共用冷卻。用虛擬時鐘驗證等待序列（Codex plan review：不能只驗 isRetryable）
import { makeRpc, isBlocked } from '../scanner/sources/rpc.js'
function virtualRpc(opts: { blockCoolMs?: number; blockMaxMs?: number } = {}) {
  let t = 1_000_000; const sleeps: number[] = []
  const usage = { inc() {}, toJSON: () => ({}) } as any
  const rpc = makeRpc({ usage, url: 'http://x', concurrency: 2, minGapMs: 0, now: () => t, sleepFn: async ms => { sleeps.push(ms); t += ms }, ...opts })
  return { rpc, sleeps, now: () => t }
}
const e403 = () => err({ name: 'HttpRequestError', status: 403, message: 'HTTP request failed.' })
describe('403 共用冷卻（D64）', () => {
  it('isBlocked 只認 403，含 cause 鏈', () => {
    expect(isBlocked(e403())).toBe(true)
    expect(isBlocked(err({ name: 'ContractFunctionExecutionError', message: 'read failed', cause: e403() }))).toBe(true)
    expect(isBlocked(err({ status: 429 }))).toBe(false); expect(isBlocked(err({ status: 400 }))).toBe(false)
  })
  it('403 兩次後恢復：等兩段冷卻，不吃 attempt 預算', async () => {
    const { rpc, sleeps } = virtualRpc({ blockCoolMs: 30_000 }); let n = 0
    const r = await rpc.call(async () => { n++; if (n <= 2) throw e403(); return 'ok' })
    expect(r).toBe('ok'); expect(n).toBe(3)
    const cools = sleeps.filter(s => s >= 30_000); expect(cools.length).toBe(2)
    for (const c of cools) expect(c).toBeLessThan(35_000)
  })
  it('放棄後的下一個呼叫仍要等冷卻結束才發（端點共用）', async () => {
    const { rpc, now, sleeps } = virtualRpc({ blockCoolMs: 30_000, blockMaxMs: 0 })
    await expect(rpc.call(async () => { throw e403() })).rejects.toMatchObject({ status: 403 })
    const t1 = now(); let sentAt = 0
    await rpc.call(async () => { sentAt = now(); return 'b' })
    expect(sentAt - t1).toBeGreaterThanOrEqual(30_000); expect(sleeps.at(-1)).toBeGreaterThanOrEqual(30_000)
  })
  it('持續 403 超過上限就放棄', async () => {
    const { rpc } = virtualRpc({ blockCoolMs: 30_000, blockMaxMs: 120_000 }); let n = 0
    await expect(rpc.call(async () => { n++; throw e403() })).rejects.toMatchObject({ status: 403 })
    expect(n).toBeGreaterThanOrEqual(4); expect(n).toBeLessThanOrEqual(6)
  })
  it('混合 429 與 403：429 用退避、403 用冷卻，各自計數', async () => {
    const { rpc, sleeps } = virtualRpc({ blockCoolMs: 30_000 }); let n = 0
    const r = await rpc.call(async () => { n++; if (n === 1) throw err({ status: 429 }); if (n === 2) throw e403(); return 'ok' })
    expect(r).toBe('ok'); expect(sleeps.some(s => s < 2000)).toBe(true); expect(sleeps.some(s => s >= 30_000)).toBe(true)
  })
  it('十次 403 再三次 429 不會耗盡 429 的預算（Codex code review）', async () => {
    const { rpc } = virtualRpc({ blockCoolMs: 1000, blockMaxMs: 60_000 }); let n = 0
    const r = await rpc.call(async () => { n++; if (n <= 10) throw e403(); if (n <= 13) throw err({ status: 429 }); return 'ok' })
    expect(r).toBe('ok'); expect(n).toBe(14)
  })
  it('併發請求各自收到 403：醒來後要再看一次被延長的冷卻（Codex code review）', async () => {
    const { rpc, now } = virtualRpc({ blockCoolMs: 30_000 })
    const blocks: number[] = [], sends: number[] = []
    const mk = () => { let first = true; return async () => { if (first) { first = false; blocks.push(now()); throw e403() } sends.push(now()); return 'ok' } }
    await Promise.all([rpc.call(mk()), rpc.call(mk())])
    expect(blocks.length).toBe(2); expect(sends.length).toBe(2)
    const lastBlock = Math.max(...blocks)
    for (const s of sends) expect(s).toBeGreaterThanOrEqual(lastBlock + 30_000)
  })
  it('400 仍是永久錯誤', async () => {
    const { rpc } = virtualRpc(); let n = 0
    await expect(rpc.call(async () => { n++; throw err({ status: 400, message: 'bad' }) })).rejects.toThrow('bad'); expect(n).toBe(1)
  })
})

import { ApiUsage as U2 } from '../scanner/sources/usage.js'
it('D72：403 次數與等待秒數記進 usage', async () => {
  let t = 0; const usage = new U2(); let n = 0
  const rpc = makeRpc({ usage, minGapMs: 0, blockCoolMs: 30_000, sleepFn: async ms => { t += ms }, now: () => t })
  const err = Object.assign(new Error('blocked'), { status: 403 })
  await rpc.call(async () => { n++; if (n <= 2) throw err; return 1 })
  const u = usage.toJSON() as any
  expect(u.rpc_403).toBe(2); expect(u.rpc_403_wait_s).toBeGreaterThanOrEqual(60)
})
