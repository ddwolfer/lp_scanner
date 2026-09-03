// scanner/sources/usage.ts — 每日各來源呼叫次數，寫進 scan_runs.api_calls（SPEC §5）
export class ApiUsage {
  private counts: Record<string, number> = {}
  inc(source: string, n = 1) { this.counts[source] = (this.counts[source] ?? 0) + n }
  toJSON() { return { ...this.counts } }
}
