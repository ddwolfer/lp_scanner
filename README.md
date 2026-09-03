# lp_scanner
Robinhood Chain 股票代幣 × USDG 流動性池每日掃描器（純唯讀）。規格見 `SPEC.md`，決策與驗證紀錄見 `DECISIONS.md`。

## 安裝
```
pnpm install
cp .env.example .env   # 填 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID（選填 ALCHEMY_KEY）
mkdir -p logs
```

## 首次
```
pnpm backfill      # 從創世掃 Initialize，可中斷續跑
pnpm scan          # 跑一次每日流程（沒有 Telegram 設定時摘要印在 stdout）
```

## 排程（每天 07:30，Mac 時區需為 Asia/Taipei）
```
cp ops/com.lp-scanner.daily.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.lp-scanner.daily.plist
```

## 測試
```
pnpm test && pnpm typecheck
```

## 人工核對模擬（P2 驗收，SPEC §7.4）
```
pnpm sim-check <poolId> [D=1000] [R=0.25] [from YYYY-MM-DD] [to YYYY-MM-DD]
pnpm sim-check 0xb6a881c32ed115cb8790c182580c71607ee7b7b008b4e1c3c65b1bc29b891b53 1000 0.25
```

## Dashboard（P4）
```
pnpm web:build          # 產生 web/dist
pnpm serve              # http://<mac-ip>:3000，綁 0.0.0.0，只在區網用
# 常駐：
npm i -g pm2 && pm2 start ops/ecosystem.config.cjs && pm2 save && pm2 startup
# 開發：另開一個終端 pnpm web:dev（Vite 5173，/api 會 proxy 到 3000）
```
頁面：`/` 總覽（投入 / 區間 / 候選切換、欄位排序、昨→今排名）、`/pool/:id` 單池、`/positions` 頭寸登錄。
