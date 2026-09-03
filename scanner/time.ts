// scanner/time.ts — 純函式，不讀系統時區
const fmt = (tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' })
function parts(d: Date, tz: string) {
  const p = Object.fromEntries(fmt(tz).formatToParts(d).map(x => [x.type, x.value]))
  return { ymd: `${p.year}-${p.month}-${p.day}`, weekday: p.weekday as string }
}
export function taipeiDate(d: Date): string { return parts(d, 'Asia/Taipei').ymd }
/** 掃描時刻對應的「紐約當地日」是否為週一～五（美股假日第一版不處理，DECISIONS D5） */
export function isUsWeekday(d: Date): boolean {
  return !['Sat', 'Sun'].includes(parts(d, 'America/New_York').weekday)
}
export function hourBucket(tsSec: number): number { return tsSec - (tsSec % 3600) }
