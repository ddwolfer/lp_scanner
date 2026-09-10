---
name: codex-review
description: 做決策、寫計畫、改程式後，用本機 Codex CLI（同一個常駐 session）做 plan review 與 code review。使用者說「給 codex 看」「codex review」時用；重要決策與程式變更預設都要走一次。
---

# codex-review：用 Codex 當第二雙眼睛

Codex CLI 0.154 已裝在 Mac（`~/.local/bin/codex`，ChatGPT 登入）。所有呼叫都是非互動的 `codex exec` / `codex review`。

## 固定 session
本專案的 Codex session（thread）id 記在 `.codex-session`；每次都用它續接，Codex 才會記得先前的討論脈絡。
```
SID=$(cat .codex-session)
codex exec resume "$SID" "<prompt>"                  # 續接；不要加 -s / -C（resume 不吃這些）
codex exec resume "$SID" -o /tmp/last.md "<prompt>"  # 只要最後一段回覆時用 -o
```
session 不存在或想重開：`codex exec -s read-only --json "<prompt>"` 會印 `thread.started {"thread_id": ...}`，把新 id 寫回 `.codex-session`。

## Plan review（決策 / 計畫）
把計畫或決策用一段文字餵進去，要求 reviewer 角度、繁體中文、最多五點：
```
codex exec resume "$SID" "請用 reviewer 的角度看這個計畫，繁體中文，最多五點：『…』"
```
長文件用 stdin：`codex exec resume "$SID" - < docs/superpowers/plans/xxx.md`（prompt 用 `-` 讀 stdin）。

## Code review（程式變更）
```
codex review --uncommitted          # 未提交的變更（staged + unstaged + untracked）；不能同時給 prompt
codex review --base main            # 分支對 main
codex exec resume "$SID" "review commit <sha>，只列會改變行為的問題"   # 已 commit 的改動、或要自訂指示時
```
輸出格式：一句總結 + `[P1/P2/P3] 標題 — 檔案:行`。P1/P2 要處理或在回覆裡說明為何不改。

## 流程
1. 決策 / 計畫寫好 → plan review → 把 Codex 的點回覆給使用者（採納或反駁都要寫）。
2. 程式改完、測試過 → commit 前 `codex review --uncommitted` → 修 P1/P2 → 再 commit。
3. 把 Codex 的重要意見記進 DECISIONS.md 對應條目（例：「Codex review：…」）。

## 已知限制
- `codex review --uncommitted` 不接受自訂 prompt；要自訂就走 `exec resume`。
- `exec resume` 沒有 `-s`（sandbox）、`-C` 選項，會直接失敗且沒有輸出。
- 一次呼叫約 10–60 秒；review 會自己讀 repo。
- session id 是本機的，換機器要重建。
