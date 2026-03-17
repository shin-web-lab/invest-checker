# 投資標的檢查工具 - 完整實作規格文件

## 1. 專案檔案結構

### 1.1 檔案組成

- `index.html` - 主頁面
- `app.js` - 應用程式邏輯
- `styles.css` - 樣式定義
- `Code.gs` - Google Apps Script（GAS）後端
- `README.md` - 專案說明、設定步驟、已完成／待完成功能
- `CHANGELOG.md` - 版本變更記錄

### 1.2 各檔案責任

#### index.html

- 定義頁面基本結構
- 包含市場總覽區塊（`#market-grid`）
- 包含「更新」按鈕
- 包含錯誤提示區塊
- 包含卡片容器（`#cards`）
- 包含底部面板（`#bottom-sheet`）
- 引入 `styles.css` 與 `app.js`

#### app.js

- 從 GAS 取得標的清單（action=tickers）
- 以批次 API 取得所有行情（action=quotes）
- 從 GAS 取得市場總覽資料（action=market）
- 計算 MA / 乖離率 / 訊號判斷
- 渲染卡片 UI、市場總覽、錯誤狀態
- 綁定更新按鈕、卡片點擊（桌機→Yahoo、手機→底部面板）
- 頁面載入時自動更新一次
- localStorage 雙層快取（8 小時 TTL）

#### styles.css

- 定義卡片樣式與狀態顏色
- 定義 RWD 卡片網格（桌機 3 欄、平板/手機 2 欄）
- 定義市場總覽卡片樣式
- 定義底部面板（bottom sheet）樣式
- 定義 Tooltip 樣式（桌機 hover 顯示）
- 簡潔、無動畫（bottom sheet 開關除外）

#### Code.gs

- 讀取 Google Sheet 作為 tickers 來源
- 提供 action=tickers、action=quotes、action=market
- Provider 路由與 Yahoo 備援
- CacheService 快取（tickers / quotes / market）
- 時間觸發器每 10 分鐘預熱 quotes + market 快取

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
- 特殊 ETF 若 TWSE/TPEx 無資料，請設為 `provider=yahoo`

---

## 3. GAS API 契約

### 3.1 `GET /exec?action=tickers`

```json
{
  "tickers": [
    { "code": "0050", "name": "元大台灣50", "strategy": "long", "enabled": true, "provider": "twse" }
  ],
  "meta": { "generatedAt": "ISO8601", "cacheHit": true }
}
```

### 3.2 `GET /exec?action=quotes`

一次回傳所有啟用標的。

```json
{
  "quotes": {
    "0050": {
      "code": "0050",
      "provider": "twse",
      "timestamp": [1700000000, ...],
      "close": [183.5, ...],
      "lastTradingDate": "YYYY-MM-DD",
      "source": "twse",
      "status": "ok"
    },
    "00955": {
      "code": "00955",
      "status": "no_data",
      "error": "NO_DATA",
      "source": "tpex"
    }
  },
  "meta": { "generatedAt": "ISO8601", "cacheHit": false }
}
```

### 3.3 `GET /exec?action=market`

回傳三個市場指標。

```json
{
  "markets": {
    "twii": {
      "key": "twii",
      "name": "台股大盤",
      "status": "ok",
      "timestamp": [...],
      "close": [...],
      "lastTradingDate": "YYYY-MM-DD"
    },
    "gspc": { ... },
    "twdusd": { ... }
  },
  "meta": { "generatedAt": "ISO8601", "cacheHit": false }
}
```

市場指標對應：

| key | Yahoo 代碼 | 說明 |
|---|---|---|
| `twii` | `^TWII` | 台股加權指數 |
| `gspc` | `^GSPC` | 美股 S&P 500 |
| `twdusd` | `TWD=X` | 台幣匯率（USD/TWD） |

### 3.4 `GET /exec?code=0050`（相容保留）

- 單一標的查詢
- 仍以 `code` 白名單驗證

### 3.5 錯誤格式

```json
{ "error": "Missing parameters", "expected": ["action=tickers|quotes|market"], "received": {} }
```

`Code not allowed`：code 不在啟用名單時回傳。

---

## 4. GAS 行為細節

### 4.1 白名單

- 只允許 `code`（純數字/字母）
- 不接受 `.TW` / `.TWO` 後綴

### 4.2 Provider 路由

- `provider=twse` → TWSE 月資料 API
- `provider=tpex` → TPEx 月資料 API
- `provider=yahoo` → Yahoo Chart API（直接使用，不加 .TW/.TWO）

### 4.3 Yahoo 備援（可開關）

- 若 provider=twse/tpex 且回傳 no_data → 自動 fallback 至 Yahoo
- 成功時 `source="yahoo_fallback"`
- 預設開啟（`ENABLE_YAHOO_FALLBACK = true`）

### 4.4 快取 TTL

| 資料 | TTL |
|---|---|
| tickers | 600 秒 |
| quotes | 600 秒 |
| market | 600 秒 |

### 4.5 時間觸發器

- 每 10 分鐘執行 `refreshCacheOnSchedule()`
- 強制清除 quotes + market 快取後重新取得
- 執行一次 `setupTimeTrigger()` 即可啟用；`removeTimeTriggers()` 停止

### 4.6 前端雙層快取

- GAS CacheService：快取 600 秒，由觸發器維持新鮮
- localStorage：快取 8 小時，頁面重開立即顯示，背景更新後替換

---

## 5. 指標計算規則

### 5.1 策略與 MA 組合

| 策略 | 主線 | 第二線 | 第三線 | 最少需要天數 |
|---|---|---|---|---|
| short | MA10 | MA5 | MA20 | 11 天 |
| mid | MA20 | MA10 | MA60 | 21 天 |
| long（≥121天） | MA120 | MA60 | MA20 | 121 天 |
| long（≥61天） | MA60 | MA20 | — | 61 天 |
| long（不足61天） | — | — | — | 累積中 |

### 5.2 乖離率公式

```
(當日收盤價 - 主線MA) / 主線MA × 100
```

### 5.3 趨勢判斷

- 比較主線 MA_t 與 MA_t-1
- 資料不足時預設「走平或上彎（UP_OR_FLAT）」

### 5.4 訊號判斷（固定規則，不得新增條件）

| 條件 | 訊號 |
|---|---|
| 乖離率 ∈ [-2, +2] | 🟡 觀望中 |
| 乖離率 < -2 | 🔴 趨勢轉弱 |
| 乖離率 > +2 且 MA 走平/上彎 | 🟢 順勢區 |
| 乖離率 > +2 且 MA 下彎 | 🔴 趨勢轉弱 |

---

## 6. 資料充足度與累積狀態

顯示格式：`資料累積中（N / M 天）`

累積中仍需顯示最新收盤價與最後交易日。

---

## 7. UI 欄位

### 卡片（card）

- code + name
- strategy 標籤（長/中/短）+ Tooltip
- 收盤價 + 當日漲跌幅
- 三條 MA 值（依策略顯示，手機版隱藏）
- 與均線距離（乖離率）顏色標籤，顯示於 card-meta
- 訊號（🟢/🟡/🔴 或 累積中/無資料）
- 資料來源標籤（TWSE / TPEx / Yahoo / Yahoo(備援)）

### 底部面板（bottom sheet，手機點擊卡片開啟）

- code + name
- 訊號 + 策略標籤
- 收盤價 + 當日漲跌幅
- 完整指標列（含 Tooltip）：各均線值、與均線距離、最後交易日、來源
- Yahoo Finance 連結按鈕

### 桌機卡片點擊行為

- 直接開新分頁至 Yahoo Finance（不開底部面板）
- URL 格式：`https://tw.finance.yahoo.com/quote/CODE.TW`（上市）或 `CODE.TWO`（上櫃）

---

## 8. UI 狀態

| 狀態 | 說明 | 顯示內容 |
|---|---|---|
| ok | 正常計算 | 訊號燈 + 所有指標 |
| accumulating | 資料不足 | 累積天數進度 + 收盤價 |
| no_data | 無資料 | 無資料 |
| error | 錯誤 | 錯誤訊息 |

---

## 9. 前端資料流程

1. `action=market` 與 `action=tickers` 同時發出（parallel fetch）
2. 渲染市場總覽 skeleton + 標的載入中卡片
3. 若 localStorage 有快取（8 小時內），立即渲染標的卡片並顯示快取時間提示
4. `action=quotes` 取得全部行情，渲染並更新 localStorage
5. market 資料就緒後渲染市場總覽
6. 若 quotes 失敗，有快取時僅顯示警告；無快取時顯示錯誤卡片

---

## 10. 效能與更新體驗

- GAS 觸發器預熱：使用者按「更新」幾乎必然命中快取（< 1 秒）
- localStorage 快取：重開頁面立即顯示，體感無延遲
- 市場總覽與標的清單並行請求，互不阻塞
- 頁面不做即時更新，僅手動或載入時更新

---

## 11. 驗收條件

- 前端只使用 `code`，不傳 `.TW` / `.TWO`
- 特殊 ETF 可設 `provider=yahoo` 並正常顯示
- quotes 批次請求成功，卡片顯示 lastTradingDate
- 市場總覽三個指標正常顯示（需部署含 action=market 的 Code.gs）
- 手機點擊卡片開啟底部面板；桌機點擊直接開 Yahoo Finance
- Tooltip 在桌機 hover 時顯示
