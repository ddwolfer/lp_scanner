# DECISIONS.md — §11 開工前驗證結果與設計決策

日期：2026-09-03 · 狀態：§11 驗證完成，使用者已於 2026-09-03 確認下方「已確認的決策」，進入 P0/P1

所有查證均在本機以 curl / RPC / 瀏覽器實測，非憑印象。註記「未驗證」者表示需要 API key 或需使用者提供資訊。

---

## 11.1 The Graph 上是否有 chain 4663 的 Uniswap subgraph？ → **沒有**

**查證來源**：The Graph 官方網路登錄檔 `https://networks-registry.thegraph.com/TheGraphNetworksRegistry.json`（版本 0.7.118）

```json
{ "id": "robinhood", "caip2Id": "eip155:4663",
  "services": { "subgraphs": [], "substreams": ["robinhood.substreams.pinax.network:443"], "firehose": [...] } }
```

- `services.subgraphs` 為空陣列 → The Graph 去中心化網路**不提供** Robinhood Chain 的 subgraph 索引，只有 Pinax 的 Substreams / Firehose（需自行寫 Substreams 模組，非 GraphQL）。
- 因此 §5 首選「The Graph Uniswap v4/v3 subgraph」**不可行**，`poolHourData` 等欄位無從取得。

**替代方案調查**（全部實測或讀官方頁）：

| 來源 | 狀態 | 費用 / 限制 | 適合拿什麼 |
|---|---|---|---|
| **公開 RPC** `rpc.mainnet.chain.robinhood.com` | 可用 | `eth_getLogs` 單次上限 10,000 筆 log；100k 區塊範圍 OK；1M 範圍回 `Too Many Requests`；連發會 429 | Initialize / Swap / ModifyLiquidity log、`eth_call` |
| **Alchemy** `robinhood-mainnet.g.alchemy.com/v2/<key>` | 官方支援 4663 | 免費 30M CU/月、500 CU/s；`eth_getLogs` 通則：任意範圍上限 10K logs 或 2K 區塊不限筆數。**注意**：Alchemy 文件寫免費方案在部分鏈 getLogs 只允許 10 個區塊範圍，Robinhood Chain 是否受限**未驗證（需 key）** | 備援 RPC、`eth_call` |
| **Mobula** `api.mobula.io/api/2/...`，chainId `robinhood` | 官方列為支援 | 免費 10,000 credits/月、1 RPS；`token/markets`（每 token 最多 25 個池，含 liquidityUSD、volume24hUSD、DEX 名、fee tier）；`market/ohlcv-history`（支援 `1h`，每次最多 2000 根，**5 credits/次**） | 池子 TVL / 24h 量、小時級 OHLCV |
| **DexScreener** `api.dexscreener.com/token-pairs/v1/robinhood/<token>` | 可用、免 key | 60 req/min | 每 token 的池清單（含 v4 poolId、liquidity.usd、volume.h24、priceUsd）；無歷史 |
| **Goldsky** | 支援 4663，subgraph 相容 The Graph | 一次性 $100 credit（非每月），用完即暫停；付費 $0.05/worker-hr | 自架 Uniswap v4 subgraph（可行但要自己寫/改 subgraph） |
| **Envio HyperSync** `robinhood.hypersync.xyz` | 一級支援 | 需 token，免費額度數字未公開 | 大量 log 拉取 |
| **Blockscout Pro API** `api.blockscout.com/4663/api/v2` | 可用 | 免費 100K credits/日、5 RPS（約 5,000 次/日） | 地址/合約/交易查詢；`robinhoodchain.blockscout.com` 本身對 curl 有 Cloudflare 擋 |

**建議（與 §5 不同）**：
1. **主來源改為鏈上 RPC 自算**：v4 `Swap` 事件本身帶 `sqrtPriceX96`、`liquidity`、`fee`、`amount0/1`，足以自建每小時 price / volume / fees / 池內流動性，不需要任何索引服務，也沒有 credit 問題。`pool_hourly` 表由我們自己從 Swap log 聚合。
2. **TVL / 池子發現用 DexScreener（免 key）+ Mobula `token/markets`（備援）**：兩者都以「token → 池清單」查詢，正好配合 Robinhood `/assets` 白名單（194 個代幣 → 194 次/日）。
3. **Mobula OHLCV 只留作 P2 對照用**，不進每日排程（5 credits × 300 池會爆額度）。
4. The Graph 相關 env / adapter 不寫；`sources/` 介面保留 `subgraph` 插槽以便日後有人部署。

---

## 11.2 Robinhood `/rhj/assets` 格式與 SOFI / IBM 地址 → **驗證通過**

`GET https://api.robinhood.com/rhj/assets`：HTTP 200，154 KB，**194 個資產**，全部 `ASSET_STATUS_ACTIVE`、全部部署在 chainId 4663、全部 `tokenDecimals = 18`、目前 `pendingMultiplier` 全為空字串。

實際欄位（與 §6 對照）：

```
id, tokenSymbol, tokenName, deployments[{contractAddress, chainId, networkName}],
currentMultiplier, pendingMultiplier, status, logoUrl,
tradingCapabilities.{market,extended,overnight}.{whole,fractional}, tokenDecimals, isin
```

| Symbol | 地址 | 鏈上 `symbol()` / `name()` |
|---|---|---|
| SOFI | `0x98E75885157C80992A8D41b696D8c9C6Fb30A926` | SOFI / SoFi Technologies • Robinhood Token |
| IBM | `0x980dcf6766FA79f5Cf0c4AAdb3ab477ff15a9619` | IBM / IBM • Robinhood Token |
| AAPL | `0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9` | — |
| MSFT | `0xe93237C50D904957Cf27E7B1133b510C669c2e74` | — |

- 使用者截圖中的 `0x98E7…A926` **= 官方 SOFI**，正確。
- `/prices/SOFI` 回傳 `deployments[0].contractAddress` 也是同一地址，可交叉比對。

**與規格不符**：
- §6 `tokens.all_day_tradable` 引用 `tradingCapabilities.allDayTradability`，**此欄位不存在**。實際是 `market / extended / overnight` 三段各有 `whole / fractional`。
  → 建議：`all_day_tradable = (tradingCapabilities.overnight.whole === 'TRADING_STATUS_TRADABLE')`，並把整個 `tradingCapabilities` 原文存進 `tokens.raw`。
- `/corporate-actions` 可用（200），欄位：`id, type (CORPORATE_ACTION_TYPE_CASH_DIVIDEND…), status, processDate{year,month,day}, tokenSymbol, deployments, details`。目前 in-progress 的是 MSFT / KSS 等現金股利。§6 `corporate_actions.effective_at` 對應 `processDate`。

---

## 11.3 `/prices/{symbol}` 是否有歷史 endpoint？ → **沒有**

`GET https://api.robinhood.com/rhj/prices/SOFI` → 200：

```json
{"quotes":[{"tokenSymbol":"SOFI","bid":"17.9","ask":"17.91","currency":"USD","dailyTradingVolume":"30680280",
  "isTradingHalt":false,"generatedAt":"2026-09-02T19:10:29Z","dailyHigh":"17.93","dailyLow":"16.89",
  "mintBurnTokenVolume":"2520.489","mintBurnUsdVolume":"45129.355545"}]}
```

嘗試過的歷史路徑全部失敗：`/prices/SOFI/history` 404、`/prices/history/SOFI` 404、`/historical-prices/SOFI` 404、`/prices/SOFI?interval=1h` 400、`/prices?symbols=SOFI,IBM` 400（gRPC 錯誤：`GetPricesRequest` 無 `symbols` 欄位）、`/prices/SOFI,IBM` 404。

**決策**：「歷史參考價需自行每日累積」。σ₇（§7.1）在累積滿 7 天前，統一用 `pool_hourly.price_usd`（鏈上池價，由 Swap log 自算）並 `flags += "sigma_from_pool"`。

附註：`generatedAt` 是美東前一日 19:10 UTC（收盤後），`/prices` 在非交易時段回的是最後成交價，符合我們 07:30 台北抓取的需求。

---

## 11.4 §4 合約地址驗證 → **全部通過**

Blockscout 網站對 curl / WebFetch 回 Cloudflare 挑戰頁，改用 **Chrome 瀏覽器** 逐一開頁核對，並以公開 RPC `eth_getCode` / `eth_call` 二次確認：

| 項目 | 地址 | Blockscout 顯示 | RPC 驗證 |
|---|---|---|---|
| v4 PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` | Contract name **PoolManager**，已驗證原始碼 | code 24,009 bytes |
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | Proxy → impl **USDG**，token「Global Dollar (USDG)」 | symbol=USDG, name=Global Dollar, **decimals=6** ✓ |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | Proxy → impl **aeWETH**（Arbitrum 標準橋接 WETH） | symbol=WETH, decimals=18 ✓ |
| SOFI | `0x98E75885157C80992A8D41b696D8c9C6Fb30A926` | Proxy → impl **Stock** | `uiMultiplier()`（selector `0xa60bf13d`）回 `1e18` ✓ |

Chain ID：RPC `eth_chainId` = `0x1237` = 4663 ✓。

**補充：Uniswap 官方部署頁（developers.uniswap.org）列出的 Robinhood Chain 其他地址**，P1 會用到：

| 合約 | 地址 |
|---|---|
| v4 StateView（讀 slot0 / liquidity 用） | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` |
| v4 PositionManager | `0x58daec3116aae6d93017baaea7749052e8a04fa7` |
| v4 Quoter | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` |
| v3 UniswapV3Factory | `0x1f7d7550b1b028f7571e69a784071f0205fd2efa` |
| v3 NonfungiblePositionManager | `0x73991a25c818bf1f1128deaab1492d45638de0d3` |
| v2 Factory | `0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f` |
| UniversalRouter | `0x8876789976decbfcbbbe364623c63652db8c0904` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

（這些尚未逐一在 Blockscout 開頁，P1 接觸到時再驗。）

---

## 11.5 Alchemy 是否支援 4663、免費額度 getLogs 上限 → **支援；免費方案 getLogs 只允許 10 個區塊（已實測）**

**2026-09-03 實測（使用者提供 key，app 啟用 Robinhood Mainnet 後）**：`eth_blockNumber` 正常；`eth_getLogs` 任何超過 10 塊的範圍都回：

```
Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range. Upgrade to PAYG for expanded block range.
```

一天 83 萬塊 ÷ 10 = 83,000 次/池，完全不可行。**決策定案：log 一律走 public RPC；Alchemy 只保留給 `eth_call` / `getBlock` 備援**（目前程式未切換，public RPC 撐得住，見 11.7 補充）。

- Alchemy 官方頁明列 Robinhood Chain mainnet：`https://robinhood-mainnet.g.alchemy.com/v2/<API_KEY>`，支援 RPC / Token / Transfers / Prices / Webhooks；**不支援** Debug / Trace。
- 免費方案：**30M CU / 月**、500 CU/s、5 apps。`eth_getLogs` 約 60–75 CU/次 → 每日約 1M CU ≈ 13,000 次 getLogs 預算。
- getLogs 通則：任意區塊範圍但回應 ≤ 10K logs，或 ≤ 2K 區塊範圍不限筆數，回應 ≤ 150 MB。
- **風險**：Alchemy 文件寫 Ethereum / Arbitrum / Base 等鏈**免費方案只允許 10 個區塊範圍**。Robinhood Chain 出塊 **~0.104 秒/塊（≈ 830,000 塊/日）**，若 10 塊上限也適用，Alchemy 免費方案就完全不能拿來掃 log。
  → 決策：**public RPC 當 log 主來源**（實測 100k 塊範圍可用），Alchemy 只做 `eth_call` 與備援；使用者拿到 key 後跑一次 `scripts/probe-alchemy.ts` 確認 getLogs 範圍。

**公開 RPC 實測數字**（給 §11.7 用）：
- `eth_getLogs` 回應上限 10,000 logs（`logs matched by query exceeds limit of 10000`）。
- 100,000 塊範圍 + topic 過濾 OK；1,000,000 塊回 `Too Many Requests`。
- 全 PoolManager 不加 pool 過濾，10,000 塊就超過 10K logs → **不能整鏈拉 Swap，必須逐池查**。

---

## 11.6 `analyze-pool.mjs` 實跑 → **log 解析正確，但兩個規則需調整**

我手上沒有使用者的截圖，改用 DexScreener 列出 SOFI 的 29 個池，挑 **成交量最大的 SOFI/USDG v4 池**：

`0xb6a881c32ed115cb8790c182580c71607ee7b7b008b4e1c3c65b1bc29b891b53`（liq ≈ $20.1k，24h vol ≈ $81k）

執行 `node analyze-pool.mjs swaps 0xb6a8… 200000`（約 5.8 小時區塊，78 秒跑完）：

```
區塊 52613341 → 52813341: 66 筆 swap, 18 筆 LP 操作
不同交易地址數: 37
第一名佔總成交量 16.19%  ✓ 分散
短時間內同地址反向對打: 0 次 (占 0%)  ✓
每小時筆數集中在 UTC 13–19（美股盤中）
LP 地址數: 9，同時也在交易的 LP: 4  ⚠️
```

另以原始 RPC 對同池數過去 24h（830k 塊、9 段）Swap：**763 筆**，與腳本結果量級一致；解析（topic、tx.from、amount 方向）確認正確。

**與規格不符 / 建議**：
1. **`lp_trader_overlap > 0` 即判刷量太嚴**：最健康的 SOFI/USDG 池就有 4 個 LP 也在交易（做市商調倉是正常行為）。建議改成「重疊 LP 的成交量佔比 > 50%」才標 `wash_suspect`，`lp_trader_overlap` 仍照數記錄。
2. **預設 lookback 50,000 塊只有 ~1.4 小時**（0.104 s/塊）。Scanner 內要用 830k 塊 = 一整天，切 100k 段 → 每池 9 次 getLogs。
3. 一天 763 筆 swap 需要 763 次 `eth_getTransaction`（拿 tx.from），前 20 名池 × 平均幾百筆 ≈ 5,000–15,000 次/日。這是最大宗的 RPC 用量，見 11.7；可用 `eth_getBlockReceipts`（每塊一次）或 Blockscout `transactions/{hash}` 降低，但第一版先照腳本做法。
4. DexScreener 資料同時揭露一個**假 SOFI**（`0x168da9…`，價格 2.9e-27）— 證實 §8.1 `fake_stock` 規則必要，且判斷應以 **地址不在 `/assets`** 為準，不需要比對 symbol 像不像股票。

---

## 11.7 每日呼叫次數估算 → **在免費額度內，但池子宇宙必須先縮小**

### 前提：這條鏈的池子數量遠超規格想像

實測 PoolManager `Initialize` 事件：**10,000 塊（≈17 分鐘）內 302 個新池、100,000 塊內 3,074 個** → 約 **25,000 個新 v4 池 / 日**，絕大多數是 memecoin launchpad（Pons 等）的一次性池，且 214/302 無 hooks。§2「掃描所有 Uniswap 池」字面上不可行也無意義。

**決策：池子宇宙 = 「一邊是 `/assets` 白名單股票代幣，另一邊是 USDG 或 WETH」的 v4 / v3 池**（加 WETH/USDG 本身）。發現方式：
- 一次性回填：`Initialize` 以 `currency0`/`currency1` topic 過濾 USDG、WETH（各兩個位置 → 4 種過濾），從創世掃到現在 52.8M 塊 / 100k = **528 × 4 ≈ 2,100 次**，只跑一次。
- 每日增量：830k / 100k = 9 段 × 4 過濾 = **36 次/日**。
- 對照 DexScreener `token-pairs`（194 次/日）互相補漏。

估計符合條件的池：以 SOFI 一檔就有 14 個 SOFI/USDG + 1 個 SOFI/ETH；194 檔 × 平均 2–3 → **約 300–600 個池**，其中 TVL ≥ $5k 的候選可能 ≤ 100。

### 每日用量（假設 400 個池、前 20 名做刷量分析）

| 來源 | 動作 | 次數/日 | 額度 |
|---|---|---|---|
| Public RPC | Initialize 增量 | 36 | — |
| Public RPC | 每池 Swap log（9 段）— 只對 TVL ≥ $1k 且未硬排除的 ~150 池 | ~1,350 | 無官方數字，實測連發會 429 → 需 3–5 併發 + 退避 |
| Public RPC / Alchemy | StateView `getSlot0` + `getLiquidity`（每池 2 次 eth_call） | ~800 | Alchemy 26 CU/次 → 21k CU |
| Public RPC / Alchemy | 前 20 名池 `eth_getTransaction` + `eth_getBlock` | 5,000–15,000 | Alchemy ~17 CU/次 → ≤ 255k CU/日 → 7.6M CU/月 ✓（30M 內） |
| DexScreener | `token-pairs` × 194 + WETH | ~200 | 60/min → 4 分鐘 |
| Robinhood | `/assets` 1、`/corporate-actions` 1、`/prices/{symbol}` × 194 | ~200 | 60 req/s ✓ |
| Mobula（備援） | `token/markets` × 194 | ~200 credits/日 → 6k/月 | 10k/月，緊但可 |
| Mobula（P2 對照） | OHLCV 1h，只對前 20 名、手動觸發 | 100 credits/次 | 不進排程 |
| Telegram | sendMessage | 1–3 | ✓ |

結論：只要**不用 Alchemy 免費方案掃 log**（改 public RPC，或 Alchemy 實測放行），全部落在免費額度內。`scan_runs.api_calls` 會記每個來源的實際次數以便校正。

---

### 11.7 補充：backfill 實測（2026-09-03 深夜）

| 項目 | 實測 |
|---|---|
| 掃描區塊 | 0 → 52,835,021，2M 塊一段共 27 段 |
| `eth_getLogs` + `getBlock` 總次數 | **5,365**（public RPC，併發 4，無 429 失敗） |
| 耗時 | 約 40 分鐘（前段 50 秒/段，最後兩段各 24 分鐘，因近期池子暴增） |
| USDG 配對池總數 | 約 12 萬（memecoin 為主） |
| **股票 × USDG 池** | **5,004**（其中最近一天新建 808 個） |
| 無 hooks | 4,197；再加費率 0.1%–6% 內 | **2,082** |
| 動態費率 | 556 |
| 費率分布（無 hooks） | 最多的是 **90%、88%、95%** 費率的陷阱池（各 100–300 個），其次才是 5% |
| 池數最多的股票 | DJT 318、WYFI 208、NVDA 206、GME 162、RDDT 155 |

結論：池子宇宙比 §11.7 原估的 300–600 多一個量級，但絕大多數是高費率或空池；需要 D16 的預篩，真正拉 Swap 的池預期只有一兩百個。

### 11.7 補充：首次 `pnpm scan` 實測（2026-09-03 台北 04:27–04:56）

| 項目 | 實測 |
|---|---|
| 池數 | 5,021（含當日新發現 16 個） |
| 拉 Swap 的池（D16 預篩後） | **485** |
| API 呼叫 | rpc **4,572**、robinhood 216、dexscreener 193 |
| 耗時 | **29 分鐘**（DexScreener 4 分鐘受 60/min 限制；其餘為 RPC） |
| 有 DexScreener TVL 的池 | 914 / 5,021（其餘 `tvl_unknown`） |
| 候選（未硬排除） | 40 |
| flags | tvl_too_small 4,733、tvl_unknown 4,107、fee_out_of_range 2,860、too_new 2,800、has_hooks 809、swap_fetch_failed 1 |
| 價格驗證 | 池價 vs Robinhood mid 偏離多在 ±4% 內（如 BA 207.12 vs 208.89、F 14.15 vs 14.13），證明 D4/D13 換算正確 |
| 第一次跑失敗原因 | public RPC 對 Swap getLogs 突發 429，5 次退避不夠 → 改併發 2、間隔 250ms、8 次退避上限 30 秒後整輪無 429 |

結論：每日用量約 5k RPC 次，遠低於 Alchemy 免費額度；public RPC 也撐得住。29 分鐘的執行時間對 07:30 排程可接受。

**觀察（供 P2/P3 參考）**：`too_new` 的池裡有 24h 手續費 ≥ TVL 的極端案例（SNAP 5,662 筆 swap、$5k TVL、$19.8k 手續費），這正是 §1 描述的「剛開池、刷量、被套利掃光」陷阱，7 天年齡門檻與 P3 刷量分析會處理。

### 11.7 補充：P3 刷量分析實測（2026-09-03）

| 項目 | 實測 |
|---|---|
| 分析池數 | 前 20 名 |
| 耗時 | 9 分鐘 |
| 呼叫 | public RPC 366（Swap + ModifyLiquidity log）、**Alchemy 10,301**（tx.from）≈ 175k CU/日 ≈ 5M CU/月 |
| 取樣 | 9 池超過 800 筆被取樣（最多 10,746 筆/日） |
| 命中 | COIN/USDG：對打比例 42% → `wash_suspect`；其餘 top1 佔比 3–43%、LP 重疊成交量 ≤ 8% |
| 失敗 | 1 池 RPC 暫時錯誤，非致命，隔日重跑 |

## 其他設計決策（規格未定義或我打算不同做法）

| # | 主題 | 決策 |
|---|---|---|
| D1 | §7.2 `share_h` | v4 `Swap` 事件帶當下 `liquidity`（區間內活躍流動性），比 `D/(tvl+D)` 精確：`share_h = L_pos / (L_pool_h + L_pos)`，`L_pool_h` = 該小時最後一筆 Swap 的 `liquidity`；沒有 swap 的小時沿用前值。第一版兩種都算，`sim` 內存 `share_method`。 |
| D2 | 股票代幣價格與 `uiMultiplier` | 池內價格以 raw 單位計；比對 Robinhood mid 前乘上 `currentMultiplier`。目前全部 1.0，但分割後會變，`price_dev_pct` 一定要用乘後的值。 |
| D3 | v4 動態費率 | `fee` 的 `0x800000` bit 代表動態費率 → `fee_ppm = NULL` → `fee_out_of_range`。 |
| D4 | v4 `Initialize` 的 `sqrtPriceX96` 換算 | token0 decimals 18 / token1 USDG 6，價格 = (sqrtP/2^96)^2 × 10^(d0−d1)。純函式 + 單元測試（用 SOFI 池 17.4 左右對照）。 |
| D5 | `is_weekday` | 以紐約時間「前一個交易日」是否為週一～五判斷（07:30 台北 = 前一日 19:30 紐約）。美股假日第一版不處理，`flags += "us_holiday_unknown"` 不加。 |
| D6 | 排程 | §3 提到「CLYDE cron」不明，改 **launchd** `com.lp-scanner.daily.plist`，07:30 Asia/Taipei。 |
| D7 | RPC 用量控制 | `sources/rpc.ts` 內建：併發 4、429/超時指數退避、每日呼叫計數寫 `scan_runs`。public RPC 優先，`ALCHEMY_KEY` 有設才切 Alchemy。 |
| D8 | v3 / v2 池 | v3 Factory `PoolCreated` 與 v2 `PairCreated` 一併掃，`pools.protocol` 區分；v2 沒有區間，`sim` 存 NULL、不進排名（僅顯示）。 |
| D9 | DexScreener | 免 key、無需 env；只做 TVL/量的**交叉驗證與池子補漏**，主數據仍是鏈上自算，避免對第三方免費 API 的隱性依賴。 |
| D10 | Blockscout | 只用 `api.blockscout.com/4663`（需免費 key）做人工核對工具，不進每日排程。 |
| D11 | 手續費估算（P1） | `fees_usd = USDG 側成交量 × fee / 1e6`。輸入端是股票時真實費用以股票計，換算差異僅為該筆的價格衝擊，可忽略。v4 Swap 事件的 `fee` 欄位即該筆適用的 LP 費率。 |
| D12 | Swap 時間戳 | 每日區間的首尾兩塊取真實時間戳，中間依區塊號線性內插（0.104 s/塊 → 誤差 < 1 分鐘），省下每筆 `getBlock`。 |
| D13 | 股票在哪一邊 | v4 依地址排序決定 currency0/1，實測最大的 SOFI/USDG 池 USDG 是 currency0（USDG `0x5fc5…` < SOFI `0x98e7…`）。`pools.stock_is_token0` 記錄；`price_usd` 一律為「股票 / USDG」，與 SPEC §6「token0 以 USD 計價」不同。 |
| D14 | P1 摘要排序 | 尚無 §7 模擬，Top 5 依 `raw_apr = fees_24h × 365 / tvl` 排序，摘要內明示「原始 APR」。 |
| D33 | 日誌截圖 | 前端把貼上/選取的圖轉 base64 送 `POST /api/positions/:id/journal`（body 上限 30 MB），server 存成 `data/positions/<tokenId>/<ts>-<n>.<ext>`，`journal.data.images` 記相對路徑，由 `/api/journal-image/*` 讀（擋 `..`）。整個 `data/positions/` 不進 git。 |
| D37 | 成交持續性 / 生命週期成本 / 容量 | 參考一篇 LP agent 文章的三個缺項。(1) `heat_6h` = 最近 6h 成交速率 ÷ 全天平均（<0.5 表示冷卻），`vol_6h_usd`、`vol_1h_usd` 存快照，總覽多一欄。(2) 生命週期成本 = 進場換半 × 費率 + 出場換半 × 費率 + 4 筆 gas（`economics.gas_usd_per_tx` 0.6）；回本天數 = 成本 ÷ ±25% 模擬的日手續費。(3) 容量 = 投入多少會佔 active liquidity 10%（`capacity_share`），以最新小時的 liquidity 與價格算。三者只在單池頁顯示，不進評分。 |
| D36 | **hooks 規則改兩層（修改 SPEC §8.1，使用者 2026-09-05 同意）** | v4 hook 地址最後 14 bit 宣告它可介入的時刻，部署後不可變。分類：含流動性類（加減流動性、donate）或改帳類（returnsDelta）任一位 → `liquidity` → `has_hooks` 排除；只有初始化 / 交易位 → `fee_only` → 放行並 `flags += hook_fee_only`。動態費率池（`fee_ppm` NULL）用當日 swap 費率中位數 `fee_ppm_observed` 套 0.1%–6% 門檻，觀察不到 → `fee_out_of_range`。原因：GLD 主池（TVL $2.27M、276 個 LP、hook `…a080` 只有 beforeInitialize + beforeSwap）被一刀切誤殺；同類大池共 $4.2M TVL。PONS 白名單池（`…a880` 含 beforeAddLiquidity）仍排除。Dashboard：Hook 篩選、`hook·費率` / `hook·流動性` chip、單池頁 14 個權限位清單、動態費率顯示 `~中位數`。 |
| D34 | **支援 Uniswap v3（推翻 D15）** | 實測 v3 股票 × USDG 池 280 個，其中 1% 費率 185 個、最近 30 天新開 168 個；MSTR v3 1% 池的手續費/TVL 在高波動日是 v4 0.25% 池的三倍。做法：Factory `PoolCreated` 發現（USDG 精確 topic 過濾可全鏈一次查）、池合約 `Swap`（無 fee 欄位，以 `pools.fee_ppm` 填入後與 v4 共用 hourly / 模擬）、`Mint` / `Burn` 當 LP 事件、`pools.pool_id` = 池地址（DexScreener pairId 一致）。頭寸：NPM `positions()` + `collect` 的 eth_call 模擬取未領費。成本：每日多約 300–450 次公開 RPC（+3–4 分鐘），Alchemy 不變。 |
| D35 | 開倉價反推 | 用 mint 交易 receipt 裡的 `ModifyLiquidity.liquidityDelta`（v4）或 `Mint.amount`（v3）當開倉流動性反推開倉價，而不是現在的流動性（之後加減碼會不同）。第一次看到就已關閉的舊頭寸不建立（歷史不可知）。 |
| D32 | 頭寸日誌與匯出 | `position_journal` 表記使用者手寫的開倉理由 / 調整 / 領費 / 關倉 / 檢討（dashboard 卡片內輸入）。每日掃描與每次寫日誌後，把每筆頭寸（基本資料、mint 交易、每日快照、實際 vs 模擬、日誌）匯出成 `data/positions/<tokenId>.json`，供離線檢討；JSON 不進 git。 |
| D29 | 鏈上頭寸讀取（P5） | `TRACK_ADDRESS`（.env，只讀）→ Alchemy NFT API 列 PositionManager tokenId（無 key 時掃 `Transfer` 事件）→ `getPoolAndPositionInfo` / `getPositionLiquidity` / StateView `getSlot0`、`getFeeGrowthInside`、`getPositionInfo` 算持有量與未領手續費。開倉成本與時間從 mint 交易（`Transfer(0x0→owner, tokenId)`，公開 RPC 對精確 topic 允許全鏈範圍一次查）的 receipt 取 owner → PoolManager 的 ERC20 轉帳量，價格由投入量反推。實測與使用者 App 顯示一致（SPY #1219367：手續費 0.011639 SPY / 8.29 USDG 完全吻合）。v3 頭寸目前流動性全為 0，第一版不讀 v3。 |
| D30 | 頭寸「實際 vs 模擬」 | 實際 = 鏈上快照（現值 + 未領手續費 − 投入）；模擬 = 以頭寸真實區間與開倉時間跑 §7 引擎。差距是回填模型的核心數字，Telegram 與 dashboard 並列顯示。 |
| D31 | TVL 來源缺漏 | DexScreener 某天沒回某池 → 沿用前一天 `tvl_usd` 並 `flags += tvl_stale`（不排除）。原因：2026-09-04 DELL 池因此被誤判 `tvl_unknown` 掉出候選。 |
| D27 | 頭寸卡片估算（P4，P5 前暫代） | 現值 / 累積手續費 / 在區間以 `pool_hourly` 從 `opened_at` 起用 §7 引擎模擬（區間寬度由登錄的上下限反推），標示「估算」。P5 才記錄每日真實值並比對。 |
| D28 | Dashboard 安全 | Fastify 綁 `0.0.0.0:3000`、無登入、無 tunnel（SPEC §9.4 / §10.4）；唯一寫入是 `POST /api/positions` 與 `PATCH /api/positions/:id/close`。 |
| D24 | tx.from 來源（P3） | v4 Swap 的 `sender` 是 router，真正交易者要 `eth_getTransactionByHash` 取 `from`。Alchemy 免費方案允許此方法（只有 getLogs 被限 10 塊），有 `ALCHEMY_KEY` 就走 Alchemy（併發 8）；沒有就 public RPC。 |
| D25 | 刷量分析取樣 | 每池只取當日**最新 800 筆** swap（`scan.wash_sample_swaps`）解析 tx.from，超過即 `flags += wash_sampled`。原因：前 20 名池每池數千筆，全解析要 6 萬次/日 ≈ 每月 30M CU，正好吃光 Alchemy 免費額度；800 筆已足以看集中度與對打。 |
| D26 | 刷量分析範圍與重新評分 | 只對評分前 `wash_analysis_top_n = 20` 名跑；命中 `wash_suspect` 的池 `excluded = 1` 並從百分位移除後，其餘候選重新評分。`trader_count` 只有這 20 池有值，其他池摘要顯示「—」。 |
| D18 | 模擬份額單位（P2） | `share_h = L_raw / (L_pool_h + L_raw)`，`L_pool_h` = 該小時最後一筆 Swap 的 `liquidity`，`L_raw = L_human × 1e12`（股票 18 / USDG 6 decimals，不論股票在 token0 或 token1；推導在 `lp-math.ts` 註解）。實測 SOFI 池 $1,000 對 $20k TVL 得 5.7% 份額，量級合理。比 §7.2 的 `D/(tvl+D)` 精確，因為只算「同區間內」的活躍流動性。 |
| D19 | IL 定義 | `il_usd = value_end − (x0 × P_end + y0)`，x0/y0 為開倉時的持有量。即真正的 impermanent loss（負值 = 相對持有虧損），§7.3 的「D × (P_end/P₀ 持有對照)」以此實作。 |
| D20 | `rank_norm` | net_apr 在當日未排除池中的百分位：rank / (n − 1)，n = 1 時為 1。 |
| D21 | 無參考價的池 | `price_dev` 項給 0 分（視為偏離 5%）；股票代幣理論上都有 `/prices`，此情況只會在 API 失敗時出現。 |
| D22 | 模擬範圍 | 只對當日未硬排除的池跑模擬與評分（省時間）；排除池 `sim`/`score` 為 NULL，dashboard 顯示「未模擬」。`pnpm scan --sim-only` 可不重抓資料只重跑模擬與評分（改權重後用）。 |
| D23 | σ₇ 來源標記 | P2 起 σ₇ 一律用 `pool_hourly.price_usd`，候選池 flags 加 `sigma_from_pool`（11.3 決策）。Robinhood 參考價每日累積後，第二版再改。 |
| D17 | getLogs 超量自動對半切 | public RPC 單段超過 10k logs 時除了 `exceeds limit` 也可能回 `Missing or invalid parameters`（DJT/USDG 池實測 100k 塊有 8,734 筆 swap）。`getLogsChunked` 遇到即遞迴對半切。 |
| D16 | Swap 拉取預篩 | 只對「無 hooks ∧ 費率在範圍 ∧ DexScreener TVL ≥ `scan.swap_fetch_min_tvl_usd`（預設 $1,000）」的池拉 Swap log。其餘池仍寫快照但 `volume/fees = 0`，反正必被 `has_hooks / fee_out_of_range / tvl_too_small / tvl_unknown` 硬排除。原因：backfill 實測股票 × USDG 池有 5,004 個、通過 hooks/費率的 2,082 個，全拉 Swap 要 ~19k 次 getLogs/日。 |
| D15 | 池子發現只掃 v4 | v3 / v2 Factory 地址已記錄（11.4），但實測 DexScreener 上 SOFI 的 29 個池全是 v4，第一版不掃 v3/v2；`pools.protocol` 欄位保留。 |

---

## 已確認的決策（2026-09-03 使用者回覆）

| # | 問題 | 使用者決定 | 影響 |
|---|---|---|---|
| C1 | 池子宇宙 | **只掃「股票代幣 × USDG」**，不含 WETH 配對 | `Initialize` 過濾只需 USDG 在 currency0 / currency1 兩種；`quote_kind` 第一版只會有 `usdg`，`eth` 分支保留欄位但不實作換算；不需要 ETH/USD 價格來源；WETH/USDG 池不進宇宙 |
| C2 | `lp_trader_overlap` | 接受改為成交量佔比門檻 | `wash_suspect` 的第三條件改為「重疊 LP 地址的成交量佔比 > 0.5」，門檻放 `config/scoring.json`；`lp_trader_overlap` 仍記錄地址數 |
| C3 | 截圖池 poolId | 已提供：`0xb6a881c32ed115cb8790c182580c71607ee7b7b008b4e1c3c65b1bc29b891b53`（SOFI/USDG v4 3.285%） | **與 11.6 我挑的成交量最大池相同**，11.6 的實跑結果即為截圖池的結果，不需重跑 |
| C4 | Alchemy key / Telegram token | 之後補進 `.env` | P1 先用 public RPC；Telegram 推送在無 token 時改為印到 stdout 並記 `scan_runs.error = "telegram_not_configured"` |

## 原始待確認問題（已回覆，保留紀錄）

1. **池子宇宙縮小**（11.7）：只掃「股票代幣 × USDG/WETH」是否符合你的意圖？
2. **`lp_trader_overlap` 規則放寬**（11.6-1）：接受改成成交量佔比門檻嗎？
3. **Alchemy key**：需要你在 dashboard.alchemy.com 建 app 後把 key 放 `.env`，我才能實測 getLogs 範圍限制。沒有 key 也能先用 public RPC 跑 P1。
4. **截圖中的 SOFI/USDG 池**：請提供 poolId，我再用 `analyze-pool.mjs` 對它跑一次。
5. **Telegram bot token / chat id**：P1 驗收需要。
