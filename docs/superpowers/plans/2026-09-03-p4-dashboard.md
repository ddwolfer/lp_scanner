# P4 Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** SPEC §9 三頁 dashboard（總覽 `/`、單池 `/pool/:id`、頭寸 `/positions`），Fastify 唯讀 JSON API 綁 0.0.0.0:3000，Vite + React + Recharts 靜態檔由同一個 server 供應；Windows 瀏覽器可開、可切換投入金額與區間檔位。頭寸登錄（§9.3 表單）是唯一寫入。

**Architecture:** `server/` 一個 Fastify 程序：`/api/*` 讀 SQLite（唯讀連線），`/api/positions` POST/PATCH 寫 positions 表；其餘路徑供應 `web/dist`（SPA fallback）。`web/` 是 Vite React app，前端只從 API 拿 JSON，切換檔位在前端做（`sim` JSON 已含 9 組）。PM2 保活（README 給指令）。

**Spec:** SPEC §9、§3（server/web）、§10.4（只綁區網、無 tunnel、無登入）、§12 P4/P5（頭寸登錄表單屬 P5，本計畫先做表單與卡片，回填曲線留 P5）。

## Global Constraints
- 繁體中文 UI；1080p 一頁看完前 20 名（總覽表列高緊湊）。
- 不做登入；Server 綁 `0.0.0.0`，只在區網用（§10.4）。
- 前端不打任何外部 API（只打自家 `/api`）。
- Node 22+、TypeScript。

## File Structure
```
server/index.ts        Fastify 啟動：static + api routes；PORT 預設 3000
server/api.ts          路由：GET /api/overview?date=、/api/dates、/api/pool/:id、/api/positions、POST /api/positions、PATCH /api/positions/:id/close
server/queries.ts      SQL 查詢函式（純 DB，可測）
web/index.html, vite.config.ts, src/main.tsx, src/App.tsx（router）
web/src/api.ts         fetch 包裝與型別
web/src/pages/Overview.tsx, Pool.tsx, Positions.tsx
web/src/components/…   RankArrow、FlagChips、SimCharts
tests/queries.test.ts  查詢函式測試（:memory:）
ops/ecosystem.config.cjs  pm2
```

### Task 1: server/queries.ts + 測試
- `getDates(db): string[]`（有快照的日期降冪）
- `getOverview(db, date): OverviewRow[]`：每池一列，join pools/tokens，含 `sim`（parsed）、`flags`、`score`、`excluded`、`rank_today`（score 降冪，排除者 null）、`rank_prev`（前一個日期的排名）。
- `getPool(db, id): { pool, token, snapshots: 30 天, hourly: 30 天, sim (最新), wash_detail, corporate_actions }`
- `listPositions(db)`, `createPosition(db, input)`, `closePosition(db, id, { closed_at, fees_final_usd, value_final_usd })`（fees/value 存進 notes JSON 與 position_snapshots 最後一列）。
- 測試：塞兩天快照，驗 rank_today/rank_prev；建/關頭寸。

### Task 2: server/index.ts + api.ts
- `fastify`、`@fastify/static`；`/api/overview` 預設最新日期；SPA fallback `setNotFoundHandler` 回 `index.html`。
- 手動測：`curl localhost:3000/api/dates`。

### Task 3: web 骨架（Vite + React + react-router + Recharts）
- `pnpm --filter` 不用；web 用自己的 `web/package.json`，root `package.json` 加 scripts：`web:dev`、`web:build`、`serve`。
- Overview：頂部 date 選擇、投入 {200/1000/5000}、區間 {r10/r25/rvol} 切換；「只看候選 / 全部」；表格欄：#、昨日→今日箭頭、池（symbol/USDG、v4、費率、hooks 標記）、TVL、7 日均量、vol7_cv、交易者、top1、價格偏離、原始 APR、**模擬 net APR**、在區間、score、flags（排除者灰底）。可依欄排序。
- Pool：頭部資訊 + 三張圖（TVL/量/費；池價 vs 參考價；三區間累積淨損益曲線，用 `simulateHourly` 的前端版 → 改為 API 回傳三條曲線點：server 端用 `simulateHourly` 算 `cum_net`）+ 刷量表 + 公司行動表。
- Positions：表單 + 卡片（現值/累積費/在區間/淨損益 暫用最新快照 sim 換算的估計；P5 才回填）。

### Task 4: 建置、pm2、README、實機檢查
- `pnpm web:build` → `web/dist`；`pnpm serve` 起 server；用 Chrome 開 `http://localhost:3000` 截圖確認三頁。
- `ops/ecosystem.config.cjs` + README：`pm2 start ops/ecosystem.config.cjs`。
- DECISIONS D27：頭寸現值估算方式；D28：server 只綁 0.0.0.0 無 auth，靠區網。
