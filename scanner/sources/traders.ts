// scanner/sources/traders.ts — 用 eth_getTransactionByHash 取 tx.from（v4 Swap 的 sender 是 router，不是真人）
// Alchemy 免費方案允許此方法且 500 CU/s（DECISIONS D24），有 key 就走 Alchemy；否則 public RPC 並由呼叫端取樣（D25）
import { CHAIN } from '../../config/chain.js'
import { makeRpc, type Rpc } from './rpc.js'
import type { ApiUsage } from './usage.js'
export function makeTraderRpc(usage: ApiUsage, alchemyKey = process.env.ALCHEMY_KEY): { rpc: Rpc; isAlchemy: boolean } {
  if (alchemyKey) return { rpc: makeRpc({ usage, url: CHAIN.alchemyRpc(alchemyKey), source: 'alchemy', concurrency: 8, minGapMs: 40 }), isAlchemy: true }
  return { rpc: makeRpc({ usage }), isAlchemy: false }
}
export async function resolveTxFrom(rpc: Pick<Rpc, 'call' | 'client'>, hashes: string[]): Promise<Map<string, string>> {
  const uniq = [...new Set(hashes)]; const out = new Map<string, string>()
  await Promise.all(uniq.map(async h => {
    const tx = await rpc.call(() => rpc.client.getTransaction({ hash: h as `0x${string}` }))
    out.set(h, String(tx.from).toLowerCase())
  }))
  return out
}
