// TODO: 將此 URL 替換為實際部署的 Google Apps Script Web App
const GAS_ENDPOINT = "https://script.google.com/macros/s/AKfycbx37c_lGG8FHoIDSto_vctNcQFORV7GuEkTXKoUsgHasnbxE6kCYno8XY3MRTJlSywU/exec";
const FETCH_TIMEOUT_MS = 12000;
const FETCH_RETRY = 2;
const RETRY_BACKOFFS_MS = [800, 1600];

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

  let tickers = [];
  try {
    tickers = await fetchTickersList();
  } catch (error) {
    console.error("Tickers list error:", error);
    showError("無法取得標的清單");
    updateBtn.disabled = false;
    updateBtn.textContent = "更新";
    return;
  }

  renderSkeletonCards(tickers);

  try {
    const quotesPayload = await fetchQuotes();
    if (!quotesPayload || !quotesPayload.quotes) {
      throw new Error("Quotes missing");
    }
    renderAllCards(tickers, quotesPayload.quotes);
  } catch (error) {
    console.error("Quotes error:", error);
    showError(`本次更新失敗，請稍後重試（${getErrorMessage(error)}）`);
    renderErrorCards(tickers, "更新失敗");
  }

  updateBtn.disabled = false;
  updateBtn.textContent = "更新";
}

async function fetchTickersList() {
  if (isPlaceholderEndpoint()) {
    throw new Error("請設定 GAS_ENDPOINT");
  }

  const url = `${GAS_ENDPOINT}?action=tickers`;
  const response = await fetchWithRetry(url, { method: "GET" }, FETCH_TIMEOUT_MS, FETCH_RETRY);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();
  if (!data || !Array.isArray(data.tickers) || data.tickers.length === 0) {
    throw new Error("無法取得標的清單");
  }

  return data.tickers
    .map((ticker) => {
      if (!ticker) return null;
      const code = ticker.code != null ? String(ticker.code).trim() : "";
      const name = ticker.name != null ? String(ticker.name).trim() : "";
      const strategy = resolveStrategy({ code, strategy: ticker.strategy });
      const provider = ticker.provider != null ? String(ticker.provider).trim().toLowerCase() : "";
      if (!code) return null;
      return {
        code,
        name,
        strategy,
        provider,
      };
    })
    .filter(Boolean);
}

async function fetchQuotes() {
  if (isPlaceholderEndpoint()) {
    throw new Error("請設定 GAS_ENDPOINT");
  }

  const url = `${GAS_ENDPOINT}?action=quotes`;
  const response = await fetchWithRetry(url, { method: "GET" }, FETCH_TIMEOUT_MS, FETCH_RETRY);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();
  if (data?.error) {
    throw new Error(data.error);
  }

  return data;
}

function renderSkeletonCards(tickers) {
  const cards = document.getElementById("cards");
  cards.innerHTML = "";
  const fragment = document.createDocumentFragment();

  tickers.forEach((ticker) => {
    const card = document.createElement("div");
    const strategyKey = resolveStrategy(ticker);
    const strategyLabel = getStrategyLabel(strategyKey);
    card.className = "card loading";
    card.innerHTML = `
      <div class="status-bar status-neutral"></div>
      <div class="card-header">
        <div class="card-heading">
          <div class="card-title">
            <span class="code">${ticker.code}</span>
            <span class="name">${ticker.name || ticker.code}</span>
          </div>
          <div class="card-meta">
            <span class="strategy-badge strategy-${strategyKey}">${strategyLabel}</span>
            <span class="ma-period">載入中</span>
          </div>
        </div>
        <div class="card-status status-neutral">載入中...</div>
      </div>
      <div class="price">-</div>
      <div class="metrics">
        <div class="metric"><span class="label">MA</span><span class="value">-</span></div>
        <div class="metric"><span class="label">乖離率</span><span class="value">-</span></div>
        <div class="metric"><span class="label">最後交易日</span><span class="value">-</span></div>
        <div class="metric"><span class="label">來源</span><span class="value">-</span></div>
      </div>
    `;
    fragment.appendChild(card);
  });

  cards.appendChild(fragment);
}

function renderAllCards(tickers, quotes) {
  const cards = document.getElementById("cards");
  cards.innerHTML = "";
  const fragment = document.createDocumentFragment();

  tickers.forEach((ticker) => {
    const quote = quotes ? quotes[ticker.code] : null;
    const card = renderCard(ticker, quote);
    fragment.appendChild(card);
  });

  cards.appendChild(fragment);
}

function renderErrorCards(tickers, message) {
  const cards = document.getElementById("cards");
  cards.innerHTML = "";
  const fragment = document.createDocumentFragment();

  tickers.forEach((ticker) => {
    const card = renderCard(ticker, { status: "error", error: message });
    fragment.appendChild(card);
  });

  cards.appendChild(fragment);
}

function renderCard(ticker, quote) {
  const card = document.createElement("div");
  const nameText = ticker.name ? ticker.name : ticker.code;
  const strategyKey = resolveStrategy(ticker);
  const strategyLabel = getStrategyLabel(strategyKey);
  const providerLabel = formatProviderLabel(quote?.source || quote?.provider || ticker.provider);

  const result = evaluateQuote(ticker, quote, strategyKey);
  const statusClass = getStatusClass(result);
  const maLabel = result.maLabel || "";

  card.className = `card ${result.status === "error" || result.status === "no_data" ? "error" : ""}`;
  card.innerHTML = `
    <div class="status-bar ${statusClass}"></div>
    <div class="card-header">
      <div class="card-heading">
        <div class="card-title">
          <span class="code">${ticker.code}</span>
          <span class="name">${nameText}</span>
        </div>
        <div class="card-meta">
          <span class="strategy-badge strategy-${strategyKey}">${strategyLabel}</span>
          <span class="ma-period">${maLabel}</span>
          <span class="source-tag">來源：${providerLabel}</span>
        </div>
      </div>
      <div class="card-status ${statusClass}">${result.statusText}</div>
    </div>
    <div class="price">${result.priceText}</div>
    <div class="metrics">
      ${result.metrics
        .map(
          (metric) => `
        <div class="metric">
          <span class="label">${metric.label}</span>
          <span class="value">${metric.value}</span>
        </div>
      `,
        )
        .join("")}
    </div>
  `;

  return card;
}

function evaluateQuote(ticker, quote, strategy) {
  if (!quote || typeof quote !== "object") {
    return buildErrorState("資料不足", "-", []);
  }

  const status = quote.status || "error";
  const source = quote.source || quote.provider || "unknown";
  const lastTradingDate = quote.lastTradingDate || deriveLastTradingDate(quote.timestamp);

  if (status === "no_data") {
    return {
      status: "no_data",
      statusText: "無資料",
      priceText: "-",
      maLabel: "-",
      metrics: [
        { label: "MA", value: "-" },
        { label: "乖離率", value: "-" },
        { label: "最後交易日", value: lastTradingDate || "-" },
        { label: "來源", value: formatProviderLabel(source) },
      ],
    };
  }

  if (status !== "ok") {
    const errorMessage = quote.error || "資料錯誤";
    return buildErrorState(errorMessage, lastTradingDate, source);
  }

  const closes = Array.isArray(quote.close) ? quote.close : [];
  const timestamps = Array.isArray(quote.timestamp) ? quote.timestamp : [];
  const totalDays = closes.length;
  const currentPrice = totalDays > 0 ? closes[totalDays - 1] : null;
  const plan = getStrategyPlan(strategy, totalDays);

  if (currentPrice == null) {
    return buildErrorState("資料錯誤", lastTradingDate, source);
  }

  const maPrimary = plan.primary && totalDays >= plan.primary ? calculateMA(closes.slice(-plan.primary), plan.primary) : null;
  const maSecondary = plan.secondary && totalDays >= plan.secondary ? calculateMA(closes.slice(-plan.secondary), plan.secondary) : null;

  if (totalDays < plan.required) {
    const statusText = `資料累積中（目前 ${totalDays} 日 / 需要 ≥ ${plan.required} 日）`;
    return {
      status: "accumulating",
      statusText,
      priceText: formatNumber(currentPrice),
      maLabel: plan.primaryLabel,
      metrics: buildMetrics({
        maPrimaryLabel: plan.primaryLabel,
        maPrimary,
        maSecondaryLabel: plan.secondaryLabel,
        maSecondary,
        deviation: null,
        lastTradingDate,
        source,
      }),
    };
  }

  if (maPrimary == null) {
    return buildErrorState("資料累積中", lastTradingDate, source, currentPrice);
  }

  const deviation = calculateDeviation(currentPrice, maPrimary);
  const trend = determineTrend(closes, plan.primary);
  const signalInfo = determineSignal(deviation, trend);

  return {
    status: "ok",
    statusText: `${signalInfo.signal} ${signalInfo.text}`,
    priceText: formatNumber(currentPrice),
    maLabel: plan.primaryLabel,
    metrics: buildMetrics({
      maPrimaryLabel: plan.primaryLabel,
      maPrimary,
      maSecondaryLabel: plan.secondaryLabel,
      maSecondary,
      deviation,
      lastTradingDate,
      source,
    }),
  };
}

function buildMetrics({
  maPrimaryLabel,
  maPrimary,
  maSecondaryLabel,
  maSecondary,
  deviation,
  lastTradingDate,
  source,
}) {
  const metrics = [];
  if (maPrimaryLabel) {
    metrics.push({ label: maPrimaryLabel, value: formatNumberOrDash(maPrimary) });
  }
  if (maSecondaryLabel) {
    metrics.push({ label: maSecondaryLabel, value: formatNumberOrDash(maSecondary) });
  }
  metrics.push({ label: "乖離率", value: formatDeviationOrDash(deviation) });
  metrics.push({ label: "最後交易日", value: lastTradingDate || "-" });
  metrics.push({ label: "來源", value: formatProviderLabel(source) });
  return metrics;
}

function buildErrorState(message, lastTradingDate, source, currentPrice) {
  return {
    status: "error",
    statusText: message,
    priceText: currentPrice != null ? formatNumber(currentPrice) : "-",
    maLabel: "-",
    metrics: [
      { label: "MA", value: "-" },
      { label: "乖離率", value: "-" },
      { label: "最後交易日", value: lastTradingDate || "-" },
      { label: "來源", value: formatProviderLabel(source) },
    ],
  };
}

function getStrategyPlan(strategy, totalDays) {
  if (strategy === "short") {
    return {
      primary: 10,
      secondary: 5,
      required: 11,
      primaryLabel: "MA10",
      secondaryLabel: "MA5",
    };
  }

  if (strategy === "long") {
    if (totalDays >= 121) {
      return {
        primary: 120,
        secondary: 60,
        required: 121,
        primaryLabel: "MA120",
        secondaryLabel: "MA60",
      };
    }
    if (totalDays >= 61) {
      return {
        primary: 60,
        secondary: null,
        required: 61,
        primaryLabel: "MA60",
        secondaryLabel: "",
      };
    }
    return {
      primary: null,
      secondary: null,
      required: 61,
      primaryLabel: "MA60",
      secondaryLabel: "",
    };
  }

  return {
    primary: 20,
    secondary: null,
    required: 21,
    primaryLabel: "MA20",
    secondaryLabel: "",
  };
}

function fetchWithTimeout(url, options, timeout) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(id));
}

async function fetchWithRetry(url, options, timeout, retryCount) {
  let attempt = 0;
  while (attempt <= retryCount) {
    try {
      return await fetchWithTimeout(url, options, timeout);
    } catch (error) {
      if (attempt >= retryCount) throw error;
      await sleep(RETRY_BACKOFFS_MS[Math.min(attempt, RETRY_BACKOFFS_MS.length - 1)]);
      attempt += 1;
    }
  }
  throw new Error("Fetch failed");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function determineTrend(closes, period) {
  if (closes.length < period + 1) {
    return "UP_OR_FLAT";
  }

  const maToday = calculateMA(closes.slice(-period), period);
  const maYesterday = calculateMA(closes.slice(-(period + 1), -1), period);
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

function calculateMA(prices, period) {
  const sum = prices.reduce((acc, price) => acc + price, 0);
  return roundToTwo(sum / period);
}

function calculateDeviation(currentPrice, ma) {
  const deviation = ((currentPrice - ma) / ma) * 100;
  return roundToTwo(deviation);
}

function resolveStrategy(ticker) {
  const raw = String(ticker?.strategy || "").toLowerCase();
  if (raw === "long" || raw === "mid" || raw === "short") {
    return raw;
  }
  const code = String(ticker?.code || "").toUpperCase();
  if (code === "0050" || code === "006208") return "long";
  if (code === "00631L") return "short";
  return "mid";
}

function getStrategyLabel(strategy) {
  if (strategy === "long") return "長期";
  if (strategy === "short") return "短期";
  return "中期";
}

function formatProviderLabel(provider) {
  const value = String(provider || "").toLowerCase();
  if (value === "twse") return "TWSE";
  if (value === "tpex") return "TPEx";
  if (value === "yahoo") return "Yahoo";
  if (value === "yahoo_fallback") return "Yahoo(備援)";
  return value ? value.toUpperCase() : "-";
}

function getStatusClass(result) {
  if (result.status === "accumulating") return "status-neutral";
  if (result.status === "no_data") return "status-neutral";
  if (result.status === "error") return "status-error";
  if (result.statusText.includes("🟢")) return "signal-green";
  if (result.statusText.includes("🟡")) return "signal-yellow";
  if (result.statusText.includes("🔴")) return "signal-red";
  return "status-neutral";
}

function formatNumber(value) {
  return Number(value).toFixed(2);
}

function formatNumberOrDash(value) {
  if (value == null || Number.isNaN(Number(value))) return "-";
  return formatNumber(value);
}

function formatDeviationOrDash(value) {
  if (value == null || Number.isNaN(Number(value))) return "-";
  const sign = value > 0 ? "+" : value < 0 ? "" : "+";
  return `${sign}${Number(value).toFixed(2)}%`;
}

function deriveLastTradingDate(timestamps) {
  if (!Array.isArray(timestamps) || timestamps.length === 0) return "";
  const lastTs = timestamps[timestamps.length - 1];
  if (!lastTs) return "";
  const date = new Date(lastTs * 1000);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function roundToTwo(num) {
  return Math.round(num * 100) / 100;
}

function getErrorMessage(error) {
  if (!error) return "未知錯誤";
  if (error.name === "AbortError") return "連線逾時";
  return error.message || "未知錯誤";
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

function isPlaceholderEndpoint() {
  return GAS_ENDPOINT.includes("REPLACE_WITH_YOUR_DEPLOYMENT") || GAS_ENDPOINT.includes("SET_YOUR_GAS_DEPLOYMENT");
}
