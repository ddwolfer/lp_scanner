// scanner/metrics/protocolFee.ts — 協議費與 LP 實得費率（D60）。純函式，無鏈上呼叫。
// 背景：Uniswap 協議費已在 Robinhood Chain 啟用，交易者付的費有一部分進協議金庫，不進 LP 口袋。
//  v4：Swap 事件的 fee 欄是交易者付的總費，swapFee = pf + lpFee − pf×lpFee/1e6（ProtocolFeeLibrary）。
//      協議費先從輸入扣、LP 費對餘額收，所以 LP 實得 ppm = swapFee − pf（實測 MSTR：2899 − 400 = 2499 = 2500×(1−0.0004)）。
//  v3：Swap 事件沒有 fee 欄，我們填入池的 fee_ppm（交易者付的總費）；slot0.feeProtocol 的兩個 nibble 各代表一個方向，
//      n≠0 時協議抽 feeAmount/n，所以 pf = floor(fee_ppm / n)。實測 Robinhood Chain 為 0x66 → 兩方向都是 6。
export interface ProtocolFee { ppm0: number; ppm1: number }   // ppm0：token0 為輸入時；ppm1：token1 為輸入時

/** v4 slot0.protocolFee（uint24）低 12 位是 zeroForOne、高 12 位是 oneForZero */
export function decodeV4ProtocolFee(raw: number | bigint): ProtocolFee {
  const v = Number(raw); return { ppm0: v & 0xfff, ppm1: (v >> 12) & 0xfff }
}
/** v3 slot0.feeProtocol（uint8）低 4 位對 token0、高 4 位對 token1；值是分母 n（協議抽 1/n） */
export function decodeV3ProtocolFee(feeProtocol: number | bigint, poolFeePpm: number): ProtocolFee {
  const v = Number(feeProtocol); const n0 = v & 0xf, n1 = (v >> 4) & 0xf
  return { ppm0: n0 ? Math.floor(poolFeePpm / n0) : 0, ppm1: n1 ? Math.floor(poolFeePpm / n1) : 0 }
}
/** 這筆 swap 的 LP 實得費率（ppm）。pf 未知時：v4 靜態池可由事件反推（swapFee − 設定 LP 費），其餘回傳 null 代表未知 */
export function lpFeePpm(swapFeePpm: number, zeroForOne: boolean, pf: ProtocolFee | null, staticFeePpm: number | null): number | null {
  if (pf) return Math.max(0, swapFeePpm - (zeroForOne ? pf.ppm0 : pf.ppm1))
  if (staticFeePpm !== null && swapFeePpm > staticFeePpm) return staticFeePpm   // v4 靜態池：事件費 − 協議費 ≈ 設定 LP 費
  return null
}
