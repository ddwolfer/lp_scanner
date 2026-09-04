// scripts/backfill-pools.ts — 一次性從創世掃 Initialize（DECISIONS 11.7），可中斷續跑
import 'dotenv/config'
import { openDb, getMeta, setMeta } from '../db/index.js'
import { ApiUsage } from '../scanner/sources/usage.js'
import { makeRpc } from '../scanner/sources/rpc.js'
import { discoverUsdgPools } from '../scanner/sources/uniswapV4.js'
import { discoverV3UsdgPools } from '../scanner/sources/uniswapV3.js'
import { fetchAssets } from '../scanner/sources/robinhood.js'
import { upsertTokens, upsertPools, isStockUsdgPool } from '../scanner/steps.js'
const db = openDb('db/lp.sqlite'); const usage = new ApiUsage(); const rpc = makeRpc({ usage })
const assets = await fetchAssets({ usage }); upsertTokens(db, assets, new Date().toISOString())
const stockSet = new Set(assets.map(a => a.address))
const latest = await rpc.getBlockNumber(); const STEP = 2_000_000n
let cursor = BigInt(getMeta(db, 'backfill_cursor') ?? '0'); let total = 0; const t0 = Date.now()
while (cursor <= latest) {
  const to = cursor + STEP - 1n > latest ? latest : cursor + STEP - 1n
  const found = await discoverUsdgPools(rpc, cursor, to)
  const blockTs = new Map<string, string>()
  for (const p of found) if (isStockUsdgPool(p, stockSet) && !blockTs.has(p.createdBlock.toString()))
    blockTs.set(p.createdBlock.toString(), new Date(Number((await rpc.call(() => rpc.client.getBlock({ blockNumber: p.createdBlock }))).timestamp) * 1000).toISOString())
  const n = upsertPools(db, found, stockSet, blockTs); total += n
  console.log(`${cursor}→${to}: ${found.length} usdg pools, +${n} stock pools (calls ${JSON.stringify(usage.toJSON())}, ${Math.round((Date.now() - t0) / 1000)}s)`)
  cursor = to + 1n; setMeta(db, 'backfill_cursor', cursor.toString())
}
// v3：PoolCreated 對 USDG 精確 topic 過濾，全鏈一次查（DECISIONS D34）
if (getMeta(db, 'v3_backfill_done') !== '1') {
  const v3 = await discoverV3UsdgPools(rpc, 0n, latest, latest + 1n)
  const blockTs3 = new Map<string, string>()
  for (const p of v3) if (isStockUsdgPool(p, stockSet) && !blockTs3.has(p.createdBlock.toString()))
    blockTs3.set(p.createdBlock.toString(), new Date(Number((await rpc.call(() => rpc.client.getBlock({ blockNumber: p.createdBlock }))).timestamp) * 1000).toISOString())
  const n3 = upsertPools(db, v3, stockSet, blockTs3); total += n3; setMeta(db, 'v3_backfill_done', '1')
  console.log(`v3: ${v3.length} usdg pools, +${n3} stock pools`)
}
setMeta(db, 'last_discovery_block', latest.toString())
console.log(`backfill 完成，新增 ${total} 池，共 ${(db.prepare('SELECT COUNT(*) c FROM pools').get() as any).c} 池`); db.close()
