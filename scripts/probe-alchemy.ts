// scripts/probe-alchemy.ts — 有 ALCHEMY_KEY 時測 getLogs 區塊範圍上限（DECISIONS 11.5 未驗證項）
import 'dotenv/config'
import { CHAIN, ADDR } from '../config/chain.js'
import { ApiUsage } from '../scanner/sources/usage.js'
import { makeRpc } from '../scanner/sources/rpc.js'
import { INITIALIZE_EVENT } from '../scanner/sources/uniswapV4.js'
const key = process.env.ALCHEMY_KEY; if (!key) { console.log('ALCHEMY_KEY 未設定'); process.exit(0) }
const rpc = makeRpc({ usage: new ApiUsage(), url: CHAIN.alchemyRpc(key), source: 'alchemy', concurrency: 1 })
const latest = await rpc.getBlockNumber()
for (const range of [10n, 2000n, 10_000n, 100_000n, 1_000_000n]) {
  try { const logs = await rpc.client.getLogs({ address: ADDR.poolManager, event: INITIALIZE_EVENT, args: { currency1: ADDR.usdg }, fromBlock: latest - range, toBlock: latest }); console.log(`range ${range}: ok ${logs.length} logs`) }
  catch (e) { console.log(`range ${range}: ERR ${(e as Error).message.split('\n')[0]}`) }
}
