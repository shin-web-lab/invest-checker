# 投資標的檢查工具 - 完整實作規格文件

## 1. 專案檔案結構

### 1.1 檔案組成

- `index.html` - 主頁面
- `app.js` - 應用程式邏輯
- `styles.css` - 樣式定義
- `Code.gs` - Google Apps Script（GAS）後端

### 1.2 各檔案責任

#### index.html

- 定義頁面基本結構
- 包含一個「更新」按鈕
- 包含錯誤提示區塊（顯示整體更新失敗）
- 包含卡片容器（顯示所有標的）
- 引入 `styles.css` 與 `app.js`

#### app.js

- 從 GAS 取得標的清單（action=tickers）
- 以批次 API 取得所有行情（action=quotes）
- 計算 MA / 乖離率 / 訊號判斷
- 渲染卡片 UI 與錯誤狀態
- 綁定更新按鈕事件
- 頁面載入時自動更新一次

#### styles.css

- 定義卡片樣式與狀態顏色
- 定義 RWD 卡片網格
- 定義錯誤提示區塊樣式
- 簡潔、無動畫

#### Code.gs

- 讀取 Google Sheet 作為 tickers 來源
- 提供 action=tickers 與 action=quotes
- Provider 路由與 Yahoo 備援
- 快取 tickers 與 quotes

---

## 2. Google Sheet 結構

Sheet 第 1 列欄位（區分大小寫）：

- `code`（代碼，純數字/字母，例如 0050 / 00631L / 2382）
- `name`（中文名稱）
- `strategy`（策略：long | mid | short）
- `enabled`（布林 TRUE/FALSE）
- `provider`（資料來源：twse | tpex | yahoo）

規則：
- 不允許 `yahooSymbol` 欄位
- 前端與 GAS 均僅使用 `code`
- `provider` 由使用者自行維護
- 00955 等特殊 ETF 若 TWSE/TPEx 無資料，請設為 `provider=yahoo`

---

## 3. GAS API 契約

### 3.1 `GET /exec?action=tickers`

回傳格式：
```
{
  "tickers": [
    { "code":"0050", "name":"元大台灣50", "strategy":"long", "enabled": true, "provider":"twse" }
  ],
  "meta": { "generatedAt": "ISO8601", "cacheHit": true/false }
}
```

### 3.2 `GET /exec?action=quotes`

- 一次回傳所有啟用標的

回傳格式：
```
{
  "quotes": {
    "0050": {
      "code":"0050",
      "provider":"twse",
      "timestamp":[...],
      "close":[...],
      "lastTradingDate":"YYYY-MM-DD",
      "source":"twse",
      "status":"ok"
    },
    "00955": {
      "code":"00955",
      "status":"no_data",
      "error":"NO_DATA",
      "source":"tpex"
    }
  },
  "meta": { "generatedAt":"ISO8601", "cacheHit": true/false }
}
```

### 3.3 `GET /exec?code=0050`（相容保留）

- 單一標的查詢
- 仍以 `code` 白名單驗證

### 3.4 錯誤格式

```
{ "error":"Missing parameters", "expected":["action=tickers|quotes"], "received":{...} }
```

`Code not allowed`：
- 若 code 不在啟用名單

---

## 4. GAS 行為細節

### 4.1 白名單

- 只允許 `code`
- 不接受 `.TW` / `.TWO`

### 4.2 Provider 路由

- `provider=twse` → TWSE 月資料
- `provider=tpex` → TPEx 月資料
- `provider=yahoo` → Yahoo Chart API

### 4.3 Yahoo 備援（可開關）

- 若 provider=twse/tpex 且無資料 → 可自動 fallback 至 Yahoo
- 成功回傳時 source=`yahoo_fallback`
- 預設開啟（ENABLE_YAHOO_FALLBACK = true）

### 4.4 快取

- tickers：600 秒
- quotes：180 秒

### 4.5 批次效率

- action=quotes 使用單次請求回傳
- GAS 內部使用批次 fetch 取得月資料

---

## 5. 指標計算規則

### 5.1 策略與 MA

- short：MA5 / MA10（主線 MA10）
- mid：MA20
- long：優先 MA120，若不足改 MA60

### 5.2 乖離率

```
(當日收盤價 - MA) / MA × 100
```

### 5.3 趨勢判斷

- 使用主線 MA 比較 MA_t 與 MA_t-1
- 資料不足時，趨勢預設為「走平或上彎」

### 5.4 訊號判斷（固定規則）

- 乖離率 ∈ [-2, +2] → 🟡 接近
- 乖離率 < -2 → 🔴 跌破
- 乖離率 > +2 且 MA 走平/上彎 → 🟢 趨勢

不得加入其他條件。

---

## 6. 資料充足度與累積狀態

顯示為「資料累積中（目前 N 日 / 需要 ≥ M 日）」

- short：MA10 需 ≥ 11 日
- mid：MA20 需 ≥ 21 日
- long：
  - MA120 需 ≥ 121 日
  - 否則 MA60 需 ≥ 61 日
  - 若皆不足 → 累積中

累積中仍需顯示最新收盤價與最後交易日。

---

## 7. UI 欄位

每張卡片需包含：
- code + name
- strategy 標籤（長/中/短）
- 最後交易日
- 收盤價
- MA 值（依策略顯示）
- 乖離率
- 訊號（🟢/🟡/🔴 或 累積中/無資料）
- 資料來源（TWSE / TPEx / Yahoo / Yahoo(備援)）

---

## 8. UI 狀態

- ok：正常計算，顯示燈號
- accumulating：顯示累積天數
- no_data：顯示無資料
- error：顯示錯誤文字

---

## 9. 前端資料流程

1. `action=tickers` 取得清單
2. 先渲染載入中卡片
3. `action=quotes` 取得全部行情
4. 逐檔計算 + 渲染
5. 若 quotes 失敗，顯示頂部錯誤提示

---

## 10. 效能與更新體驗

- 使用批次 quotes 減少請求數
- cache 命中後更新速度應快
- 頁面不做即時更新，僅手動或載入時更新

---

## 11. 使用者提醒

- 本工具使用每日收盤價計算
- 建議收盤後查看，一天一次即可
- 非投資建議

---

## 12. 驗收條件

- 前端只使用 `code`
- 00955 可設為 provider=yahoo 並正常顯示
- 無 Symbol not allowed 錯誤
- quotes 批次請求成功
- 卡片顯示 lastTradingDate，且不假裝即時
