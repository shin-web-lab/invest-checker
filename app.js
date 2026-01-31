// TODO: 將此 URL 替換為實際部署的 Google Apps Script Web App
const GAS_ENDPOINT = "https://script.google.com/macros/s/AKfycbwWTHygDgkm19HQ1yjjcBTGLU929RR9AMMPdkGh0BW7A1oXMRFBWDJ-Gjx0Q_cFGJS7/exec";
const FETCH_TIMEOUT_MS = 10000;
const CACHE_TTL_MS = 3 * 60 * 1000; // 快取 3 分鐘，減少頻繁請求
const responseCache = new Map(); // key: yahooSymbol, value: { data, timestamp }

document.addEventListener("DOMContentLoaded", init);

function init() {
  const updateBtn = document.getElementById("update-btn");
  updateBtn.addEventListener("click", updateAll);
  updateAll();
}

async function updateAll() {
  const updateBtn = document.getElementById("update-btn");
  const cards = document.getElementById("cards");

  updateBtn.disabled = true;
  updateBtn.textContent = "更新中...";
  clearError();
  cards.innerHTML = "";

  try {
    const tickers = await fetchTickersList();
    const tasks = tickers.map((ticker) => processTicker(ticker));
    await Promise.all(tasks);
  } catch (error) {
    console.error("Tickers list error:", error);
    showError("無法取得標的清單");
  }

  updateBtn.disabled = false;
  updateBtn.textContent = "更新";
}

async function processTicker(ticker) {
  try {
    const data = await fetchTickerData(ticker);
    cacheResult(ticker, data);
    renderCard(data);
  } catch (error) {
    handleError(ticker, error);
  }
}

async function fetchTickerData(ticker) {
  if (isPlaceholderEndpoint()) {
    const err = new Error("請設定 GAS_ENDPOINT");
    err.code = "MISSING_ENDPOINT";
    throw err;
  }

  const cached = responseCache.get(ticker.yahooSymbol);
  const now = Date.now();
  if (cached && now - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  const url = `${GAS_ENDPOINT}?symbol=${encodeURIComponent(ticker.yahooSymbol)}`;

  const response = await fetchWithTimeout(url, { method: "GET" }, FETCH_TIMEOUT_MS);
  if (!response.ok) {
    const err = new Error(`HTTP ${response.status}`);
    err.status = response.status;
    err.code = "HTTP_ERROR";
    throw err;
  }

  const json = await response.json();
  const parsed = parseAPIResponse(json);
  const { timestamps, closes, lastTimestamp } = parsed;

  const filtered = filterValidPrices(timestamps, closes);
  if (filtered.closes.length < 20) {
    const err = new Error("資料不足");
    err.code = "INSUFFICIENT";
    throw err;
  }

  const currentPrice = filtered.closes[filtered.closes.length - 1];
  if (currentPrice == null || currentPrice === 0) {
    const err = new Error("資料異常");
    err.code = "INVALID_PRICE";
    throw err;
  }

  const ma20 = calculateMA20(filtered.closes.slice(-20));
  const deviation = calculateDeviation(currentPrice, ma20);
  const trend = determineTrend(filtered.closes);
  const signalInfo = determineSignal(deviation, trend);
  const lastTs = lastTimestamp ?? filtered.timestamps[filtered.timestamps.length - 1];
  const lastUpdate = formatDate(lastTs);

  return {
    code: ticker.code,
    name: ticker.name ?? "-",
    currentPrice,
    ma20,
    deviation,
    signal: signalInfo.signal,
    signalText: signalInfo.text,
    lastUpdate,
    error: null,
  };
}

function cacheResult(ticker, data) {
  responseCache.set(ticker.yahooSymbol, { data, timestamp: Date.now() });
}

async function fetchTickersList() {
  if (isPlaceholderEndpoint()) {
    throw new Error("請設定 GAS_ENDPOINT");
  }

  const url = `${GAS_ENDPOINT}?action=tickers`;
  const response = await fetchWithTimeout(url, { method: "GET" }, FETCH_TIMEOUT_MS);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();
  if (!data || !Array.isArray(data.tickers) || data.tickers.length === 0) {
    throw new Error("無法取得標的清單");
  }

  return data.tickers;
}

function fetchWithTimeout(url, options, timeout) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(id));
}

function parseAPIResponse(response) {
  if (response?.error) {
    const err = new Error(response.error);
    if (response?.status) {
      err.status = response.status;
    }
    err.code = "UPSTREAM_ERROR";
    throw err;
  }

  const timestamps = response?.timestamp;
  const closes = response?.close;
  const lastTimestamp = response?.lastTimestamp;

  if (!Array.isArray(timestamps) || !Array.isArray(closes)) {
    const err = new Error("Missing timestamp/close");
    err.code = "MISSING_FIELDS";
    throw err;
  }

  return { timestamps, closes, lastTimestamp };
}

function filterValidPrices(timestamps, closes) {
  const filteredTimestamps = [];
  const filteredCloses = [];

  for (let i = 0; i < Math.min(timestamps.length, closes.length); i += 1) {
    const price = closes[i];
    if (price !== null && price !== undefined && price !== 0) {
      filteredTimestamps.push(timestamps[i]);
      filteredCloses.push(price);
    }
  }

  return { timestamps: filteredTimestamps, closes: filteredCloses };
}

function calculateMA20(prices) {
  const sum = prices.reduce((acc, price) => acc + price, 0);
  return roundToTwo(sum / 20);
}

function calculateDeviation(currentPrice, ma20) {
  const deviation = ((currentPrice - ma20) / ma20) * 100;
  return roundToTwo(deviation);
}

function determineTrend(closes) {
  if (closes.length < 21) {
    return "UP_OR_FLAT";
  }

  const maToday = calculateMA20(closes.slice(-20));
  const maYesterday = calculateMA20(closes.slice(-21, -1));
  return maToday >= maYesterday ? "UP_OR_FLAT" : "DOWN";
}

function determineSignal(deviationPercent, ma20Trend) {
  if (deviationPercent >= -2 && deviationPercent <= 2) {
    return { signal: "🟡", text: "接近" };
  }
  if (deviationPercent < -2) {
    return { signal: "🔴", text: "跌破" };
  }
  if (ma20Trend === "UP_OR_FLAT") {
    return { signal: "🟢", text: "趨勢" };
  }
  return { signal: "🔴", text: "跌破" };
}

function renderCard(data) {
  const cards = document.getElementById("cards");
  const card = document.createElement("div");
  const statusClass = data.error ? "status-error" : signalClass(data.signal);

  if (data.error) {
    card.className = "card error";
    card.innerHTML = `
      <div class="status-bar ${statusClass}"></div>
      <div class="card-header">
        <div class="card-title">
          <span class="code">${data.code}</span>
          <span class="name">${data.name ?? "-"}</span>
        </div>
        <div class="card-status ${statusClass}">${data.error}</div>
      </div>
      <div class="price">-</div>
      <div class="metrics">
        <div class="metric">
          <span class="label">MA20</span>
          <span class="value">-</span>
        </div>
        <div class="metric">
          <span class="label">乖離率</span>
          <span class="value">-</span>
        </div>
        <div class="metric">
          <span class="label">更新日期</span>
          <span class="value">-</span>
        </div>
      </div>
    `;
    cards.appendChild(card);
    return;
  }

  card.className = "card";
  card.innerHTML = `
    <div class="status-bar ${statusClass}"></div>
    <div class="card-header">
      <div class="card-title">
        <span class="code">${data.code}</span>
        <span class="name">${data.name ?? "-"}</span>
      </div>
      <div class="card-status ${statusClass}">${data.signal} ${data.signalText}</div>
    </div>
    <div class="price">${formatNumber(data.currentPrice)}</div>
    <div class="metrics">
      <div class="metric">
        <span class="label">MA20</span>
        <span class="value">${formatNumber(data.ma20)}</span>
      </div>
      <div class="metric">
        <span class="label">乖離率</span>
        <span class="value">${formatDeviation(data.deviation)}</span>
      </div>
      <div class="metric">
        <span class="label">更新日期</span>
        <span class="value">${data.lastUpdate}</span>
      </div>
    </div>
  `;

  cards.appendChild(card);
}

function handleError(ticker, error) {
  console.error(`Ticker ${ticker.yahooSymbol} error:`, error);
  const cards = document.getElementById("cards");
  const card = document.createElement("div");
  const message =
    error?.code === "INSUFFICIENT"
      ? "資料不足"
      : error?.code === "INVALID_PRICE"
        ? "資料異常"
        : error?.code === "MISSING_FIELDS"
          ? error?.message || "缺少資料欄位"
        : error?.code === "UPSTREAM_ERROR"
            ? error?.status === 404
              ? "不支援（Yahoo 無此代碼）"
              : error?.message || "Upstream error"
            : error?.code === "HTTP_ERROR"
              ? error?.status
                ? `Upstream error (status ${error.status})`
                : "無法取得資料"
              : error?.code === "MISSING_ENDPOINT"
                ? "請設定 GAS_ENDPOINT"
                : "無法取得資料";

  card.className = "card error";
  card.innerHTML = `
    <div class="status-bar status-error"></div>
    <div class="card-header">
      <div class="card-title">
        <span class="code">${ticker.code}</span>
        <span class="name">${ticker.name ?? "-"}</span>
      </div>
      <div class="card-status status-error">${message}</div>
    </div>
    <div class="price">-</div>
    <div class="metrics">
      <div class="metric">
        <span class="label">MA20</span>
        <span class="value">-</span>
      </div>
      <div class="metric">
        <span class="label">乖離率</span>
        <span class="value">-</span>
      </div>
      <div class="metric">
        <span class="label">更新日期</span>
        <span class="value">-</span>
      </div>
    </div>
  `;
  cards.appendChild(card);
}

function showError(message) {
  const errorBox = document.getElementById("error-box");
  if (!errorBox) return;
  errorBox.textContent = message;
  errorBox.hidden = false;
}

function clearError() {
  const errorBox = document.getElementById("error-box");
  if (!errorBox) return;
  errorBox.textContent = "";
  errorBox.hidden = true;
}

function formatNumber(value) {
  return Number(value).toFixed(2);
}

function formatDeviation(value) {
  const sign = value > 0 ? "+" : value < 0 ? "" : "+";
  return `${sign}${Number(value).toFixed(2)}%`;
}

function signalClass(signal) {
  if (signal === "🟢") return "signal-green";
  if (signal === "🟡") return "signal-yellow";
  return "signal-red";
}

function formatDate(timestampSeconds) {
  const date = new Date(timestampSeconds * 1000);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function roundToTwo(num) {
  return Math.round(num * 100) / 100;
}

function isPlaceholderEndpoint() {
  return GAS_ENDPOINT.includes("REPLACE_WITH_YOUR_DEPLOYMENT") || GAS_ENDPOINT.includes("SET_YOUR_GAS_DEPLOYMENT");
}
