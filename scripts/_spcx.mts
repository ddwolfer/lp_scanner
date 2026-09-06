import { makeRpc } from '../scanner/sources/rpc.js'
import { ApiUsage } from '../scanner/sources/usage.js'
import { fetchV3Swaps } from '../scanner/sources/uniswapV3.js'
import { openDb } from '../db/index.js'
const db = openDb('db/lp.sqlite'); const u = new ApiUsage(); const rpc = makeRpc({ usage: u }); const latest = await rpc.getBlockNumber()
for (const [pid, fee] of [['0xc612843321', 500], ['0xeb07d9587e', 3000]] as const) {
  const p = db.prepare('SELECT pool_id FROM pools WHERE pool_id LIKE ?').get(pid + '%') as any
  const sw = await fetchV3Swaps(rpc, p.pool_id, fee, latest - 830000n * 2n, latest)
  const dayAgo = latest - 830000n; const last24 = sw.filter(s => s.blockNumber >= dayAgo)
  const usd = (s: any) => Number(s.amount1 < 0n ? -s.amount1 : s.amount1) / 1e6
  console.log(`${pid} v3 ${fee / 1e4}%: 48h swaps ${sw.length} vol $${Math.round(sw.reduce((a, s) => a + usd(s), 0)).toLocaleString()} | last 24h swaps ${last24.length} vol $${Math.round(last24.reduce((a, s) => a + usd(s), 0)).toLocaleString()} fees $${last24.reduce((a, s) => a + usd(s) * fee / 1e6, 0).toFixed(2)} | last price ${sw.at(-1) ? (Number(sw.at(-1)!.sqrtPriceX96) / 2 ** 96) ** 2 * 1e12 : '-'}`)
}
console.log('calls', u.toJSON())
