import { it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fetchAssets, fetchPrice, fetchCorporateActions } from '../scanner/sources/robinhood.js'
import { ApiUsage } from '../scanner/sources/usage.js'
const j = (body: any) => ({ ok: true, status: 200, json: async () => body }) as any
it('fetchAssets 正規化地址與 allDayTradable', async () => {
  const f = vi.fn().mockResolvedValue(j(JSON.parse(readFileSync('tests/fixtures/rh-assets.json', 'utf8'))))
  const a = await fetchAssets({ usage: new ApiUsage(), fetchImpl: f })
  expect(f.mock.calls[0][0]).toBe('https://api.robinhood.com/rhj/assets')
  expect(a[0]).toMatchObject({ tokenSymbol: 'SOFI', address: '0x98e75885157c80992a8d41b696d8c9c6fb30a926', allDayTradable: true })
  expect(a[1].allDayTradable).toBe(false)
})
it('fetchPrice 算 mid，找不到回 null', async () => {
  const f = vi.fn().mockResolvedValueOnce(j({ quotes: [{ tokenSymbol: 'SOFI', bid: '17.9', ask: '17.91', isTradingHalt: false, generatedAt: 'x' }] }))
    .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
  expect(await fetchPrice({ usage: new ApiUsage(), fetchImpl: f }, 'SOFI')).toMatchObject({ mid: 17.905, isTradingHalt: false })
  const g = vi.fn().mockResolvedValueOnce(j({ quotes: [{ tokenSymbol: 'GLD', bid: '406.51', ask: '500', isTradingHalt: false }] }))
  expect((await fetchPrice({ usage: new ApiUsage(), fetchImpl: g }, 'GLD'))!.spreadPct).toBeGreaterThan(0.2)
  expect(await fetchPrice({ usage: new ApiUsage(), fetchImpl: f }, 'NOPE')).toBeNull()
})
it('fetchCorporateActions 把 processDate 轉成 YYYY-MM-DD', async () => {
  const f = vi.fn().mockResolvedValue(j({ corpActions: [{ id: 'ca1', type: 'CORPORATE_ACTION_TYPE_CASH_DIVIDEND', status: 'CORPORATE_ACTION_STATUS_IN_PROGRESS',
    processDate: { year: 2026, month: 9, day: 10 }, tokenSymbol: 'MSFT', deployments: [{ contractAddress: '0xE93237C50D904957Cf27E7B1133b510C669c2e74', chainId: 4663 }], details: {} }] }))
  const c = await fetchCorporateActions({ usage: new ApiUsage(), fetchImpl: f })
  expect(c[0]).toMatchObject({ id: 'ca1', effectiveAt: '2026-09-10', address: '0xe93237c50d904957cf27e7b1133b510c669c2e74' })
})
