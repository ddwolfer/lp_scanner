# P5 On-chain Position Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每日從鏈上（唯讀）讀取 `TRACK_ADDRESS` 的 Uniswap v4 頭寸：池、區間、流動性、目前持有量、未領手續費，寫進 `positions` / `position_snapshots`，並以頭寸的真實區間與開倉時間跑 §7 模擬，dashboard 與 Telegram 顯示「實際 vs 模擬」差距（SPEC §9.3、§12 P5）。

**Architecture:** `sources/positions.ts`（Alchemy NFT API 列 tokenId → PositionManager / StateView 讀狀態；無 key 時退回掃 `Transfer` 事件）。`steps.ts` 加 `syncPositions`（自動建立/更新 positions，`source='onchain'`，tokenId 存 `notes` JSON）與 `writePositionSnapshot`。run.ts 階段 8。`server/queries.ts` 的 `listPositions` 改為：實際值來自 `position_snapshots`，模擬值用真實區間跑 `simulate`，兩者並列。v3 頭寸只列出流動性 > 0 者（目前為 0，先不實作 v3 讀取，記 D29）。

**Spec:** SPEC §9.3、§10（只讀）、§12 P5；DECISIONS D27（估算改為實際）。

## Global Constraints
- 只讀：`eth_call`、NFT API、getLogs。地址來自 `.env` `TRACK_ADDRESS`，不進 git。
- 價格軸：頭寸持有量換算 USD 用池價（股票側 × 池價 + USDG 側）。
- 未領手續費：`feeGrowthInside − feeGrowthInsideLast` × liquidity / 2^128（v4 StateView）。

## Tasks
1. `sources/positions.ts`：`fetchV4Positions(rpc, owner, alchemyKey?)` → `OnchainPosition[] = { tokenId, poolId, currency0, currency1, feePpm, tickLower, tickUpper, liquidity, tick, sqrtPriceX96, amount0, amount1, fee0, fee1 }`。純函式 `decodePositionInfo(info: bigint)`、`amountsForLiquidity(L, sqrtP, tl, tu)`、`unclaimedFees(...)` 附測試（用上面實測的 SPY 頭寸數字當 fixture：tick −209824、L 3901620141659787、預期 amount1 ≈ 950.5）。
2. `steps.ts`：`syncPositions(db, list, stockByAddr, date)`：以 `notes = {"source":"onchain","tokenId":…}` 對應；新頭寸自動建立（label = `${symbol} #${tokenId 後四碼}`，range 以 tick 換算成 USD，deposit_usd = 首次看到的市值，opened_at = 首次看到時間，flag 在 notes `deposit_estimated: true`）；流動性歸零 → `closed_at = now`。`writePositionSnapshot(db, id, date, { value_usd, fees_cum_usd, in_range })`。
3. run.ts 階段 8（`--sim-only` 也跑）：`TRACK_ADDRESS` 有值才做；寫入後摘要的頭寸列改為真實值：`SPY/USDG #9367  實際 +$25.6 / 模擬 +$22.1 (3d)  在區間 ✓`。
4. `server/queries.ts`：`listPositions` 回傳 `actual`（最新 snapshot）、`sim`（真實區間模擬）、`diff`、`history`（每日 actual vs sim 曲線）。Positions 頁改顯示兩條線與差距。
5. DECISIONS D29–D31、實跑、合併。
