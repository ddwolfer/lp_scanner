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
