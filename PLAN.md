# 投資標的檢查工具 - 改善計畫

## 目標

1. 移除對 Google Sheet 的依賴（使用者直接在網頁管理選股清單）
2. 改善載入速度
3. 修正假日後資料落後問題

---

## 架構決策

### 方案 A：前端完全自管清單，GAS 只當 quotes proxy

- 股票清單（tickers）改存 localStorage，使用者在網頁 UI 新增／刪除
- 前端呼叫 GAS 時傳入 codes 參數：`?action=quotes&codes=0050:twse:mid,2330:twse:long`
- GAS 不再讀取 Google Sheet，只負責抓報價並回傳
- localStorage 被清空的保險機制：URL hash 書籤（`#0050:twse:mid,2330:twse:long`）

### Proxy

繼續使用 Google Apps Script，不換。

---

## 實作進度

### 階段一：效能修正（後端）✅

- [x] **GAS 改並行抓股票**
  - `getQuotesBatch()` 改用 `UrlFetchApp.fetchAll` 跨標的並行
  - 時間 ≈ 最慢那一支（原為串行 Σ）

- [x] **假日快取保護**
  - 新資料為 no_data 時，若舊快取為 ok，保留舊快取不覆蓋
  - 避免週末把週五有效資料蓋掉

- [x] **GAS 接受 codes 參數**
  - `action=quotes&codes=0050:twse:mid,2330:twse:long`
  - 移除對 Google Sheet 的依賴
  - 移除 `action=tickers`

- [x] **市場總覽改並行**
  - `^TWII`、`^GSPC`、`TWD=X` 同一次 fetchAll

### 階段二：前端架構（方案 A）✅

- [x] **localStorage 自管清單**
  - tickers 完全由前端管理，不再呼叫 `action=tickers`
  - 第一次開啟（localStorage 空白）顯示空白狀態引導

- [x] **localStorage 快取 quotes**
  - 重開頁面立即渲染，不等 GAS 回應
  - 背景靜默更新後替換卡片

- [x] **URL hash 備份清單**
  - 格式：`index.html#0050:twse:mid,2330:twse:long`
  - localStorage 清空時從 hash 還原

### 階段三：選股 UI ✅

- [x] **側邊欄（drawer）**
  - 右側滑入，overlay 遮罩

- [x] **新增股票**
  - 輸入代碼（必填）、選策略（長/中/短）
  - 格式驗證（英數字、不重複）
  - 名稱預設為代碼，可在清單中點 ✏️ 修改

- [x] **管理清單**
  - 可刪除個別股票
  - 可調整顯示順序（↑↓）
  - 新增後背景驗證：若代碼查無資料，清單項目顯示 ⚠️

- [x] **空白狀態引導**
  - 首次開啟或清單為空時，顯示說明與新增入口

---

## 待辦

- [ ] 代碼輸入自動轉大寫（目前僅在 handleAddTicker 轉換，輸入中未即時顯示）
- [ ] 上櫃股票（TPEx）自動偵測：輸入代碼後自動判斷來源，不需使用者選擇（目前預設 twse，靠 Yahoo fallback 補）

---

## 注意事項

- Signal 判斷規則固定，不得修改 `determineSignal()`
- 不允許 `yahooSymbol` 欄位，統一用 `code`
- GAS 每次修改後需重新部署（版本選「新版本」，URL 不變）
- 上櫃股 fallback 至 Yahoo，`source` 會顯示 `yahoo_fallback`
