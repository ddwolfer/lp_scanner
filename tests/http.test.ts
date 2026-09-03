import { it, expect, vi } from 'vitest'
import { fetchJson } from '../scanner/sources/http.js'
import { ApiUsage } from '../scanner/sources/usage.js'
const res = (status: number, body: any) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) }) as any
it('成功回傳 JSON 並計數', async () => {
  const usage = new ApiUsage(); const f = vi.fn().mockResolvedValue(res(200, { a: 1 }))
  expect(await fetchJson('http://x', { source: 'rh', usage, fetchImpl: f })).toEqual({ a: 1 })
  expect(usage.toJSON()).toEqual({ rh: 1 })
})
it('429 會重試，計數包含重試', async () => {
  const usage = new ApiUsage(); const f = vi.fn().mockResolvedValueOnce(res(429, {})).mockResolvedValueOnce(res(200, { ok: true }))
  expect(await fetchJson('http://x', { source: 'rh', usage, fetchImpl: f, retries: 2, baseDelayMs: 1 })).toEqual({ ok: true })
  expect(f).toHaveBeenCalledTimes(2); expect(usage.toJSON()).toEqual({ rh: 2 })
})
it('404 不重試直接丟錯', async () => {
  const usage = new ApiUsage(); const f = vi.fn().mockResolvedValue(res(404, {}))
  await expect(fetchJson('http://x', { source: 'rh', usage, fetchImpl: f, baseDelayMs: 1 })).rejects.toThrow(/404/)
  expect(f).toHaveBeenCalledTimes(1)
})
