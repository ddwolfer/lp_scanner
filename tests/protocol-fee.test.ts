import { describe, it, expect } from 'vitest'
import { decodeV4ProtocolFee, decodeV3ProtocolFee, lpFeePpm } from '../scanner/metrics/protocolFee.js'
describe('協議費解碼', () => {
  it('v4 slot0.protocolFee 兩方向（實測 MSTR raw=1638800 → 400/400）', () => expect(decodeV4ProtocolFee(1638800)).toEqual({ ppm0: 400, ppm1: 400 }))
  it('v4 兩方向不同也要各自解出', () => expect(decodeV4ProtocolFee((300 << 12) | 500)).toEqual({ ppm0: 500, ppm1: 300 }))
  it('v4 未啟用', () => expect(decodeV4ProtocolFee(0)).toEqual({ ppm0: 0, ppm1: 0 }))
  it('v3 feeProtocol=0x66 → 抽 1/6（實測 Robinhood Chain）', () => expect(decodeV3ProtocolFee(0x66, 3000)).toEqual({ ppm0: 500, ppm1: 500 }))
  it('v3 兩個 nibble 分開', () => expect(decodeV3ProtocolFee(0x40, 3000)).toEqual({ ppm0: 0, ppm1: 750 }))
})
describe('LP 實得費率', () => {
  it('v4 靜態：事件 2899、協議 400 → 2499（= 2500×(1−0.0004)）', () => expect(lpFeePpm(2899, true, { ppm0: 400, ppm1: 400 }, 2500)).toBe(2499))
  it('v4 TSLA：3499 − 500 → 2999', () => expect(lpFeePpm(3499, true, { ppm0: 500, ppm1: 500 }, 3000)).toBe(2999))
  it('依方向取不同協議費', () => expect(lpFeePpm(3499, false, { ppm0: 500, ppm1: 0 }, 3000)).toBe(3499))
  it('v3：總費 3000、協議 500 → 2500', () => expect(lpFeePpm(3000, true, decodeV3ProtocolFee(0x66, 3000), 3000)).toBe(2500))
  it('協議費未知但是 v4 靜態池 → 由事件反推回設定 LP 費', () => expect(lpFeePpm(2899, true, null, 2500)).toBe(2500))
  it('協議費未知且動態費率池 → null（標記未知，不當成 0）', () => expect(lpFeePpm(2899, true, null, null)).toBeNull())
  it('協議費未啟用時等於事件費', () => expect(lpFeePpm(3000, true, { ppm0: 0, ppm1: 0 }, 3000)).toBe(3000))
})
