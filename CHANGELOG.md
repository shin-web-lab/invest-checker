# 變更清單

## 2026-02-02

- 前端改為批次 `action=quotes` 請求，僅使用 `code` 取資料，並加入載入中卡片與統一錯誤提示。
- 新增/更新 `Code.gs`：支援 `action=tickers`、`action=quotes`、`code` 單筆查詢；provider 路由與 Yahoo fallback；批次快取。
- UI 顯示來源與累積狀態，支援 short(MA5/MA10)、mid(MA20)、long(MA60/MA120) 的 MA 組合。
- 更新使用說明文字與來源描述（TWSE/TPEx/Yahoo）。
- 更新樣式：來源標籤、載入/中性狀態、指標欄位自適應。
- 更新 SPEC.md：Sheet schema、GAS 合約、provider、批次快取、資料充足規則。
- 新增 `Code.gs` 與 `.vscode/settings.json`。
