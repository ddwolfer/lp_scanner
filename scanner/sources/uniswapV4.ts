// scanner/sources/uniswapV4.ts — 只讀 log 與 view 函式，無任何寫入路徑
import { parseAbiItem, parseAbi } from 'viem'
import { ADDR, DYNAMIC_FEE_FLAG } from '../../config/chain.js'
import type { Rpc } from './rpc.js'

export const INITIALIZE_EVENT = parseAbiItem('event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)')
export const SWAP_EVENT = parseAbiItem('event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)')
export const MODIFY_LIQUIDITY_EVENT = parseAbiItem('event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)')
const STATE_VIEW_ABI = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
])

export interface DiscoveredPool { poolId: string; currency0: string; currency1: string; feeRaw: number; feePpm: number | null; tickSpacing: number; hooks: string; createdBlock: bigint }
export function decodeInitialize(log: any): DiscoveredPool {
  const a = log.args; const feeRaw = Number(a.fee)
  return { poolId: String(a.id).toLowerCase(), currency0: String(a.currency0).toLowerCase(), currency1: String(a.currency1).toLowerCase(),
    feeRaw, feePpm: (feeRaw & DYNAMIC_FEE_FLAG) ? null : feeRaw, tickSpacing: Number(a.tickSpacing), hooks: String(a.hooks).toLowerCase(), createdBlock: BigInt(log.blockNumber) }
}
/** 池子宇宙：一邊是 USDG（DECISIONS C1）。股票白名單過濾在呼叫端做。 */
export async function discoverUsdgPools(rpc: Rpc, from: bigint, to: bigint): Promise<DiscoveredPool[]> {
  const [a, b] = await Promise.all([
    rpc.getLogsChunked({ address: ADDR.poolManager, event: INITIALIZE_EVENT, args: { currency0: ADDR.usdg } }, from, to),
    rpc.getLogsChunked({ address: ADDR.poolManager, event: INITIALIZE_EVENT, args: { currency1: ADDR.usdg } }, from, to),
  ])
  return [...a, ...b].map(decodeInitialize)
}
export interface SwapLog { blockNumber: bigint; txHash: string; logIndex: number; sender: string; amount0: bigint; amount1: bigint; sqrtPriceX96: bigint; liquidity: bigint; tick: number; fee: number }
export async function fetchSwaps(rpc: Rpc, poolId: string, from: bigint, to: bigint): Promise<SwapLog[]> {
  const logs = await rpc.getLogsChunked({ address: ADDR.poolManager, event: SWAP_EVENT, args: { id: poolId } }, from, to)
  return logs.map((l: any) => ({ blockNumber: BigInt(l.blockNumber), txHash: String(l.transactionHash), logIndex: Number(l.logIndex), sender: String(l.args.sender).toLowerCase(),
    amount0: BigInt(l.args.amount0), amount1: BigInt(l.args.amount1), sqrtPriceX96: BigInt(l.args.sqrtPriceX96), liquidity: BigInt(l.args.liquidity), tick: Number(l.args.tick), fee: Number(l.args.fee) }))
    .sort((x, y) => (x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : x.blockNumber < y.blockNumber ? -1 : 1))
}
export async function readSlot0(rpc: Rpc, poolId: string) {
  const [slot, liq] = await Promise.all([
    rpc.call(() => rpc.client.readContract({ address: ADDR.stateView, abi: STATE_VIEW_ABI, functionName: 'getSlot0', args: [poolId as `0x${string}`] })),
    rpc.call(() => rpc.client.readContract({ address: ADDR.stateView, abi: STATE_VIEW_ABI, functionName: 'getLiquidity', args: [poolId as `0x${string}`] })),
  ])
  return { sqrtPriceX96: BigInt(slot[0]), tick: Number(slot[1]), liquidity: BigInt(liq) }
}
export async function fetchModifyLiquidity(rpc: Rpc, poolId: string, from: bigint, to: bigint): Promise<{ txHash: string; sender: string }[]> {
  const logs = await rpc.getLogsChunked({ address: ADDR.poolManager, event: MODIFY_LIQUIDITY_EVENT, args: { id: poolId } }, from, to)
  return logs.map((l: any) => ({ txHash: String(l.transactionHash), sender: String(l.args.sender).toLowerCase() }))
}
