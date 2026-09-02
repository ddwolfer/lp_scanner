# lp-scanner — Robinhood Chain 流動性池掃描器與 Dashboard 規格書

版本 1.0 · 2026-09-03 · 第一版為**純唯讀**系統

---

## 0. 給 Claude Code 的閱讀指引

- 這份文件是需求與約束，不是實作教學。架構內的技術選型可以調整，但 §2 目標、§7 評分公式、§10 安全邊界不可更動。
- 遇到規格未定義的細節，優先選「簡單、可人工核對」的方案，並在 `DECISIONS.md` 記錄。
- 開工前先完成 §11 的驗證清單，結果寫進 `DECISIONS.md`，再開始寫程式。
- 使用者是資深前端工程師（PixiJS / TypeScript），但不熟索引服務與 GraphQL；註解和文件用繁體中文，程式碼與識別字用英文。

---

## 1. 背景

Robinhood Chain（chainId 4663，Arbitrum Orbit L2）上有 Uniswap v2/v3/v4，並有 Robinhood 官方發行的代幣化股票（SOFI、IBM、AAPL 等）與 USDG 穩定幣配對的池子。v4 允許自訂費率，目前市場上充斥 3～5% 費率、TVL 幾千美元、APR 顯示數千 % 的池子，其中大量是剛開池、刷量、或即將被套利者掃光的陷阱。

本系統的目的是每天掃描這些池子，用可驗證的指標排除陷阱，找出**適合放一週以上**的池子，並追蹤使用者實際頭寸的淨損益，把真實數據回填到模型裡。

---

## 2. 目標與非目標

### 目標
1. 每日自動掃描 Robinhood Chain 上所有 Uniswap 池，儲存每日快照。
2. 對每個池計算 §6 的指標與 §7 的模擬淨收益，依 §8 規則篩選、評分。
3. 提供區網可存取的 dashboard（§9），在 Mac 上常駐，從 Windows 瀏覽器查看。
4. 每日透過 Telegram 推送前 5 名候選池與異動。
5. 追蹤使用者手動登錄的頭寸，記錄每日現值、累積手續費、是否在區間內。

### 非目標（第一版明確不做）
- 任何會簽署交易的功能：開倉、調整、領取手續費、swap。
- 分鐘級 / 新池狙擊策略（另立專案）。
- 私鑰、助記詞、錢包連線。
- 外網存取（Tailscale 之後再說）。

---

## 3. 系統架構

```
┌─────────────────────────────────────────────────────────┐
│ Mac (常駐)                                               │
│                                                          │
│  scanner/           每日 cron → 抓資料 → 算指標 → 寫 DB   │
│     ├─ sources/     各資料來源 adapter (可替換)            │
│     ├─ metrics/     指標與模擬計算 (純函式，可單元測試)     │
│     └─ notify/      Telegram 推送                         │
│                                                          │
│  db/lp.sqlite       SQLite (better-sqlite3)               │
│                                                          │
│  server/            Fastify，唯讀 JSON API，綁 0.0.0.0    │
│  web/               Vite + React + Recharts，靜態檔      │
└─────────────────────────────────────────────────────────┘
        ▲ http://<mac-ip>:3000        ▲ Telegram
   Windows 瀏覽器                     手機
```

- 單一 repo、pnpm workspace 或簡單的多目錄皆可。
- Node 22+，TypeScript。
- Scanner 與 server 是兩個獨立程序；scanner 由 launchd 或 CLYDE cron 觸發，server 用 pm2 保活。
- 排程：**每天一次，07:30 Asia/Taipei**（美股收盤後、台灣早上）。七天都跑，快照標記 `is_weekday`。

---

## 4. 鏈與合約常數

| 項目 | 值 |
|---|---|
| Chain ID | 4663 |
| 公開 RPC | `https://rpc.mainnet.chain.robinhood.com`（限速，只做備援） |
| 推薦 RPC | Alchemy（官方推薦，免費額度先用） |
| Explorer | `https://robinhoodchain.blockscout.com` |
| Uniswap v4 PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` |
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`（6 decimals） |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| 股票代幣 | 18 decimals，ERC-20 + ERC-8056（`uiMultiplier()`） |

以上地址在 §11 驗證時要對 Blockscout 再確認一次。

---

## 5. 資料來源與優先序

| 用途 | 首選 | 備援 | 備註 |
|---|---|---|---|
| 池子清單、每日 TVL / 成交量 / 手續費、小時級價格 | The Graph（Uniswap v4/v3 subgraph on chain 4663） | Mobula → 鏈上 RPC | 免費 10 萬次/月 |
| 股票代幣白名單、pending multiplier | Robinhood `GET https://api.robinhood.com/rhj/assets` | 無 | 60 req/s，每日拉一次 |
| 股票真實 bid/ask、停牌 | Robinhood `GET /rhj/prices/{symbol}` | 鏈上 Chainlink feed | 15s cache |
| 公司行動歷史 | Robinhood `GET /rhj/corporate-actions` | 鏈上 `UIMultiplierUpdated` 事件 | 1h cache |
| 刷量分析（tx.from、LP 地址） | 鏈上 RPC `Swap` / `ModifyLiquidity` log | 無 | 只對前 20 名池跑 |
| ETH/USD 價格 | subgraph 或 Mobula | Chainlink | ETH 配對池換算用 |

規則：
- 每個來源包成 `sources/<name>.ts`，統一介面，之後可替換。
- 所有外部呼叫要有重試、超時、與每日用量計數（寫進 `scan_runs` 表），方便知道免費額度用了多少。
- Bitquery 第一版不接。

---

## 6. 資料模型（SQLite）

```sql
-- 代幣
CREATE TABLE tokens (
  address        TEXT PRIMARY KEY,   -- lowercase
  symbol         TEXT,
  name           TEXT,
  decimals       INTEGER,
  kind           TEXT,               -- 'stock' | 'stable' | 'eth' | 'other'
  rh_asset_id    TEXT,               -- /assets 的 id，非股票為 NULL
  rh_status      TEXT,               -- ASSET_STATUS_*
  all_day_tradable TEXT,             -- tradingCapabilities.allDayTradability
  first_seen     TEXT
);

-- 池
CREATE TABLE pools (
  pool_id        TEXT PRIMARY KEY,   -- v4: bytes32 poolId; v3: 合約地址
  protocol       TEXT,               -- 'v2' | 'v3' | 'v4'
  token0         TEXT REFERENCES tokens,
  token1         TEXT REFERENCES tokens,
  fee_ppm        INTEGER,            -- v4 fee 單位 (1e6 = 100%)；動態費率池存 NULL
  tick_spacing   INTEGER,
  hooks          TEXT,               -- 零地址以外一律視為 hooks 池
  created_block  INTEGER,
  created_at     TEXT,
  quote_kind     TEXT                -- 'usdg' | 'eth' | 'other'，決定價格軸換算
);

-- 每日快照（每池每天一列）
CREATE TABLE pool_snapshots (
  pool_id        TEXT REFERENCES pools,
  date           TEXT,               -- YYYY-MM-DD (Asia/Taipei)
  is_weekday     INTEGER,
  tvl_usd        REAL,
  volume_24h_usd REAL,
  fees_24h_usd   REAL,
  price_usd      REAL,               -- token0 以 USD 計價
  price_ref_usd  REAL,               -- 股票代幣：Robinhood /prices mid；否則 NULL
  price_dev_pct  REAL,               -- (price_usd - price_ref_usd) / price_ref_usd
  swap_count     INTEGER,
  -- 刷量分析（只有前 20 名有值）
  trader_count   INTEGER,
  top1_share     REAL,
  pingpong_ratio REAL,
  lp_trader_overlap INTEGER,
  -- 衍生指標 (§6.2)
  age_days       INTEGER,
  vol7_avg_usd   REAL,
  vol7_cv        REAL,
  -- 模擬 (§7)，JSON: {"r10":{...},"r25":{...},"rvol":{...}}
  sim            TEXT,
  score          REAL,
  flags          TEXT,               -- JSON array of string
  PRIMARY KEY (pool_id, date)
);

-- 小時級價格（模擬用，保留 45 天）
CREATE TABLE pool_hourly (
  pool_id TEXT, ts INTEGER, price_usd REAL, volume_usd REAL, fees_usd REAL, tvl_usd REAL,
  PRIMARY KEY (pool_id, ts)
);

-- 股票代幣公司行動
CREATE TABLE corporate_actions (
  id TEXT PRIMARY KEY, token TEXT, type TEXT, status TEXT,
  effective_at TEXT, pending_multiplier TEXT, raw TEXT
);

-- 使用者頭寸（手動登錄）
CREATE TABLE positions (
  id INTEGER PRIMARY KEY, pool_id TEXT, label TEXT,
  range_lower REAL, range_upper REAL,          -- 以 price_usd 同單位
  deposit_usd REAL, deposit_token0 REAL, deposit_token1 REAL,
  opened_at TEXT, closed_at TEXT, notes TEXT
);
CREATE TABLE position_snapshots (
  position_id INTEGER, date TEXT,
  value_usd REAL, fees_cum_usd REAL, in_range INTEGER, gas_cum_usd REAL,
  PRIMARY KEY (position_id, date)
);

-- 掃描紀錄
CREATE TABLE scan_runs (
  id INTEGER PRIMARY KEY, started_at TEXT, finished_at TEXT, ok INTEGER,
  pools_scanned INTEGER, api_calls TEXT, error TEXT   -- api_calls: JSON {source: count}
);
```

### 6.1 價格軸規則
- `quote_kind = 'usdg'`：`price_usd` = 池內 token0/USDG 價格。
- `quote_kind = 'eth'`：`price_usd` = 池內 token0/ETH 價格 × ETH/USD。模擬與區間全部用 USD 計算，但 dashboard 要同時顯示原始 ETH 比率，並標註「此池區間單位為 ETH」。
- 其他配對第一版直接 `flags += "non_usd_quote"`，不進候選。

### 6.2 衍生指標定義
- `age_days` = today − created_at。
- `vol7_avg_usd` = 最近 7 個快照的 `volume_24h_usd` 平均（不足 7 天用現有天數，並 `flags += "short_history"`）。
- `vol7_cv` = 同期成交量的標準差 ÷ 平均（變異係數）。
- `price_dev_pct`：僅股票代幣 USDG 池；取快照當下池價 vs Robinhood mid。
- `trader_count / top1_share / pingpong_ratio / lp_trader_overlap`：沿用 `analyze-pool.mjs` 的定義（同 repo 內已有此腳本，作為刷量分析的參考實作）。

---

## 7. 模擬淨收益（核心指標）

對每個候選池，用過去 **N = min(30, 可用天數)** 天的小時級資料，模擬「在第一個小時以價格 P₀ 開一個對稱區間頭寸、投入 D 美元、之後不調整」的結果。

### 7.1 參數
- 投入金額 D ∈ {200, 1000, 5000}。
- 區間寬度 R，三檔並算：
  - `r10`：±10%
  - `r25`：±25%
  - `rvol`：±(2 × σ₇)，其中 σ₇ = 過去 7 天小時報酬率的標準差 × √(24×7)（換算成週波動率）；夾在 [5%, 40%]；資料不足 5 天時退回 ±25% 並 `flags += "rvol_fallback"`。
  - σ₇ 的價格來源：股票代幣優先用 Robinhood `/prices` 的歷史（若無歷史 endpoint，則從每日快照的 `price_ref_usd` 累積，前幾週用鏈上價格並標記）；非股票用 `pool_hourly.price_usd`。

### 7.2 每小時計算
以 Uniswap v3 集中流動性公式，區間 [Pₗ, Pᵤ] = [P₀(1−R), P₀(1+R)]：

```
L      = D / ( √P₀ − √Pₗ + (1/√P₀ − 1/√Pᵤ) × P₀ )    -- 兩邊各投一半的近似；實作時用標準公式
每小時 h：
  in_range_h = Pₗ ≤ P_h ≤ Pᵤ
  share_h    = in_range_h ? L / (L_pool_h + L) : 0
              -- L_pool_h 用該小時 tvl_usd 反推同區間內的流動性；第一版可用 D / (tvl_h + D) 近似，並在 DECISIONS.md 註明
  fee_h      = share_h × fees_usd_h
  value_h    = 依 v3 公式算頭寸在 P_h 的市值 (含區間外變成單邊持有)
```

### 7.3 輸出（每個 (D, R) 組合）
```json
{
  "fees_usd": 累積手續費,
  "value_end_usd": 期末頭寸市值,
  "il_usd": value_end_usd − D × (P_end/P₀ 持有對照)  ← 相對於單純持有的差額,
  "net_usd": fees_usd + value_end_usd − D,
  "net_pct": net_usd / D,
  "net_apr": net_pct × 365 / N,
  "in_range_hours": 在區間內小時數,
  "in_range_pct": in_range_hours / (N×24),
  "exits": 價格離開區間的次數
}
```
`sim` 欄位存 `{ "d200": {"r10":…, "r25":…, "rvol":…}, "d1000": …, "d5000": … }`。

### 7.4 驗證要求
- `metrics/simulate.ts` 必須是純函式，附單元測試：
  - 價格不動 → IL = 0，fees = 累積手續費 × 份額。
  - 價格單邊漲 30%、R = 10% → 期末 100% 持有 USDG，in_range 在突破後為 0。
  - 對稱漲跌回到原點 → value_end ≈ D（誤差 < 1%）。
- 提供 `scripts/sim-check.ts`：輸入 poolId 與日期範圍，印出逐小時表格，供人工對照 Uniswap 介面。

---

## 8. 篩選與評分

### 8.1 硬排除（任一命中即 `excluded = true`，仍記錄但不進排名）
| 規則 | 條件 | flag |
|---|---|---|
| 非股票且非主流 | token0 不在 Robinhood `/assets` 且 token1 也不在，且兩者都不是 ETH/USDG | `not_stock` |
| 假股票代幣 | symbol 看起來像股票但地址不在 `/assets` | `fake_stock` |
| hooks 池 | `hooks ≠ 0x000…0` | `has_hooks` |
| 費率異常 | `fee_ppm > 60000`（>6%）或 `< 1000`（<0.1%）；動態費率 NULL 也排除 | `fee_out_of_range` |
| 太新 | `age_days < 7` | `too_new` |
| 太小 | `tvl_usd < 5000` | `tvl_too_small` |
| 公司行動 pending | 該股票代幣 `pendingMultiplier ≠ ""` 且生效時間在 14 天內 | `corp_action_pending` |
| 停牌 | Robinhood `/prices` `isTradingHalt = true` | `halted` |
| 資產停用 | `rh_status ≠ ACTIVE` | `asset_inactive` |
| 刷量 | `top1_share > 0.6` 或 `pingpong_ratio > 0.3` 或 `lp_trader_overlap > 0` | `wash_suspect` |
| 非 USD 報價 | `quote_kind = 'other'` | `non_usd_quote` |

### 8.2 軟指標（進入評分）
| 指標 | 方向 | 說明 |
|---|---|---|
| `sim.d1000.r25.net_apr` | 高好 | **排序主鍵**（第一版） |
| `sim.d1000.r25.in_range_pct` | 高好 | 穩定度 |
| `vol7_cv` | 低好 | 成交量是否穩定 |
| `trader_count` | 高好 | ≥ 20 為健康 |
| `price_dev_pct` 絕對值 | 低好 | 偏離大 = 套利壓力大 |
| `tvl_usd` | 適中 | 太小稀釋快 |
| `all_day_tradable = 'tradable'` | 加分 | 底層 24/5 交易，跳空風險較低 |

### 8.3 評分
```
score = 0.40 × rank_norm(net_apr)
      + 0.20 × in_range_pct
      + 0.15 × (1 − clamp(vol7_cv, 0, 2) / 2)
      + 0.10 × clamp(trader_count / 50, 0, 1)
      + 0.10 × (1 − clamp(|price_dev_pct|, 0, 0.05) / 0.05)
      + 0.05 × (all_day_tradable ? 1 : 0)
```
`rank_norm` = 在當日未排除池中的百分位。權重是起點，之後依回填數據調整；權重放在 `config/scoring.json`，不寫死。

### 8.4 排序切換
- 第一版排序用 `d1000.r25`。
- 使用者手動核對數週、確認 `rvol` 欄位合理後，把 `config/scoring.json` 的 `sort_key` 改成 `d1000.rvol`。程式要支援任意 (D, R) 當排序鍵。

---

## 9. Dashboard 頁面

三頁，Vite + React + Recharts。純讀 API，無表單以外的寫入（頭寸登錄除外）。

### 9.1 總覽表 `/`
- 一列一池，預設只顯示未排除者，可切換顯示全部（排除者灰底、顯示 flags）。
- 欄位：池（symbol/symbol、協議、費率、hooks 標記）、TVL、7 日均量、`vol7_cv`、交易者數、top1 佔比、價格偏離、原始 APR、以及 **稀釋後模擬 net APR**。
- 頂部兩個切換：投入金額 {200 / 1000 / 5000}、區間 {±10% / ±25% / vol}。切換後整欄重算（資料已在 `sim` JSON 內，前端切換即可）。
- 可依任一欄排序；預設 `score` 降冪。
- 每列有「昨日排名 → 今日排名」小箭頭。

### 9.2 單池詳情 `/pool/:id`
- 頭部：池資訊、代幣種類、Robinhood 資產狀態、pending corporate action 警示。
- 圖 1：30 天 TVL / 成交量 / 手續費（三線）。
- 圖 2：30 天價格（池價 vs Robinhood 參考價兩線，股票代幣才有第二線）。
- 圖 3：三種區間的模擬累積淨損益曲線（同一張圖三條線），底部標出出區間的時點。
- 表：刷量分析（前 20 名才有），含前 5 名交易地址、每小時成交分布。
- 表：該股票的公司行動歷史。

### 9.3 我的頭寸 `/positions`
- 手動登錄表單：pool、區間上下限（USD）、投入金額、開倉日期、備註。
- 每個頭寸一張卡：現值、累積手續費、是否在區間內、淨損益、淨損益 vs 同期模擬值的差距（這是回填模型的核心數字）。
- 圖：實際淨損益曲線 vs `r25` 模擬曲線。
- 關閉頭寸時記錄實際領到的手續費與最終市值。

### 9.4 UI 原則
- 繁體中文。
- 深色主題可有可無，但表格要能在 1080p Windows 螢幕一頁看完前 20 名。
- 不要做登入。區網用。

---

## 10. 安全邊界（不可更動）

1. 整個 repo **不得**出現簽署交易的程式碼路徑：無 `signTransaction`、無 `walletClient`、無 private key 讀取、無助記詞。
2. 環境變數只允許 API key（Alchemy、The Graph、Mobula、Telegram bot token）。`.env` 進 `.gitignore`。
3. Robinhood REST API 是公開唯讀 endpoint，不需要也不得傳任何帳號資訊。
4. Server 只綁區網，不得加任何對外 tunnel。
5. Telegram bot 只推送，不接受會改變系統狀態的指令（第一版連查詢指令都不做）。

---

## 11. 開工前驗證清單（結果寫進 DECISIONS.md）

1. The Graph 上是否有 chain 4663 的 Uniswap v4 與 v3 subgraph？記錄 subgraph id、可用欄位（尤其 `poolHourData` 是否存在）。沒有的話改用 Mobula，記錄其 endpoint 與 credit 消耗。
2. `GET https://api.robinhood.com/rhj/assets` 實際回傳格式，與 SOFI / IBM 的合約地址；對照使用者截圖中的 `0x98E7…A926`。
3. `/prices/{symbol}` 是否有歷史資料 endpoint；若無，記錄「歷史參考價需自行每日累積」。
4. §4 的所有合約地址對 Blockscout 驗證。
5. Alchemy 是否支援 chain 4663、免費額度的 `eth_getLogs` 區塊範圍上限。
6. 用 `analyze-pool.mjs` 對截圖中的 SOFI/USDG 池實跑一次，確認 log 解析正確。
7. 估算每日掃描的各來源呼叫次數，確認在免費額度內。

---

## 12. 分階段交付

| 階段 | 內容 | 驗收 |
|---|---|---|
| P0 | §11 驗證、repo 骨架、schema、config | `DECISIONS.md` 完成，`pnpm test` 可跑 |
| P1 | Scanner：清單 + 每日快照 + Robinhood 白名單 + 硬排除 | 連續跑 3 天，`pool_snapshots` 有資料，Telegram 收到每日摘要 |
| P2 | 模擬 §7 + 評分 §8 + 單元測試 + `sim-check.ts` | 使用者用 `sim-check` 手動核對至少 2 個池 |
| P3 | 刷量分析接進 scanner（前 20 名） | 截圖中疑似刷量的池被正確標記 |
| P4 | Dashboard 三頁 | Windows 瀏覽器可開、可切換檔位 |
| P5 | 頭寸登錄與回填 | 使用者用 $200 實際開一個頭寸並追蹤一週 |

P1 跑起來後就先累積資料，P2～P4 平行做。P4 的圖在有 7 天資料前不需要好看。

---

## 13. Telegram 每日摘要格式

```
📊 LP 掃描 2026-09-10 (三)
掃描 312 池，候選 14

Top 5 (投入 $1000, ±25%)
1. SOFI/USDG v4 3.29%  net APR 412%  在區間 91%  交易者 34
2. ...

⚠️ 異動
- IBM/USDG 掉出候選: corp_action_pending (分割 09-15 生效)
- AAPL/USDG 新進候選

💼 我的頭寸
- SOFI/USDG #1  +$18.40 (7d)  在區間 ✓
```

---

## 14. 待第二版的項目（記錄，不做）
- 分鐘級新池策略。
- 波動率區間當主排序（依 §8.4 切換）。
- 依回填數據自動調整評分權重。
- 自動開倉 / 調整區間（需完全獨立的安全審查）。
- Tailscale 外網存取。
