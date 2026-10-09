// scanner/positionsStage.ts — 鏈上頭寸回填（P5）。run.ts 每日呼叫，scripts/sync-positions.ts 手動呼叫
import type Database from 'better-sqlite3'
import { ADDR, CHAIN, STOCK_DECIMALS, USDG_DECIMALS } from '../config/chain.js'
import { makeRpc, type Rpc } from './sources/rpc.js'
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
/** D74：要不要（再）從 mint 交易補真實開倉時間與投入：鏈上頭寸、投入仍是估計、還沒有 mint_tx、而且沒有加減倉（有的話補回原始投入會覆蓋調整後的本金） */
export function needsOrigin(notes: any, journalKinds: string[]): boolean {
  if (!notes || notes.source !== 'onchain' || notes.deposit_estimated !== true || notes.mint_tx) return false
  if ((notes.liquidity_changes ?? []).length) return false
  return !journalKinds.includes('adjust')
}
/** D74：找 mint 交易的區塊範圍。投入仍是估計的頭寸，opened_at 是「第一次看到」的時間，mint 一定在那之前不久；
 *  用每塊約 0.104 秒推算當時的區塊，往前 2 天、往後 1 天（容許出塊速度誤差），不超過目前區塊 */
export function mintSearchRange(atBlock: bigint, firstSeenMs: number, nowMs: number, secPerBlock = 0.104): { fromBlock: bigint; toBlock: bigint } {
  const day = BigInt(Math.round(86400 / secPerBlock)); const est = atBlock - BigInt(Math.max(0, Math.round((nowMs - firstSeenMs) / 1000 / secPerBlock)))
  const from = est - 2n * day; const to = est + day
  return { fromBlock: from < 0n ? 0n : from, toBlock: to > atBlock ? atBlock : to }
}
/** 等 p 最多 ms 毫秒，逾時回 null（底下的 RPC 呼叫會自己結束，不再等它） */
export const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | null> =>
  Promise.race([p.catch(() => null), new Promise<null>(r => setTimeout(() => r(null), Math.max(0, ms)).unref?.())])
/** 同上但分得出「逾時／失敗」與「查完了但沒有」：前者下次重查同一段，後者下次往更舊的區塊查（Codex review） */
export const TIMEOUT: unique symbol = Symbol('timeout')
export function withTimeoutTagged<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  const t = new Promise<typeof TIMEOUT>(r => { setTimeout(() => r(TIMEOUT), Math.max(0, ms)).unref?.() })
  return Promise.race<T | typeof TIMEOUT>([p.catch((): typeof TIMEOUT => TIMEOUT), t])
}
/** 沒找到時下一段往前查的範圍：從上次查過的最舊區塊再往前 3 天 */
export const olderMintRange = (searchedFrom: bigint, secPerBlock = 0.104): { fromBlock: bigint; toBlock: bigint } => {
  const d3 = BigInt(Math.round(3 * 86400 / secPerBlock)); return { fromBlock: searchedFrom > d3 ? searchedFrom - d3 : 0n, toBlock: searchedFrom }
}
export type SnapshotDeps = { readRpc?: Rpc; logsRpc?: Rpc; originBudgetMs?: number }
export async function runPositionsStage(db: Database.Database, usage: ApiUsage, trackAddr: string, date: string, now: Date, log: (m: string) => void, mode: SnapshotMode = 'if_missing', deps: SnapshotDeps = {}): Promise<PositionValuation[]> {
  // D74：讀狀態（eth_call）走 Alchemy，不受公用 RPC 403 影響；getLogs（列 tokenId 的退路、找 mint 交易）一定走公用 RPC。READ_RPC=public 可關掉
  const alchemyUrl = process.env.ALCHEMY_KEY && process.env.READ_RPC !== 'public' ? `https://robinhood-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY}` : null
  const readRpc = deps.readRpc ?? (alchemyUrl ? makeRpc({ usage, url: alchemyUrl, source: 'alchemy_rpc' }) : makeRpc({ usage }))
  const logsRpc = deps.logsRpc ?? makeRpc({ usage, url: CHAIN.publicRpc, blockMaxMs: 90_000 })   // 明確指定公用 RPC，不吃 RPC_URL 覆寫（Codex review）
  const stockMap = new Map((db.prepare(`SELECT address, symbol FROM tokens WHERE kind='stock'`).all() as { address: string; symbol: string }[]).map(t => [t.address, { tokenSymbol: t.symbol }]))
  const at = await readRpc.getBlockNumber()   // 固定讀取區塊：頭寸與錢包都讀這個區塊（Codex plan review）
  const onchain = [...await fetchV4Positions(readRpc, trackAddr, usage, process.env.ALCHEMY_KEY, { logsRpc, at }), ...await fetchV3Positions(readRpc, trackAddr, at)]
  const vals = syncPositions(db, onchain, stockMap, now.toISOString())
  // 先寫快照（即時結果不等歷史補查）
  for (const v of vals) if ((!v.closed || v.isNew) && shouldWriteSnapshot(db, v.positionId, date, v.isNew, mode)) writePositionSnapshot(db, v.positionId, date, { ...v, priceUsd: v.priceUsd })
  // D70：錢包總值對淨入金（要 ALCHEMY_KEY 與 CAPITAL_COUNTERPARTIES；失敗只記 error，不影響頭寸）。當天快照只有 ok 才不覆蓋，失敗或不完整的之後的同步可以補
  const cps = (process.env.CAPITAL_COUNTERPARTIES ?? '').split(',').map(x => x.trim()).filter(Boolean)
  if (cps.length && process.env.ALCHEMY_KEY && (mode === 'force' || !db.prepare('SELECT 1 FROM wallet_snapshots WHERE date=? AND status = ?').get(date, 'ok'))) {
    // 直接從鏈上所有頭寸估值（含沒被追蹤、已撤流動性但還沒 collect 的），不經過追蹤表（Codex review）
    let lpUsd = 0, lpFees = 0; const lpMissing: string[] = []
    for (const o of onchain) { const v = valueOnchainPosition(o, stockMap)
      if (v) { lpUsd += v.valueUsd; lpFees += v.feesUsd } else if (o.amount0 > 0 || o.amount1 > 0 || o.fee0 > 0 || o.fee1 > 0) lpMissing.push(`${o.protocol}#${o.tokenId}`) }
    const adjust = Number(process.env.CAPITAL_ADJUST_USD ?? 0) || 0
    try {
      const call = alchemyCall(process.env.ALCHEMY_KEY, usage); const block = at   // 跟頭寸同一個區塊（D74）
      const dep = netDeposits(await fetchUsdgTransfers(call, trackAddr, block), trackAddr, cps, ADDR.usdg)
      const w = await walletValue(readRpc, db, trackAddr as `0x${string}`, block)
      db.prepare(`INSERT OR REPLACE INTO wallet_snapshots(date,taken_at,block,status,wallet_usd,lp_usd,lp_fees_usd,net_deposit_usd,adjust_usd,detail) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(date, new Date().toISOString(), Number(block), w.missing.length || lpMissing.length ? 'incomplete' : 'ok', w.usd, lpUsd, lpFees, dep.net, adjust, JSON.stringify({ wallet: w.detail, missing: [...w.missing, ...lpMissing], deposits: dep }))
      log(`wallet: tokens $${w.usd.toFixed(2)} + LP $${lpUsd.toFixed(2)} + fees $${lpFees.toFixed(2)} vs net deposit $${dep.net.toFixed(2)} (${dep.n} transfers)${w.missing.length ? ' missing price: ' + w.missing.join(',') : ''}`)
    } catch (e) {
      db.prepare(`INSERT OR REPLACE INTO wallet_snapshots(date,taken_at,status,detail) VALUES (?,?,?,?)`).run(date, new Date().toISOString(), 'error', String((e as Error).message ?? e).slice(0, 300))
      log(`wallet: FAILED ${String((e as Error).message ?? e).slice(0, 120)}`)
    }
  }
  // D74：歷史補查（找 mint 交易補真實開倉時間與投入）放最後，整段有總時間上限，逾時不影響已寫好的快照與錢包；沒補到的下次同步再試
  const deadline = Date.now() + (deps.originBudgetMs ?? 120_000)
  for (const v of vals) {
    if (v.closed) continue
    const row = db.prepare('SELECT notes FROM positions WHERE id=?').get(v.positionId) as { notes: string | null }
    const notes = (() => { try { return JSON.parse(row?.notes ?? '') } catch { return null } })()
    const kinds = (db.prepare('SELECT kind FROM position_journal WHERE position_id=?').all(v.positionId) as { kind: string }[]).map(r => r.kind)
    if (!needsOrigin(notes, kinds)) { if (notes?.deposit_estimated && !notes?.mint_tx) log(`position ${v.label}: 投入仍是估計但已有加減倉，不自動補原始投入`); continue }
    const left = deadline - Date.now(); if (left <= 0) { log(`position ${v.label}: 補查開倉交易時間用完，下次同步再試`); continue }
    const oc = onchain.find(o => o.poolId === v.poolId && o.tokenId === v.tokenId)!
    // 第一次查「首次看到」附近；之前查過沒有就從查過的最舊區塊再往前（mint_searched_from），一路往前直到區塊 0
    const searched = notes?.mint_searched_from !== undefined ? BigInt(notes.mint_searched_from) : null
    if (searched === 0n) continue   // 全鏈都查過了
    const range = searched !== null ? olderMintRange(searched) : mintSearchRange(at, Date.parse((db.prepare('SELECT opened_at FROM positions WHERE id=?').get(v.positionId) as { opened_at: string }).opened_at), now.getTime())
    const res = await withTimeoutTagged(fetchMintInfo(logsRpc, oc.tokenId, trackAddr, { ...(oc.protocol === 'v3' ? { nft: V3_NPM, depositTo: oc.poolId } : {}), ...range }), left)
    if (res === TIMEOUT) { log(`position ${v.label}: 查開倉交易逾時或失敗，投入先用首次看到的市值，下次重查`); continue }
    if (!res) { db.prepare('UPDATE positions SET notes=? WHERE id=?').run(JSON.stringify({ ...notes, mint_searched_from: range.fromBlock.toString() }), v.positionId)
      log(`position ${v.label}: 區塊 ${range.fromBlock}–${range.toBlock} 沒有開倉交易，下次往前查`); continue }
    const mint = res
    const stockIs0 = stockMap.has(oc.currency0); const stockAddr = stockIs0 ? oc.currency0 : oc.currency1
    const stockRaw = Number(mint.deposits[stockAddr] ?? 0n), usdgRaw = Number(mint.deposits[ADDR.usdg] ?? 0n)
    const a0 = stockIs0 ? stockRaw : usdgRaw, a1 = stockIs0 ? usdgRaw : stockRaw
    const sp = sqrtPriceAtMint(mint.liquidity ?? oc.liquidity, a0, a1, oc.tickLower, oc.tickUpper)   // 用 mint 當下的流動性反推開倉價
    const priceRaw = sp * sp; const price = stockIs0 ? priceRaw * 10 ** (STOCK_DECIMALS - USDG_DECIMALS) : 1 / (priceRaw * 10 ** (USDG_DECIMALS - STOCK_DECIMALS))
    const deposit = stockRaw / 10 ** STOCK_DECIMALS * price + usdgRaw / 10 ** USDG_DECIMALS
    setPositionOrigin(db, v.positionId, new Date(mint.ts * 1000).toISOString(), deposit, { mint_tx: mint.txHash, mint_block: mint.block.toString(), mint_price: price, deposit_stock: stockRaw / 10 ** STOCK_DECIMALS, deposit_usdg: usdgRaw / 10 ** USDG_DECIMALS })
    log(`position ${v.label}: opened ${new Date(mint.ts * 1000).toISOString().slice(0, 16)} deposit $${deposit.toFixed(2)} @ ${price.toFixed(2)}`)
  }
  exportPositions(db, 'data/positions')
  log(`positions: ${onchain.length} onchain, ${vals.length} tracked (${vals.filter(v => v.isNew).length} new, ${vals.filter(v => v.closed).length} closed)`)
  return vals
}
