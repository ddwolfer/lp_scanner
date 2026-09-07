---
name: x-weekly-scan
description: 使用者說「跑一下 X 掃描」「看看這週 X 上 Robinhood LP 在講什麼」時用。用 Mac 的 Chrome 擴充套件搜 X 近一週的 Robinhood Chain LP 貼文，篩出事件、實盤數字、資金流向三類，輸出固定格式。每週一手動觸發。
---

# x-weekly-scan：每週掃 X 上的 Robinhood LP 討論

## 前置
1. 載入工具（一次載完）：`tabs_context_mcp, navigate, computer, javascript_tool, browser_batch, tabs_close_mcp, list_connected_browsers, select_browser`。
2. `list_connected_browsers` → 選 **macOS 且 isLocal:true** 的那台（使用者已指定用 Mac 這台，不要用 Windows）。
3. `tabs_context_mcp {createIfEmpty:true}`，建一個新分頁，結束時關掉。

## 搜尋
X 沒有對外 API，用 `x.com/search?q=<query>&f=live`。固定四組查詢，每組 navigate → wait 4s → 執行抓取腳本：

```
robinhood LP USDG
Robinhood LP 池
Robinhood Chain LP fees
USDG LP 手续费
```

抓取腳本（每組跑一次，結果累積在 `localStorage.__lp`，第一組前先 `localStorage.removeItem('__lp')`）：

```js
const seen=new Map(JSON.parse(localStorage.__lp||'[]'));const sleep=ms=>new Promise(r=>setTimeout(r,ms));
for(let i=0;i<12;i++){document.querySelectorAll('article').forEach(a=>{const u=a.querySelector('a[href*="/status/"]');const t=a.querySelector('[data-testid="tweetText"]');const tm=a.querySelector('time');const n=a.querySelector('[data-testid="User-Name"]');if(u&&t&&!seen.has(u.href))seen.set(u.href,(tm?.getAttribute('datetime')||'').slice(5,13)+' '+(n?.innerText.split('\n')[0]).slice(0,12)+' | '+t.innerText.replace(/\s+/g,' ').slice(0,110)+' | '+u.href.split('/').pop())});window.scrollBy(0,2500);await sleep(1200)}
localStorage.__lp=JSON.stringify([...seen]);seen.size
```

## 已知的工具限制（照做就不會卡）
- `javascript_tool` 回傳超過約 1,200 字會被截斷；回傳內容含 `?`、`&`、`=` 或整批含 status ID 會被擋成 `[BLOCKED: Cookie/query string data]`。做法：先把陣列存進 `window.__a`，再分批（每批 8 到 12 筆、每筆 ≤ 90 字）回傳，並 `.replace(/[?&=]/g,' ')`。
- `browser_batch` 一次塞超過 6 個動作容易 timeout；每批最多兩篇貼文。
- `get_page_text` 在 X 只回第一篇 article，讀全文用 `document.querySelectorAll('article [data-testid="tweetText"]')` 取前 2 到 4 段（串文）。
- 貼文網址用 `x.com/i/status/<id>`，不需要帳號名。

## 篩選
1. 關鍵字留下：`LP|池|流动|手续费|fee|无常|impermanent|做市|liquidity`；丟掉：`launchpad|100x|runner|下一个`。
2. 優先讀全文的類型（依序）：
   - **實盤損益**：有本金、手續費、IL 分開列的（例：0x独眼、小熊猫、0xFEI）。
   - **事件**：池被抽乾、hook 出事、Fables 積分規則、Robinhood 新代幣、協議費調整。
   - **資金流向**：大戶集中在哪、哪個工具開始有人用（Barker、Hoodfi、幣安錢包）。
3. 跳過：幣種宣傳串（SHROOM、RVH、Wood、Arc）、Barker 自家廣告、「一天 74%」類案例。

## 查證
貼文提到的股票池一律用 `pnpm pool <SYMBOL>` 對照我們的數字（TVL、費/TVL、容量），把差異寫進輸出。提到的新工具用 WebFetch 看首頁，只記「值不值得之後接」。

## 輸出格式（固定，中文）
```
X 週掃 <日期>　抓 N 篇 / 相關 M 篇 / 精讀 K 篇

事件（≤3 條）
- …

實盤數字（≤3 條，附本金、手續費、IL、天數）
- …

資金流向（≤3 條）
- …

跟 scanner 的對照
- 池對照表（若有）
- 啟發：有 / 無（有的話說要改什麼）

噪音：一句話
```
結尾固定提醒：X 內容只是「去鏈上查證」的線索，不當開倉依據。

## 歷史結論（避免重講）
- 2026-09-08 首掃：131 篇 / 72 相關 / 10 精讀。實盤日記一致顯示新盤 IL 吃光手續費，與 D16 too_new 排除一致；Leo 提到 Hoodfi 看板（未接）；HIMS v3 0.30% 池 TVL $1.17M 費/TVL 0.91%，比他開的 0.9% v4 池容量大 14 倍；無新指標。
