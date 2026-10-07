// scanner/sources/wallet.ts — 錢包餘額與指定對手地址的 USDG 進出（D70），全部唯讀
import type Database from 'better-sqlite3'
import { netDeposits, type Xfer } from '../metrics/capital.js'
import { ADDR, STOCK_DECIMALS, USDG_DECIMALS } from '../../config/chain.js'
import { erc20Abi } from 'viem'
import type { Rpc } from './rpc.js'
import type { ApiUsage } from './usage.js'
import { fetchJson } from './http.js'

type Call = (method: string, params: unknown[]) => Promise<any>
/** Multicall3 的標準部署地址；10/7 用 eth_getCode 確認 Robinhood Chain 上有合約（Codex review P1：自訂鏈沒有預設 multicall3） */
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const
/** Alchemy JSON-RPC：走 fetchJson（超時、429/5xx 重試、計入 scan_runs.api_calls 的 alchemy），Codex review */
export const alchemyCall = (key: string, usage: ApiUsage, fetchImpl?: typeof fetch): Call => async (method, params) => {
  const j: any = await fetchJson(`https://robinhood-mainnet.g.alchemy.com/v2/${key}`, { source: 'alchemy', usage, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), timeoutMs: 20_000, retries: 3, fetchImpl })
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 160)}`); return j.result
}
/** 自己與任何地址之間的 USDG 轉帳（兩個方向、追完 pageKey），截止到 toBlock */
export async function fetchUsdgTransfers(call: Call, me: string, toBlock: bigint): Promise<Xfer[]> {
  const out: Xfer[] = []
  for (const dir of ['fromAddress', 'toAddress'] as const) { let pageKey: string | undefined
    do { const r = await call('alchemy_getAssetTransfers', [{ fromBlock: '0x0', toBlock: '0x' + toBlock.toString(16), [dir]: me, category: ['erc20'], contractAddresses: [ADDR.usdg], maxCount: '0x3e8', ...(pageKey ? { pageKey } : {}) }])
      for (const t of r.transfers) out.push({ from: t.from, to: t.to, contract: t.rawContract.address, value: t.value ?? 0, hash: t.hash, logIndex: t.uniqueId ?? null })
      pageKey = r.pageKey } while (pageKey) }
  return out
}
/** 錢包內 USDG 與「所有」白名單股票代幣在 block 的餘額（用 multicall 一次讀完，不靠最新餘額篩選，Codex review）；股票用最新池價估值，沒價格的列入 missing */
export async function walletValue(rpc: Rpc, db: Database.Database, me: `0x${string}`, block: bigint): Promise<{ usd: number; missing: string[]; detail: Record<string, number> }> {
  const toks = [{ address: ADDR.usdg.toLowerCase(), symbol: 'USDG' }, ...(db.prepare(`SELECT lower(address) address, symbol FROM tokens WHERE kind='stock'`).all() as { address: string; symbol: string }[])]
  const priceQ = db.prepare(`SELECT s.price_usd p FROM pool_snapshots s JOIN pools p ON p.pool_id=s.pool_id JOIN tokens t ON t.address = CASE WHEN p.stock_is_token0=1 THEN p.token0 ELSE p.token1 END WHERE t.symbol=? AND s.price_usd IS NOT NULL ORDER BY s.date DESC, s.volume_24h_usd DESC LIMIT 1`)
  const res = await rpc.call(() => rpc.client.multicall({ contracts: toks.map(t => ({ address: t.address as `0x${string}`, abi: erc20Abi, functionName: 'balanceOf', args: [me] })), blockNumber: block, allowFailure: false, multicallAddress: MULTICALL3 }))   // 任何失敗都丟出去讓 rpc.call 重試，不存部分餘額（Codex review）
  let usd = 0; const missing: string[] = []; const detail: Record<string, number> = {}
  ;(res as bigint[]).forEach((raw, i) => {
    const t = toks[i]; if (raw === 0n) return
    if (t.symbol === 'USDG') { const v = Number(raw) / 10 ** USDG_DECIMALS; usd += v; detail.USDG = v; return }
    const amt = Number(raw) / 10 ** STOCK_DECIMALS; const p = (priceQ.get(t.symbol) as any)?.p
    if (!p) { missing.push(t.symbol); return }
    if (amt * p >= 0.01) detail[t.symbol] = amt * p; usd += amt * p
  })
  return { usd, missing, detail }
}
export { netDeposits }
