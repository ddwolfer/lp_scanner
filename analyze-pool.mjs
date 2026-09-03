// analyze-pool.mjs — 分析 Robinhood Chain 上 Uniswap v4 池子的 swap 紀錄，判斷是否刷量
// 用法:
//   npm i viem
//   node analyze-pool.mjs list  <tokenA> <tokenB>            # 列出這對代幣的所有 v4 池 (poolId / fee / tickSpacing / hooks)
//   node analyze-pool.mjs swaps <poolId> [lookbackBlocks]     # 分析某個池最近 N 個區塊的 swap (預設 50000)

import { createPublicClient, http, keccak256, encodeAbiParameters, parseAbiItem, getAddress } from 'viem'

const RPC = 'https://rpc.mainnet.chain.robinhood.com'            // Chain ID 4663
const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951' // v4 PoolManager singleton
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'         // 6 decimals
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'
const CHUNK = 5000  // 公開 RPC 對 getLogs 區塊範圍有限制，分段抓

const client = createPublicClient({ chain: { id: 4663, name: 'Robinhood Chain', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } }, transport: http(RPC) })

const initEvent = parseAbiItem('event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)')
const swapEvent = parseAbiItem('event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)')
const modLiqEvent = parseAbiItem('event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)')

async function getLogsChunked(params, fromBlock, toBlock) {
  const out = []
  for (let a = fromBlock; a <= toBlock; a += BigInt(CHUNK)) {
    const b = a + BigInt(CHUNK) - 1n > toBlock ? toBlock : a + BigInt(CHUNK) - 1n
    out.push(...await client.getLogs({ ...params, fromBlock: a, toBlock: b }))
  }
  return out
}

// ---------- list: 找出某對代幣的所有池 ----------
async function listPools(tokenA, tokenB) {
  const [c0, c1] = [getAddress(tokenA), getAddress(tokenB)].sort((x, y) => x.toLowerCase() < y.toLowerCase() ? -1 : 1)
  const latest = await client.getBlockNumber()
  // Initialize 是一次性事件，從創世掃起 (鏈很新，區塊數不多；太慢就把 0n 改成較近的區塊)
  const logs = await getLogsChunked({ address: POOL_MANAGER, event: initEvent, args: { currency0: c0, currency1: c1 } }, 0n, latest)
  for (const l of logs) {
    const { id, fee, tickSpacing, hooks } = l.args
    console.log(`${id}  fee=${(Number(fee) / 1e4).toFixed(3)}%  tickSpacing=${tickSpacing}  hooks=${hooks}  block=${l.blockNumber}`)
  }
  if (!logs.length) console.log('沒找到池子，確認代幣地址是否正確、或 hooks 池是否走別的 PoolManager')
}

// ---------- swaps: 分析某個池的成交 ----------
async function analyzeSwaps(poolId, lookback = 50000n) {
  const latest = await client.getBlockNumber()
  const from = latest > lookback ? latest - lookback : 0n
  const swaps = await getLogsChunked({ address: POOL_MANAGER, event: swapEvent, args: { id: poolId } }, from, latest)
  const lps   = await getLogsChunked({ address: POOL_MANAGER, event: modLiqEvent, args: { id: poolId } }, from, latest)
  console.log(`區塊 ${from} → ${latest}: ${swaps.length} 筆 swap, ${lps.length} 筆 LP 操作\n`)
  if (!swaps.length) return

  // v4 的 sender 是 router，不是真人；要拿 tx.from 才是真正的交易者
  const txCache = new Map()
  const rows = []
  for (const s of swaps) {
    if (!txCache.has(s.transactionHash)) {
      const [tx, blk] = await Promise.all([client.getTransaction({ hash: s.transactionHash }), client.getBlock({ blockNumber: s.blockNumber })])
      txCache.set(s.transactionHash, { from: tx.from, ts: Number(blk.timestamp) })
    }
    const { from: trader, ts } = txCache.get(s.transactionHash)
    // amount0/amount1 為 pool 視角 (負 = 池子付出)。方向用 amount0 正負判斷即可
    rows.push({ trader, ts, block: s.blockNumber, dir: s.args.amount0 > 0n ? 'sell0' : 'buy0', a0: s.args.amount0, a1: s.args.amount1, tx: s.transactionHash })
  }

  // 1. 依交易者彙總
  const byTrader = new Map()
  for (const r of rows) {
    const t = byTrader.get(r.trader) ?? { n: 0, buy: 0, sell: 0, vol1: 0n }
    t.n++; r.dir === 'buy0' ? t.buy++ : t.sell++
    t.vol1 += r.a1 < 0n ? -r.a1 : r.a1   // 用 currency1 側的絕對量當成交量 (若 currency1 是 USDG 即美元)
    byTrader.set(r.trader, t)
  }
  const sorted = [...byTrader.entries()].sort((a, b) => (b[1].vol1 > a[1].vol1 ? 1 : -1))
  const totalVol = sorted.reduce((s, [, t]) => s + t.vol1, 0n)
  console.log(`不同交易地址數: ${byTrader.size}`)
  console.log('前 5 名地址 (地址 | 筆數 | 買/賣 | 成交量佔比):')
  for (const [addr, t] of sorted.slice(0, 5))
    console.log(`  ${addr} | ${t.n} | ${t.buy}/${t.sell} | ${(Number(t.vol1 * 10000n / totalVol) / 100).toFixed(1)}%`)
  const top1 = Number(sorted[0][1].vol1 * 10000n / totalVol) / 100
  console.log(`\n第一名佔總成交量 ${top1}%  ${top1 > 60 ? '⚠️ 高度集中，疑似刷量' : '✓ 分散'}`)

  // 2. 來回打的模式: 同一地址相鄰兩筆方向相反且間隔 < 10 分鐘
  rows.sort((a, b) => a.ts - b.ts)
  const last = new Map(); let pingpong = 0
  for (const r of rows) {
    const p = last.get(r.trader)
    if (p && p.dir !== r.dir && r.ts - p.ts < 600) pingpong++
    last.set(r.trader, r)
  }
  console.log(`短時間內同地址反向對打: ${pingpong} 次 (占 ${(pingpong / rows.length * 100).toFixed(0)}%)  ${pingpong / rows.length > 0.3 ? '⚠️' : '✓'}`)

  // 3. 時間分布: 每小時筆數 (看是不是集中在幾個小時)
  const byHour = new Map()
  for (const r of rows) { const h = new Date(r.ts * 1000).toISOString().slice(0, 13); byHour.set(h, (byHour.get(h) ?? 0) + 1) }
  console.log('\n每小時筆數 (UTC):')
  for (const [h, n] of [...byHour.entries()].sort()) console.log(`  ${h}  ${'█'.repeat(Math.min(n, 60))} ${n}`)

  // 4. LP 是誰: 交易者和 LP 重疊的話，就是自己刷自己的池
  const lpAddrs = new Set()
  for (const l of lps) {
    const tx = await client.getTransaction({ hash: l.transactionHash })
    lpAddrs.add(tx.from)
  }
  const overlap = [...byTrader.keys()].filter(a => lpAddrs.has(a))
  console.log(`\nLP 地址數: ${lpAddrs.size}，同時也在交易的 LP: ${overlap.length}  ${overlap.length ? '⚠️ ' + overlap.join(', ') : '✓'}`)
}

const [cmd, ...args] = process.argv.slice(2)
if (cmd === 'list') await listPools(args[0], args[1] ?? USDG)
else if (cmd === 'swaps') await analyzeSwaps(args[0], args[1] ? BigInt(args[1]) : 50000n)
else console.log('用法見檔案頂端註解')
