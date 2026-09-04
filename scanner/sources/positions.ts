// scanner/sources/positions.ts — 唯讀讀取某地址的 Uniswap v4 頭寸（PositionManager NFT + StateView）。無簽名、無私鑰（SPEC §10）
import { parseAbi, keccak256, encodeAbiParameters, parseAbiItem } from 'viem'
import { ADDR, CHAIN } from '../../config/chain.js'
import type { Rpc } from './rpc.js'
import { fetchJson } from './http.js'
import type { ApiUsage } from './usage.js'

export const POSITION_MANAGER = '0x58daec3116aae6d93017baaea7749052e8a04fa7' as const
const PM_ABI = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'function getPoolAndPositionInfo(uint256 tokenId) view returns (PoolKey poolKey, uint256 info)',
  'function getPositionLiquidity(uint256 tokenId) view returns (uint128)',
  'function ownerOf(uint256 tokenId) view returns (address)',
])
const SV_ABI = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getFeeGrowthInside(bytes32 poolId, int24 tickLower, int24 tickUpper) view returns (uint256, uint256)',
  'function getPositionInfo(bytes32 poolId, address owner, int24 tickLower, int24 tickUpper, bytes32 salt) view returns (uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128)',
])
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)')
const Q256 = 2n ** 256n, Q128 = 2n ** 128n

/** PositionInfo 打包：bits [8..32) tickLower、[32..56) tickUpper（皆 int24），bit 0..8 hasSubscriber，其餘為 poolId 前 25 bytes */
export function decodePositionInfo(info: bigint): { tickLower: number; tickUpper: number } {
  return { tickLower: Number(BigInt.asIntN(24, (info >> 8n) & 0xffffffn)), tickUpper: Number(BigInt.asIntN(24, (info >> 32n) & 0xffffffn)) }
}
/** 區間頭寸在目前 sqrtPrice 的 raw 持有量（v3 公式） */
export function amountsForLiquidity(L: bigint, sqrtPriceX96: bigint, tickLower: number, tickUpper: number): { amount0: number; amount1: number } {
  const sp = Number(sqrtPriceX96) / 2 ** 96, sa = Math.sqrt(1.0001 ** tickLower), sb = Math.sqrt(1.0001 ** tickUpper), l = Number(L)
  if (sp <= sa) return { amount0: l * (sb - sa) / (sa * sb), amount1: 0 }
  if (sp >= sb) return { amount0: 0, amount1: l * (sb - sa) }
  return { amount0: l * (sb - sp) / (sp * sb), amount1: l * (sp - sa) }
}
/** 未領手續費（raw）：(feeGrowthInside − last) mod 2^256 × L / 2^128 */
export function unclaimedFees(L: bigint, inside: bigint, last: bigint): number {
  return Number(((inside - last + Q256) % Q256) * L / Q128)
}
export function poolIdOf(k: { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string }): string {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
    [k.currency0 as `0x${string}`, k.currency1 as `0x${string}`, k.fee, k.tickSpacing, k.hooks as `0x${string}`])).toLowerCase()
}
export interface OnchainPosition {
  tokenId: string; poolId: string; currency0: string; currency1: string; feePpm: number | null; hooks: string
  tickLower: number; tickUpper: number; liquidity: bigint; tick: number; sqrtPriceX96: bigint
  amount0: number; amount1: number; fee0: number; fee1: number   // raw 單位
}
/** 列出地址持有的 PositionManager tokenId：優先 Alchemy NFT API（1 次），否則掃 Transfer 事件（從 fromBlock 起） */
export async function listPositionTokenIds(rpc: Rpc, owner: string, usage: ApiUsage, alchemyKey?: string, fromBlock = 0n): Promise<string[]> {
  if (alchemyKey) {
    const url = `https://robinhood-mainnet.g.alchemy.com/nft/v3/${alchemyKey}/getNFTsForOwner?owner=${owner}&contractAddresses[]=${POSITION_MANAGER}&withMetadata=false&pageSize=100`
    const r = await fetchJson<{ ownedNfts: { tokenId: string }[] }>(url, { source: 'alchemy', usage })
    return r.ownedNfts.map(n => n.tokenId)
  }
  const to = await rpc.getBlockNumber()
  const logs = await rpc.getLogsChunked({ address: POSITION_MANAGER, event: TRANSFER, args: { to: owner as `0x${string}` } }, fromBlock, to, BigInt(CHAIN.getLogsChunk) * 10n)
  const ids = [...new Set(logs.map((l: any) => String(l.args.tokenId)))]
  const mine: string[] = []
  for (const id of ids) { const o = await rpc.call(() => rpc.client.readContract({ address: POSITION_MANAGER, abi: PM_ABI, functionName: 'ownerOf', args: [BigInt(id)] })); if (String(o).toLowerCase() === owner.toLowerCase()) mine.push(id) }
  return mine
}
export async function readV4Position(rpc: Rpc, tokenId: string): Promise<OnchainPosition> {
  const id = BigInt(tokenId)
  const [pk, info] = await rpc.call(() => rpc.client.readContract({ address: POSITION_MANAGER, abi: PM_ABI, functionName: 'getPoolAndPositionInfo', args: [id] }))
  const { tickLower, tickUpper } = decodePositionInfo(info)
  const poolId = poolIdOf(pk)
  const [liquidity, slot, [in0, in1]] = await Promise.all([
    rpc.call(() => rpc.client.readContract({ address: POSITION_MANAGER, abi: PM_ABI, functionName: 'getPositionLiquidity', args: [id] })),
    rpc.call(() => rpc.client.readContract({ address: ADDR.stateView, abi: SV_ABI, functionName: 'getSlot0', args: [poolId as `0x${string}`] })),
    rpc.call(() => rpc.client.readContract({ address: ADDR.stateView, abi: SV_ABI, functionName: 'getFeeGrowthInside', args: [poolId as `0x${string}`, tickLower, tickUpper] })),
  ])
  const salt = `0x${id.toString(16).padStart(64, '0')}` as `0x${string}`
  const [pl, last0, last1] = await rpc.call(() => rpc.client.readContract({ address: ADDR.stateView, abi: SV_ABI, functionName: 'getPositionInfo', args: [poolId as `0x${string}`, POSITION_MANAGER, tickLower, tickUpper, salt] }))
  const { amount0, amount1 } = amountsForLiquidity(liquidity, slot[0], tickLower, tickUpper)
  return { tokenId, poolId, currency0: pk.currency0.toLowerCase(), currency1: pk.currency1.toLowerCase(), feePpm: (pk.fee & 0x800000) ? null : pk.fee, hooks: pk.hooks.toLowerCase(),
    tickLower, tickUpper, liquidity, tick: slot[1], sqrtPriceX96: slot[0], amount0, amount1, fee0: unclaimedFees(pl, in0, last0), fee1: unclaimedFees(pl, in1, last1) }
}
export async function fetchV4Positions(rpc: Rpc, owner: string, usage: ApiUsage, alchemyKey?: string): Promise<OnchainPosition[]> {
  const ids = await listPositionTokenIds(rpc, owner, usage, alchemyKey)
  const out: OnchainPosition[] = []
  for (const id of ids) out.push(await readV4Position(rpc, id))
  return out
}

const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
export interface MintInfo { txHash: string; block: bigint; ts: number; deposits: Record<string, bigint> }  // deposits: token address → raw amount（owner 轉進 PoolManager 的）
/** 從 PositionManager 的 Transfer(0x0 → owner, tokenId) 找 mint 交易，並從 receipt 的 ERC20 Transfer 取投入量。公開 RPC 對 topic 精確過濾允許全鏈範圍（DECISIONS D29） */
export async function fetchMintInfo(rpc: Rpc, tokenId: string, owner: string): Promise<MintInfo | null> {
  const logs = await rpc.call(() => rpc.client.getLogs({ address: POSITION_MANAGER, event: TRANSFER, args: { from: ADDR.zero as `0x${string}`, tokenId: BigInt(tokenId) }, fromBlock: 0n, toBlock: 'latest' }))
  const mint = logs[0]; if (!mint) return null
  const [receipt, block] = await Promise.all([
    rpc.call(() => rpc.client.getTransactionReceipt({ hash: mint.transactionHash! })),
    rpc.call(() => rpc.client.getBlock({ blockNumber: mint.blockNumber! })),
  ])
  const deposits: Record<string, bigint> = {}
  for (const l of receipt.logs) {
    if (l.topics[0] !== ERC20_TRANSFER_TOPIC || l.topics.length !== 3) continue
    const from = '0x' + l.topics[1]!.slice(26), to = '0x' + l.topics[2]!.slice(26)
    if (from.toLowerCase() === owner.toLowerCase() && to.toLowerCase() === ADDR.poolManager) deposits[l.address.toLowerCase()] = (deposits[l.address.toLowerCase()] ?? 0n) + BigInt(l.data)
  }
  return { txHash: mint.transactionHash!, block: mint.blockNumber!, ts: Number(block.timestamp), deposits }
}
/** 從投入量反推開倉時的 sqrtPrice（raw）：兩邊都有 → amount1 = L(√P − √Pa)；只有 token0 → 價格 ≤ 下緣；只有 token1 → 價格 ≥ 上緣 */
export function sqrtPriceAtMint(L: bigint, amount0: number, amount1: number, tickLower: number, tickUpper: number): number {
  const sa = Math.sqrt(1.0001 ** tickLower), sb = Math.sqrt(1.0001 ** tickUpper), l = Number(L)
  if (amount1 > 0 && amount0 > 0) return amount1 / l + sa
  if (amount1 > 0) return sb
  return sa
}
