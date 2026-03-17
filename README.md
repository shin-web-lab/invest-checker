# 投資標的每日檢查工具

個人用台股技術分析工具。使用均線（MA）與乖離率判斷訊號，以卡片式介面顯示自選標的的每日狀態。目標使用者為投資入門者（股市小白），強調去術語化與簡易判讀。

---

## 技術架構

```
index.html          主頁面 HTML
app.js              前端邏輯（純 vanilla JS，無框架）
styles.css          樣式（純 CSS，無預處理器）
Code.gs             Google Apps Script 後端（資料來源 + 快取）
SPEC.md             完整規格文件
CHANGELOG.md        版本變更記錄
```

**資料流程**

```
Google Sheet（標的清單）
        ↓
Code.gs（GAS Web App）
  ├── action=tickers  → 回傳啟用中的標的列表
  ├── action=quotes   → 批次回傳所有標的收盤價歷史
  └── action=market   → 回傳大盤/美股/匯率資料
        ↓
app.js（前端計算 MA、乖離率、訊號）
        ↓
index.html（卡片式 UI）
```

**快取層（兩層）**

| 層 | 機制 | TTL | 說明 |
|---|---|---|---|
| GAS | `CacheService` | 600 秒 | 由 10 分鐘 Trigger 預熱，使用者按更新必然命中 |
| 前端 | `localStorage` | 8 小時 | 重開頁面立即顯示上次資料，背景更新後替換 |

---

## Google Sheet 結構

第 1 列為欄位名稱（區分大小寫）：

| 欄位 | 說明 | 範例 |
|---|---|---|
| `code` | 股票代碼（純數字或字母） | `0050`、`2382` |
| `name` | 中文名稱 | `元大台灣50` |
| `strategy` | 策略：`long` / `mid` / `short` | `long` |
| `enabled` | 是否啟用：`TRUE` / `FALSE` | `TRUE` |
| `provider` | 資料來源：`twse` / `tpex` / `yahoo` | `twse` |

**規則**：
- 不允許 `yahooSymbol` 欄位，前後端統一只用 `code`
- TWSE 上市股票設 `provider=twse`，上櫃設 `provider=tpex`
- 若 TWSE/TPEx 無資料（例如特殊 ETF），設 `provider=yahoo`

---

## 指標計算規則

### 策略與 MA 組合

| 策略 | 主線 | 第二線 | 第三線 | 最少需要天數 |
|---|---|---|---|---|
| 短期 | MA10 | MA5 | MA20 | 11 天 |
| 中期 | MA20 | MA10 | MA60 | 21 天 |
| 長期（≥121天） | MA120 | MA60 | MA20 | 121 天 |
| 長期（≥61天） | MA60 | MA20 | — | 61 天 |

### 訊號判斷（固定規則，不得新增條件）

| 條件 | 訊號 |
|---|---|
| 乖離率在 ±2% 之間 | 🟡 觀望中 |
| 乖離率 < -2% | 🔴 趨勢轉弱 |
| 乖離率 > +2% 且 MA 走平或上彎 | 🟢 順勢區 |
| 乖離率 > +2% 且 MA 下彎 | 🔴 趨勢轉弱 |

### 乖離率公式

```
(當日收盤價 - 主線MA) / 主線MA × 100
```

---

## 市場總覽

頁面頂端顯示三個市場指標，由 `action=market` 提供：

| 指標 | Yahoo 代碼 | 訊號 |
|---|---|---|
| 台股大盤 | `^TWII` | MA20 訊號燈 |
| 美股 S&P 500 | `^GSPC` | MA20 訊號燈 |
| 台幣匯率 (USD/TWD) | `TWD=X` | 僅顯示匯率與漲跌，無訊號 |

---

## GAS 部署步驟

1. 前往 [Google Apps Script](https://script.google.com)，開啟或新增專案
2. 全選 → 刪除 → 貼上 `Code.gs` 全部內容
3. 修改第 1、2 行：
   ```javascript
   const SPREADSHEET_ID = "你的 Google Sheet ID";
   const SHEET_NAME = "你的工作表名稱";
   ```
4. 點「部署」→「新增部署作業」→ 類型選「網頁應用程式」
   - 執行身分：我
   - 存取權限：所有人
5. 複製部署網址，貼入 `app.js` 第 2 行的 `GAS_ENDPOINT`
6. 在 GAS 編輯器執行 `setupTimeTrigger()` 一次，啟用每 10 分鐘自動預熱快取

**每次修改 Code.gs 後**：需重新部署（管理部署作業 → 編輯 → 版本選「新版本」），URL 不變。

---

## 本地開發

無需任何 build 工具，直接用瀏覽器開啟 `index.html` 即可。

```bash
open index.html
# 或用 VS Code Live Server
```

若要測試 GAS 回應，在 GAS 編輯器執行 `testQuotes()` 或直接在瀏覽器貼上 API 網址查看 JSON。

---

## 已完成功能

- [x] 卡片式 UI，3 欄（桌機）/ 2 欄（手機）
- [x] 短/中/長期策略，各顯示 3 條均線
- [x] 訊號燈（🟢🟡🔴）
- [x] 當日漲跌幅
- [x] 與均線距離（乖離率）顏色標籤
- [x] 手機點擊開啟底部面板（bottom sheet）
- [x] 桌機點擊直接開啟 Yahoo Finance
- [x] GAS 快取 + localStorage 雙層快取（即時顯示）
- [x] GAS 時間觸發器每 10 分鐘預熱快取
- [x] Yahoo Finance 備援（TWSE/TPEx 無資料時自動切換）
- [x] 市場總覽（台股大盤、美股 S&P500、台幣匯率）
- [x] Tooltip 說明泡泡（桌機 hover 顯示）
- [x] 去術語化介面（均線、與均線距離、順勢區、趨勢轉弱等）

## 待完成 / 規劃中

- [ ] 市場總覽：TWD=X 訊號優化（台幣強弱解讀方向）
- [ ] 去術語化：tooltip 覆蓋所有入門者可能不懂的名詞
- [ ] 使用者提示：收盤時間前顯示提醒

---

## 重要限制與規則

1. **不允許 `yahooSymbol` 欄位**，所有地方統一用 `code`
2. **Signal 判斷規則固定**，不得在 `determineSignal()` 加入額外條件
3. **GAS 每次修改都要重新部署**，否則前端仍呼叫舊版本
4. **不在 GAS 編輯器直接執行 `doGet`**，會報錯（需要 HTTP event 參數）
5. `provider=twse` 預設值；上櫃股請務必設 `provider=tpex`，否則查無資料
