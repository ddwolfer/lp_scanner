# D65：頭寸「是否該換池」提示 + 低費率池補抓

## 背景
- 9/25 使用者開了 SPCX/USDG v3 0.05%（費/TVL 0.23%/日，是 v4 1% 池的三倍）。掃描器依 D16 對 `fee_ppm < fee_ppm_min(1000)` 的池不抓 swap，所以資料庫裡這類池永遠 24h 量 0，`pnpm range`/頭寸模擬/保本線都空白，也沒法比較「我在的池 vs 同股票其他池」。
- 使用者要求：日報的頭寸段加一行「是否考慮換池」。只提示，不動作（SPEC §10）。

## 範圍
1. **低費率池補抓（限定範圍）**：靜態 `fee_ppm < fee_ppm_min` 且無流動性 hook、TVL ≥ `min_tvl_usd` 的池，只在「該股票有未關閉頭寸」或在 `config/scoring.json` 新增的 `scan.watch_symbols` 名單內時才抓 swap 並寫 hourly。全量開放是 +139 池（現在每晚 371 池，+37% RPC），配合昨天的 403 問題不划算；限定後約 +5–10 池。快照仍標 `fee_out_of_range`、`excluded=1`、不進模擬與排名，Top 5 不變。
2. **純函式 `scanner/metrics/poolSwitch.ts`**：`switchHint(held, alts, cfg)`。
   - 輸入：held/alt 各自最近 7 天的 `{date, feesUsd(LP 實得), tvlUsd, ok}`（`ok=false` = 當天 `swap_fetch_failed`、跳過）；頭寸 `depositUsd`；held/alt 的 swap 費率（交易者總費）；gas 設定；頭寸實收費速 `paceUsdPerDay`（來自 listPositions 的 breakeven.paceUsdPerDay）與持有天數。
   - 日費率 = 當日 fees/tvl。7 日平均 = Σfees / Σtvl（有效日）。有效日 < 3 → `no_data`。
   - 規則：(a) 最佳替代池「最近 3 個有效日」每天都 ≥ ratio(1.5)× held → 候選；(b) 多賺 = deposit × (alt7 − held7)/日；換池成本 = deposit/2 × (held 費率+0.1%) + deposit/2 × (alt 費率+0.1%) + 4 gas（沿用 lifecycleCost 的近似）；成本 ÷ 多賺 ≤ `recover_days_max`(14) → `consider`，否則 `stay`。(c) 持有 ≥ 5 天且 pace < `cold_usd_per_day`(1) → `cold`（整檔股票冷掉，不是換池問題），優先於 (a)(b)。
   - 輸出：`{verdict, heldRate7, best:{poolId,label,rate7}|null, daysAbove, extraPerDay, switchCostUsd, recoverDays}`。
   - 替代池只比同股票 × USDG、`hook_kind != liquidity`、TVL ≥ min_tvl_usd、含低費率池。
3. **接線**：`server/queries.ts` 新增 `poolAlternatives(db, poolId, date, 7)`；`listPositions` 每筆加 `switchHint`。`formatPositions` 在頭寸行下加一行 `  ⚖️ 費/TVL 7日 0.14%/日 vs 最佳替代 v4 1% 0.08%/日 → 留`；`consider` 時附「多賺 $X/日，換池成本 $Y，Z 天回本」。`web/src/pages/Positions.tsx` 卡片同一行。
4. **設定**：`scoring.json` 新增 `switch_hint: {ratio:1.5, days:3, recover_days_max:14, cold_usd_per_day:1, cold_min_days:5}` 與 `scan.watch_symbols: []`。
5. **測試**：poolSwitch 純函式（stay / consider / cold / no_data / 有 swap_fetch_failed 日被跳過 / 只有 2 個有效日）；formatPositions 新行；run.ts 的 `worth` 判斷抽成純函式 `shouldFetchSwaps()` 加測試（低費率 + 持有 → 抓；低費率 + 不持有 → 不抓；流動性 hook 永遠不抓）。
6. **DECISIONS.md** D65；SPEC §13 範例加一行。

## 不做
- 不自動換池、不改排名規則、不改 fee_ppm_min。
- 不用 30 天量（GOOGL 9/11–12 單日爆量會扭曲）。
