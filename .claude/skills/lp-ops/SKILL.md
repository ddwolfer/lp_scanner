---
name: lp-ops
description: lp_scanner 專案的日常操作手冊：查頭寸即時損益、算某筆 LP 的真實成本與淨利（gas + 代幣流向）、記日誌、對照模擬。使用者問「這筆賺多少 / 成本多少 / 幫我記錄」時用。
---

# lp-ops：頭寸與成本操作

所有指令在 `/Users/pochenkuo/AI/lp_scanner` 下執行，皆為唯讀鏈上查詢（SPEC §10）。

## 1. 即時頭寸（現值、未領手續費、是否在區間）
```
pnpm positions
```
讀 `TRACK_ADDRESS` 的 v3 + v4 頭寸，寫進 `positions` / `position_snapshots`，並匯出 `data/positions/<tokenId>.json`。新頭寸會自動建立並從 mint 交易反推投入成本與開倉價（D29/D35）。

## 2. 真實成本與淨利（gas + 代幣流向）
```
pnpm costs [天數=3] [--symbol SPCX]
```
- 資料來源：Alchemy `alchemy_getAssetTransfers`（拿交易 hash）→ `eth_getTransactionReceipt`（gasUsed × effectiveGasPrice）→ receipt 裡的 ERC20 `Transfer` log（只算 USDG 與 `/assets` 白名單股票代幣）。
- 只算 `TRACK_ADDRESS` 自己發起的交易（gas 是自己付的）。
- ETH/USD 取 DexScreener 上 Robinhood Chain 的 WETH/USDG 主池價。
- **判讀**：若期間股票代幣淨變動為 0（買進多少最後全賣回），`USDG 淨變動 − gas` 就是這段期間的實際淨利，已含 swap 費與滑價（藏在成交價裡）。
- 範例（SPCX 週末實驗）：6 筆、gas $2.15、USDG +7.40 → 淨利 +$5.25。

## 3. 記日誌
- Dashboard `/positions` 卡片下方輸入，可貼截圖；或直接寫 `position_journal`（kind：open / note / adjust / collect / close / review）。
- 關倉時把 `pnpm costs --symbol X` 的結果寫成 `close` 日誌，並用 `position_snapshots` 最後一列記最終市值與手續費。
- 每次寫完跑一次匯出：`pnpm tsx -e "import('./db/index.ts').then(async m=>{const q=await import('./server/queries.ts');q.exportPositions(m.openDb('db/lp.sqlite'),'data/positions')})"`

## 4. 對照模擬
```
pnpm sim-check <poolId> [D] [R] [from] [to]
```
逐小時列出份額、手續費、市值。頭寸卡片的「模擬」欄用的是真實區間與開倉時間。

## 常見陷阱
- 頭寸卡片的「淨損益」含股價漲跌；只看 LP 賺的要看「手續費」那一行。
- 週末（台灣週六 08:00 到週一 08:00）沒有股價錨定；Robinhood `/prices` 週末價差可能離譜（D40）。
- 買賣股票代幣時 Uniswap 會自動路由，實收低於中價 0.3% 以上要換路徑。
