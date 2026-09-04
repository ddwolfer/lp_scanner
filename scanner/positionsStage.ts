// scanner/positionsStage.ts — 鏈上頭寸回填（P5）。run.ts 每日呼叫，scripts/sync-positions.ts 手動呼叫
import type Database from 'better-sqlite3'
import { ADDR, STOCK_DECIMALS, USDG_DECIMALS } from '../config/chain.js'
import { makeRpc } from './sources/rpc.js'
import type { ApiUsage } from './sources/usage.js'
import { fetchV4Positions, fetchV3Positions, fetchMintInfo, sqrtPriceAtMint } from './sources/positions.js'
import { V3_NPM } from './sources/uniswapV3.js'
import { syncPositions, writePositionSnapshot, setPositionOrigin, type PositionValuation } from './steps.js'
import { exportPositions } from '../server/queries.js'

export async function runPositionsStage(db: Database.Database, usage: ApiUsage, trackAddr: string, date: string, now: Date, log: (m: string) => void): Promise<PositionValuation[]> {
  const rpc = makeRpc({ usage })
  const stockMap = new Map((db.prepare(`SELECT address, symbol FROM tokens WHERE kind='stock'`).all() as { address: string; symbol: string }[]).map(t => [t.address, { tokenSymbol: t.symbol }]))
  const onchain = [...await fetchV4Positions(rpc, trackAddr, usage, process.env.ALCHEMY_KEY), ...await fetchV3Positions(rpc, trackAddr)]
  const vals = syncPositions(db, onchain, stockMap, now.toISOString())
  for (const v of vals) {
    if (v.isNew) {   // 從 mint 交易取真實投入與開倉時間（DECISIONS D29）
      const oc = onchain.find(o => o.poolId === v.poolId && o.tokenId === v.tokenId)!
      const mint = await fetchMintInfo(rpc, oc.tokenId, trackAddr, oc.protocol === 'v3' ? { nft: V3_NPM, depositTo: oc.poolId } : {}).catch(() => null)
      if (mint) {
        const stockIs0 = stockMap.has(oc.currency0); const stockAddr = stockIs0 ? oc.currency0 : oc.currency1
        const stockRaw = Number(mint.deposits[stockAddr] ?? 0n), usdgRaw = Number(mint.deposits[ADDR.usdg] ?? 0n)
        const a0 = stockIs0 ? stockRaw : usdgRaw, a1 = stockIs0 ? usdgRaw : stockRaw
        const sp = sqrtPriceAtMint(mint.liquidity ?? oc.liquidity, a0, a1, oc.tickLower, oc.tickUpper)   // 用 mint 當下的流動性反推開倉價
        const priceRaw = sp * sp; const price = stockIs0 ? priceRaw * 10 ** (STOCK_DECIMALS - USDG_DECIMALS) : 1 / (priceRaw * 10 ** (USDG_DECIMALS - STOCK_DECIMALS))
        const deposit = stockRaw / 10 ** STOCK_DECIMALS * price + usdgRaw / 10 ** USDG_DECIMALS
        setPositionOrigin(db, v.positionId, new Date(mint.ts * 1000).toISOString(), deposit, { mint_tx: mint.txHash, mint_block: mint.block.toString(), mint_price: price, deposit_stock: stockRaw / 10 ** STOCK_DECIMALS, deposit_usdg: usdgRaw / 10 ** USDG_DECIMALS })
        log(`position ${v.label}: opened ${new Date(mint.ts * 1000).toISOString().slice(0, 16)} deposit $${deposit.toFixed(2)} @ ${price.toFixed(2)}`)
      }
    }
    if (!v.closed || v.isNew) writePositionSnapshot(db, v.positionId, date, v)
  }
  exportPositions(db, 'data/positions')
  log(`positions: ${onchain.length} onchain, ${vals.length} tracked (${vals.filter(v => v.isNew).length} new, ${vals.filter(v => v.closed).length} closed)`)
  return vals
}
