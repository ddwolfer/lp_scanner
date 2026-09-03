import { it, expect } from 'vitest'
import { taipeiDate, isUsWeekday, hourBucket } from '../scanner/time.js'
it('taipeiDate 用 Asia/Taipei 日期', () => {
  expect(taipeiDate(new Date('2026-09-02T23:30:00Z'))).toBe('2026-09-03')  // 台北 07:30
})
it('isUsWeekday：台北週一 07:30 = 紐約週日 19:30 → false；台北週二 → true', () => {
  expect(isUsWeekday(new Date('2026-09-06T23:30:00Z'))).toBe(false) // 2026-09-07 台北週一
  expect(isUsWeekday(new Date('2026-09-07T23:30:00Z'))).toBe(true)  // 台北週二，紐約週一收盤後
})
it('hourBucket', () => { expect(hourBucket(1_757_000_123)).toBe(1_756_998_000) })
