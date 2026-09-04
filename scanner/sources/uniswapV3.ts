// scanner/sources/uniswapV3.ts — Uniswap v3：Factory 發現、池合約 Swap / Mint / Burn log。只讀
import { parseAbiItem, parseAbi } from 'viem'
import { ADDR } from '../../config/chain.js'
import type { Rpc } from './rpc.js'
import type { DiscoveredPool, SwapLog } from './uniswapV4.js'

export const V3_FACTORY = '0x1f7d7550b1b028f7571e69a784071f0205fd2efa' as const
export const V3_NPM = '0x73991a25c818bf1f1128deaab1492d45638de0d3' as const
export const POOL_CREATED_EVENT = parseAbiItem('event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)')
export const V3_SWAP_EVENT = parseAbiItem('event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)')
export const V3_MINT_EVENT = parseAbiItem('event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)')
export const V3_BURN_EVENT = parseAbiItem('event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)')
export const V3_POOL_ABI = parseAbi(['function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)', 'function liquidity() view returns (uint128)'])

export function decodePoolCreated(log: any): DiscoveredPool {
  const a = log.args
  return { protocol: 'v3', poolId: String(a.pool).toLowerCase(), currency0: String(a.token0).toLowerCase(), currency1: String(a.token1).toLowerCase(),
    feeRaw: Number(a.fee), feePpm: Number(a.fee), tickSpacing: Number(a.tickSpacing), hooks: ADDR.zero, createdBlock: BigInt(log.blockNumber) }
}
/** 一邊是 USDG 的 v3 池。topic 精確過濾時 public RPC 允許全鏈範圍一次查（backfill 用 chunk = 全範圍） */
export async function discoverV3UsdgPools(rpc: Rpc, from: bigint, to: bigint, chunk?: bigint): Promise<DiscoveredPool[]> {
  const [a, b] = await Promise.all([
    rpc.getLogsChunked({ address: V3_FACTORY, event: POOL_CREATED_EVENT, args: { token0: ADDR.usdg } }, from, to, chunk),
    rpc.getLogsChunked({ address: V3_FACTORY, event: POOL_CREATED_EVENT, args: { token1: ADDR.usdg } }, from, to, chunk),
  ])
  return [...a, ...b].map(decodePoolCreated)
}
/** v3 Swap 沒有 fee 欄位，用池子固定費率填入，之後與 v4 共用 aggregateHourly / simulate */
export async function fetchV3Swaps(rpc: Rpc, pool: string, feePpm: number, from: bigint, to: bigint): Promise<SwapLog[]> {
  const logs = await rpc.getLogsChunked({ address: pool as `0x${string}`, event: V3_SWAP_EVENT }, from, to)
  return logs.map((l: any) => ({ blockNumber: BigInt(l.blockNumber), txHash: String(l.transactionHash), logIndex: Number(l.logIndex), sender: String(l.args.sender).toLowerCase(),
    amount0: BigInt(l.args.amount0), amount1: BigInt(l.args.amount1), sqrtPriceX96: BigInt(l.args.sqrtPriceX96), liquidity: BigInt(l.args.liquidity), tick: Number(l.args.tick), fee: feePpm }))
    .sort((x, y) => (x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : x.blockNumber < y.blockNumber ? -1 : 1))
}
export async function fetchV3LiquidityEvents(rpc: Rpc, pool: string, from: bigint, to: bigint): Promise<{ txHash: string; sender: string }[]> {
  const [m, b] = await Promise.all([
    rpc.getLogsChunked({ address: pool as `0x${string}`, event: V3_MINT_EVENT }, from, to),
    rpc.getLogsChunked({ address: pool as `0x${string}`, event: V3_BURN_EVENT }, from, to),
  ])
  return [...m, ...b].map((l: any) => ({ txHash: String(l.transactionHash), sender: String(l.args.owner).toLowerCase() }))
}
