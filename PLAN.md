# 投資標的檢查工具 - 改善計畫

## 目標

1. 移除對 Google Sheet 的依賴（使用者直接在網頁管理選股清單）
2. 改善載入速度
3. 修正假日後資料落後問題

---

## 架構決策

### 方案 A：前端完全自管清單，GAS 只當 quotes proxy

- 股票清單（tickers）改存 localStorage，使用者在網頁 UI 新增／刪除
- 前端呼叫 GAS 時傳入 codes 參數：`?action=quotes&codes=0050,2330`
- GAS 不再讀取 Google Sheet，只負責抓報價並回傳
- localStorage 被清空的保險機制：URL hash 書籤（`#0050,2330,006208`）

### Proxy

繼續使用 Google Apps Script，不換。

---

## 實作階段

### 階段一：效能修正（後端）

- [ ] **GAS 改並行抓股票**
  - `getQuotesBatch()` 改用 `UrlFetchApp.fetchAll` 跨標的並行
  - 現在：N 支股票串行，時間 = Σ 各支時間
  - 修正後：時間 ≈ 最慢那一支

- [ ] **假日快取保護**
  - 觸發器更新時，若新資料全部是 no_data，保留舊快取不覆蓋
  - 避免週末把週五有效資料蓋掉

- [ ] **GAS 接受 codes 參數**
  - `action=quotes&codes=0050,2330,006208`
  - 驗證格式（純數字/字母，不含 `.TW`）
  - 移除對 Sheet 的依賴

### 階段二：前端架構（方案 A）

- [ ] **localStorage 自管清單**
  - tickers 完全由前端管理，不再呼叫 `action=tickers`
  - 第一次開啟（localStorage 空白）顯示引導提示

- [ ] **localStorage 快取 tickers + quotes**
  - 重開頁面立即渲染，不等任何 GAS 回應
  - 背景靜默更新後替換

- [ ] **URL hash 備份清單**
  - 格式：`index.html#0050,2330,006208`
  - localStorage 清空時從 hash 還原
  - 提供「複製書籤連結」按鈕

### 階段三：選股 UI

- [ ] **新增股票**
  - 輸入代碼、名稱、策略（長/中/短）、來源（twse/tpex/yahoo）
  - 驗證格式

- [ ] **管理清單**
  - 可刪除個別股票
  - 可調整顯示順序（拖曳或上下移）

- [ ] **空白狀態引導**
  - 首次開啟或清單為空時，顯示說明與新增入口

---

## 注意事項

- Signal 判斷規則固定，不得修改 `determineSignal()`
- 不允許 `yahooSymbol` 欄位，統一用 `code`
- GAS 每次修改後需重新部署（版本選「新版本」，URL 不變）
- 上櫃股 `provider=tpex`，否則查無資料
