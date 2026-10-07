// scanner/positionsStage.ts — 鏈上頭寸回填（P5）。run.ts 每日呼叫，scripts/sync-positions.ts 手動呼叫
import type Database from 'better-sqlite3'
import { ADDR, STOCK_DECIMALS, USDG_DECIMALS } from '../config/chain.js'
import { makeRpc } from './sources/rpc.js'
import type { ApiUsage } from './sources/usage.js'
import { fetchV4Positions, fetchV3Positions, fetchMintInfo, sqrtPriceAtMint } from './sources/positions.js'
import { V3_NPM } from './sources/uniswapV3.js'
import { syncPositions, writePositionSnapshot, setPositionOrigin, valueOnchainPosition, type PositionValuation } from './steps.js'
import { exportPositions } from '../server/queries.js'
import { alchemyCall, fetchUsdgTransfers, walletValue, netDeposits } from './sources/wallet.js'

export type SnapshotMode = 'force' | 'if_missing'
/** D66：當天已有快照時要不要覆蓋。06:00 排程用 force（權威切點）；07:30 掃描與手動同步用 if_missing（只補缺的）；新頭寸一律寫 */
export function shouldWriteSnapshot(db: Database.Database, positionId: number, date: string, isNew: boolean, mode: SnapshotMode): boolean {
  if (mode === 'force' || isNew) return true
  return !db.prepare('SELECT 1 FROM position_snapshots WHERE position_id=? AND date=?').get(positionId, date)
}
export async function runPositionsStage(db: Database.Database, usage: ApiUsage, trackAddr: string, date: string, now: Date, log: (m: string) => void, mode: SnapshotMode = 'if_missing'): Promise<PositionValuation[]> {
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
    if ((!v.closed || v.isNew) && shouldWriteSnapshot(db, v.positionId, date, v.isNew, mode)) writePositionSnapshot(db, v.positionId, date, { ...v, priceUsd: v.priceUsd })
  }
  // D70：錢包總值對淨入金（要 ALCHEMY_KEY 與 CAPITAL_COUNTERPARTIES；失敗只記 error，不影響頭寸）。當天快照只有 ok 才不覆蓋，失敗或不完整的之後的同步可以補
  const cps = (process.env.CAPITAL_COUNTERPARTIES ?? '').split(',').map(x => x.trim()).filter(Boolean)
  if (cps.length && process.env.ALCHEMY_KEY && (mode === 'force' || !db.prepare('SELECT 1 FROM wallet_snapshots WHERE date=? AND status = ?').get(date, 'ok'))) {
    // 直接從鏈上所有頭寸估值（含沒被追蹤、已撤流動性但還沒 collect 的），不經過追蹤表（Codex review）
    let lpUsd = 0, lpFees = 0; const lpMissing: string[] = []
    for (const o of onchain) { const v = valueOnchainPosition(o, stockMap)
      if (v) { lpUsd += v.valueUsd; lpFees += v.feesUsd } else if (o.amount0 > 0 || o.amount1 > 0 || o.fee0 > 0 || o.fee1 > 0) lpMissing.push(`${o.protocol}#${o.tokenId}`) }
    const adjust = Number(process.env.CAPITAL_ADJUST_USD ?? 0) || 0
    try {
      const call = alchemyCall(process.env.ALCHEMY_KEY, usage); const block = await rpc.getBlockNumber()   // 用讀餘額那個節點的區塊，轉帳查詢截止在同一個區塊
      const dep = netDeposits(await fetchUsdgTransfers(call, trackAddr, block), trackAddr, cps, ADDR.usdg)
      const w = await walletValue(rpc, db, trackAddr as `0x${string}`, block)
      db.prepare(`INSERT OR REPLACE INTO wallet_snapshots(date,taken_at,block,status,wallet_usd,lp_usd,lp_fees_usd,net_deposit_usd,adjust_usd,detail) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(date, new Date().toISOString(), Number(block), w.missing.length || lpMissing.length ? 'incomplete' : 'ok', w.usd, lpUsd, lpFees, dep.net, adjust, JSON.stringify({ wallet: w.detail, missing: [...w.missing, ...lpMissing], deposits: dep }))
      log(`wallet: tokens $${w.usd.toFixed(2)} + LP $${lpUsd.toFixed(2)} + fees $${lpFees.toFixed(2)} vs net deposit $${dep.net.toFixed(2)} (${dep.n} transfers)${w.missing.length ? ' missing price: ' + w.missing.join(',') : ''}`)
    } catch (e) {
      db.prepare(`INSERT OR REPLACE INTO wallet_snapshots(date,taken_at,status,detail) VALUES (?,?,?,?)`).run(date, new Date().toISOString(), 'error', String((e as Error).message ?? e).slice(0, 300))
      log(`wallet: FAILED ${String((e as Error).message ?? e).slice(0, 120)}`)
    }
  }
  exportPositions(db, 'data/positions')
  log(`positions: ${onchain.length} onchain, ${vals.length} tracked (${vals.filter(v => v.isNew).length} new, ${vals.filter(v => v.closed).length} closed)`)
  return vals
}
