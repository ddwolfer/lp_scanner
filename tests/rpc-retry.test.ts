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
