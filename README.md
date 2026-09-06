# lp_scanner

Robinhood Chain（chainId 4663）上「股票代幣 × USDG」Uniswap v4 與 v3 流動性池的每日掃描器與 dashboard。**純唯讀**：不簽任何交易、不碰私鑰，只讀鏈上資料與公開 API。

- 規格：`SPEC.md`（§2 目標、§7 模擬公式、§10 安全邊界不可更動）
- 所有驗證結果與設計決策：`DECISIONS.md`（權威來源，遇到「為什麼這樣做」先看這裡）
- 實作計畫：`docs/superpowers/plans/`

## 它每天做什麼（07:30 Asia/Taipei）

1. 拉 Robinhood `/rhj/assets` 白名單（194 檔股票代幣）、`/prices`、`/corporate-actions`
2. 從鏈上 v4 `Initialize` 與 v3 `PoolCreated` 事件增量發現新池，只收「股票 × USDG」
3. 對通過預篩的池拉當日 `Swap` log，自算每小時價格 / 成交量 / 手續費 / 池流動性（`pool_hourly`）
4. TVL 來自 DexScreener；算衍生指標；§8.1 硬排除（費率、hooks、太新、太小、公司行動、停牌、刷量）
5. §7 模擬：三種投入 × 三種區間，逐小時算手續費份額、IL、淨損益、在區間比例
6. §8.3 評分排名；前 20 名跑刷量分析（真實交易者地址、對打、LP 重疊）
7. 讀 `TRACK_ADDRESS` 的鏈上頭寸，記真實現值與未領手續費，和模擬對照
8. Telegram 推送 Top 5、異動、我的頭寸；匯出 `data/positions/<tokenId>.json`

## 安裝

```
pnpm install
cp .env.example .env
mkdir -p logs
```

`.env` 只放 key，不進 git：

| 變數 | 用途 |
|---|---|
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` / `TELEGRAM_TOPIC_ID` | 每日摘要推送（topic 選填） |
| `ALCHEMY_KEY` | 選填。只用在 `eth_getTransactionByHash`（刷量分析）與 NFT API（列頭寸）；免費方案 getLogs 只給 10 塊範圍，所以 log 一律走公開 RPC |
| `TRACK_ADDRESS` | 選填。要追蹤 LP 頭寸的公開地址（唯讀） |

## 首次

```
pnpm backfill      # 從創世掃 Initialize（約 40 分鐘，可中斷續跑）
pnpm scan          # 跑一次每日流程（約 30 分鐘）
```

## 排程與常駐

```
# 每日掃描（launchd，Mac 時區需為 Asia/Taipei）
cp ops/com.lp-scanner.daily.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.lp-scanner.daily.plist

# Dashboard 常駐（pm2）
pnpm web:build
npm i -g pm2 && pm2 start ops/ecosystem.config.cjs && pm2 save && pm2 startup
```

Dashboard：`http://<mac-ip>:3000`，綁 `0.0.0.0`，無登入，只在區網用。

- `/` 總覽：投入 / 區間 / 候選切換、欄位排序、昨→今排名、flags
- `/pool/:id` 單池：30 天 TVL / 量 / 費、池價 vs 參考價、三區間累積淨損益、刷量分析、公司行動
- `/positions` 我的頭寸：鏈上現值、未領手續費、實際 vs 模擬、日誌（文字 + 截圖）

## 常用指令

```
pnpm test && pnpm typecheck      # 65 個單元測試（含 SPEC §7.4 三個模擬驗證）
pnpm scan --sim-only             # 不重抓資料，只重跑模擬 / 評分 / 刷量 / 頭寸（改 config/scoring.json 後用）
pnpm sim-check <poolId> [D=1000] [R=0.25] [from] [to]   # 逐小時模擬表格，供人工對照 Uniswap 介面
pnpm positions                   # 立刻同步 TRACK_ADDRESS 的鏈上頭寸（v3 + v4），開完倉不用等隔天
pnpm costs [天數] [--symbol X]    # 列出自己發起的交易：gas（USD）與 USDG/股票代幣流向，合計真實淨利
pnpm pool <SYMBOL|poolId> [--live]  # 一檔股票所有池的體檢：費/TVL、熱度、hook、模擬、波動率、容量、回本
pnpm range <poolId> <下限> <上限> [投入]  # 開倉前評自訂區間：歷史在區間比例、配比、模擬手續費、份額、容量
pnpm probe-alchemy               # 測 Alchemy key 的 getLogs 範圍限制
pnpm web:dev                     # 前端開發（Vite 5173，/api proxy 到 3000）
```

## 目錄

```
config/      鏈常數（chain.ts）、評分權重與門檻（scoring.json，不寫死）
db/          schema.sql、openDb；lp.sqlite 不進 git
scanner/     sources/（rpc、robinhood、dexscreener、uniswapV4、traders、positions）
             metrics/（price、hourly、derived、exclusions、lp-math、volatility、simulate、score、wash；全為純函式）
             notify/（summary、telegram）、steps.ts（DB 寫入）、run.ts（每日流程）
server/      Fastify 唯讀 API（唯一寫入：頭寸登錄 / 關閉 / 日誌）
web/         Vite + React + Recharts
scripts/     backfill-pools、sim-check、probe-alchemy
ops/         launchd plist、pm2 config
data/        頭寸 JSON 與截圖（不進 git）
tests/       vitest
```

## 階段狀態

| 階段 | 內容 | 狀態 |
|---|---|---|
| P0 | §11 驗證、骨架、schema、config | 完成 |
| P1 | 每日快照 + 白名單 + 硬排除 + Telegram | 完成，累積資料中 |
| P2 | §7 模擬 + §8 評分 + sim-check | 完成，需 ≥7 天資料才有意義 |
| P3 | 刷量分析 | 完成 |
| P4 | Dashboard | 完成 |
| P5 | 鏈上頭寸回填、實際 vs 模擬、日誌 | 完成 |
