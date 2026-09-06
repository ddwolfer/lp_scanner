---
name: article-eval
description: 使用者貼一篇 X / Twitter / Medium 的 LP、DeFi、meme、空投、工具推薦文章要我評估時用。固定五段框架加上鏈上或 API 實際查證，判斷是否農場文。
---

# article-eval：評估 DeFi / LP 相關文章

## 先查證，再評論
1. 文章給了地址、池、hook、網站、API → **一定實際查**：
   - 池 / hook：`pnpm pool <poolId>`；hook 權限位用 `scanner/metrics/hooks.ts` 的 `hookInfo()`；PONS 案例：hook 含 beforeAddLiquidity 就是白名單池。
   - 網站：WebFetch 首頁與 /markets、/docs；API 用 curl 直接打，看回傳欄位（trenches 案例：`/api/traders` 的 win_rate 中位數 33%，自己否定了「聰明錢」）。
   - 協議數據：DefiLlama `api.llama.fi/protocol/<slug>` 與 `summary/fees/<slug>`。
   - 說法涉及市場結構（某股是否上市、交易時段）：查 Yahoo `query1.finance.yahoo.com/v8/finance/chart/<TICKER>` 與 Robinhood `/rhj/assets`，不要用記憶（SPCX 已上市的教訓）。
2. 找 referral / 邀請碼 / 群連結 / 平台幣：這決定文章的商業動機。

## 五段框架（每段一到三句，用表格放數字）
1. **它在說什麼**：機制白話版，包含「賺的是誰的錢」。
2. **數學上成不成立**：手續費、IL、出區間、清算；能算的用我們的模擬算。
3. **文章沒講的**：倖存者偏差、只秀手續費不秀淨損益、時間窗挑選、盯盤成本、對手方風險。
4. **農場判斷**：內容真假與商業動機分開講。有 referral 不等於假，但要點名。
5. **對你**：以使用者的資金規模（幾千美元）、只做 Robinhood Chain 股票 × USDG、每日一次掃描的頻率評估適不適用；若有可借用的點，說清楚要改什麼。

## 已評估過的參考結論（避免重講）
- PONS 白名單 hook 池：真實但無法參與，反面教材。
- meme 打新教程：方法紮實但沒有勝率數據，全職工作，方向與本專案相反。
- AI LP agent 文章：架構與本專案八成重疊，借用了三項（熱度、生命週期成本、容量，D37）。
- Fables 積分：純費率 hook 安全，但手續費是普通池的十分之一，等於用少賺的費買空投彩票。
- robinhoodtrenches：工具真、名單八成在虧、結尾是 FOMO 返佣。
