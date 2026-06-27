const GAS_ENDPOINT = "https://script.google.com/macros/s/AKfycbx37c_lGG8FHoIDSto_vctNcQFORV7GuEkTXKoUsgHasnbxE6kCYno8XY3MRTJlSywU/exec";
const FETCH_TIMEOUT_MS = 12000;
const FETCH_RETRY = 2;
const RETRY_BACKOFFS_MS = [800, 1600];

const LOCAL_CACHE_KEY = "invest_checker_quotes_v1";
const LOCAL_CACHE_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const TICKERS_STORAGE_KEY = "invest_checker_tickers_v1";

const cardDataMap = new Map();

const MARKET_DEFS = [
  { key: "twii",   name: "台股大盤",          icon: "🇹🇼", isForex: false },
  { key: "gspc",   name: "美股 S&P 500",      icon: "🇺🇸", isForex: false },
  { key: "twdusd", name: "台幣匯率 (USD/TWD)", icon: "💱",  isForex: true  },
];

document.addEventListener("DOMContentLoaded", init);

function init() {
  const updateBtn = document.getElementById("update-btn");
  updateBtn.addEventListener("click", updateAll);

  // 側邊欄
  document.getElementById("manage-btn").addEventListener("click", openDrawer);
  document.getElementById("drawer-close").addEventListener("click", closeDrawer);
  document.getElementById("drawer-overlay").addEventListener("click", closeDrawer);
  document.getElementById("drawer-add-btn").addEventListener("click", handleAddTicker);
  document.getElementById("input-code").addEventListener("keydown", function (e) {
    if (e.key === "Enter") handleAddTicker();
  });

  document.getElementById("bs-close").addEventListener("click", closeBottomSheet);
  document.getElementById("bs-overlay").addEventListener("click", closeBottomSheet);
  document.getElementById("cards").addEventListener("click", function (e) {
    const card = e.target.closest(".card[data-code]");
    if (!card) return;
    if (window.innerWidth >= 768) {
      const data = cardDataMap.get(card.dataset.code);
      if (data) window.open(buildYahooFinanceUrl(data.ticker.code, data.ticker.provider), "_blank", "noopener");
    } else {
      openBottomSheet(card.dataset.code);
    }
  });

  renderMarketSkeleton();
  updateAll();
}

async function updateAll() {
  const updateBtn = document.getElementById("update-btn");
  const cards = document.getElementById("cards");

  updateBtn.disabled = true;
  updateBtn.textContent = "更新中...";
  clearError();
  cards.innerHTML = "";

  const tickers = loadTickers();

  if (tickers.length === 0) {
    renderEmptyState();
    updateBtn.disabled = false;
    updateBtn.textContent = "更新";
    return;
  }

  // 市場總覽不依賴 tickers，與報價並行發送
  const marketPromise = fetchMarketData().catch(function (err) {
    console.error("Market fetch error:", err);
    return null;
  });

  // localStorage 有快取時立即渲染，不等 GAS
  const localCache = loadLocalCache();
  if (localCache) {
    renderAllCards(tickers, localCache.quotes);
    showCacheInfo(localCache.savedAt);
  } else {
    renderSkeletonCards(tickers);
  }

  // 背景取得最新報價
  try {
    const quotesPayload = await fetchQuotes(tickers);
    if (!quotesPayload || !quotesPayload.quotes) throw new Error("Quotes missing");
    saveLocalCache(quotesPayload);
    clearError();
    renderAllCards(tickers, quotesPayload.quotes);
  } catch (error) {
    console.error("Quotes error:", error);
    if (localCache) {
      showError("無法取得最新資料，顯示快取資料（" + getErrorMessage(error) + "）");
    } else {
      showError("本次更新失敗，請稍後重試（" + getErrorMessage(error) + "）");
      renderErrorCards(tickers, "更新失敗");
    }
  }

  const marketPayload = await marketPromise;
  if (marketPayload && marketPayload.markets) {
    renderMarketSection(marketPayload.markets);
  } else {
    renderMarketSection(null);
  }

  updateBtn.disabled = false;
  updateBtn.textContent = "更新";
}

async function fetchQuotes(tickers) {
  if (isPlaceholderEndpoint()) throw new Error("請設定 GAS_ENDPOINT");
  const codesParam = tickers.map(function (t) {
    return t.code + ":" + t.provider + ":" + t.strategy;
  }).join(",");
  const url = GAS_ENDPOINT + "?action=quotes&codes=" + encodeURIComponent(codesParam);
  const response = await fetchWithRetry(url, { method: "GET" }, FETCH_TIMEOUT_MS, FETCH_RETRY);
  if (!response.ok) throw new Error("HTTP " + response.status);
  const data = await response.json();
  if (data && data.error) throw new Error(data.error);
  return data;
}

async function fetchMarketData() {
  if (isPlaceholderEndpoint()) throw new Error("請設定 GAS_ENDPOINT");
  const url = GAS_ENDPOINT + "?action=market";
  const response = await fetchWithRetry(url, { method: "GET" }, FETCH_TIMEOUT_MS, FETCH_RETRY);
  if (!response.ok) throw new Error("HTTP " + response.status);
  const data = await response.json();
  if (data && data.error) throw new Error(data.error);
  return data;
}

// ── Ticker localStorage 管理 ──────────────────────────────────────────────────

function loadTickers() {
  try {
    const raw = localStorage.getItem(TICKERS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch (e) {}
  // localStorage 空白或清空時，嘗試從 URL hash 還原
  return loadTickersFromHash();
}

function saveTickers(tickers) {
  try {
    localStorage.setItem(TICKERS_STORAGE_KEY, JSON.stringify(tickers));
  } catch (e) {}
  updateUrlHash(tickers);
}

function loadTickersFromHash() {
  const hash = window.location.hash.slice(1);
  if (!hash) return [];
  return hash.split(",").map(function (item) {
    const parts = item.trim().split(":");
    const code = String(parts[0] || "").trim().toUpperCase();
    if (!code || !/^[A-Za-z0-9]+$/.test(code)) return null;
    const provider = normalizeProvider(parts[1] || "");
    const strategyRaw = String(parts[2] || "").toLowerCase();
    const strategy = ["long", "mid", "short"].includes(strategyRaw) ? strategyRaw : "mid";
    return { code: code, name: code, strategy: strategy, provider: provider };
  }).filter(Boolean);
}

function updateUrlHash(tickers) {
  const hash = tickers.map(function (t) {
    return t.code + ":" + t.provider + ":" + t.strategy;
  }).join(",");
  const newUrl = window.location.pathname + window.location.search + (hash ? "#" + hash : "");
  window.history.replaceState(null, "", newUrl);
}

// ── Empty state ───────────────────────────────────────────────────────────────

function renderEmptyState() {
  const cards = document.getElementById("cards");
  cards.innerHTML = `
    <div class="empty-state">
      <div class="empty-state-icon">📋</div>
      <p class="empty-state-title">尚未新增任何標的</p>
      <p class="empty-state-desc">點擊「新增股票」建立您的追蹤清單。</p>
    </div>
  `;
}

// ── Market Section ─────────────────────────────────────────────────────────────

function renderMarketSkeleton() {
  const grid = document.getElementById("market-grid");
  if (!grid) return;
  grid.innerHTML = MARKET_DEFS.map(function (def) {
    return `
    <div class="market-card loading">
      <div class="market-card-name">${def.icon} ${def.name}</div>
      <div class="market-card-price">-</div>
    </div>
  `;
  }).join("");
}

function renderMarketSection(markets) {
  const grid = document.getElementById("market-grid");
  if (!grid) return;
  grid.innerHTML = MARKET_DEFS.map(function (def) {
    const data = markets ? markets[def.key] : null;
    return buildMarketCard(def, data);
  }).join("");
}

function buildMarketCard(def, data) {
  if (!data || data.status !== "ok") {
    return `
      <div class="market-card">
        <div class="market-card-name">${def.icon} ${def.name}</div>
        <div class="market-card-price">-</div>
        <div class="market-card-footer"><span class="market-card-signal status-neutral">無資料</span></div>
      </div>
    `;
  }

  const closes = data.close || [];
  const n = closes.length;
  const price = n > 0 ? closes[n - 1] : null;
  if (price == null) {
    return `
      <div class="market-card">
        <div class="market-card-name">${def.icon} ${def.name}</div>
        <div class="market-card-price">-</div>
      </div>
    `;
  }

  const dailyChange = buildDailyChange(closes);
  const priceDecimals = def.isForex ? 3 : 2;
  const priceText = Number(price).toFixed(priceDecimals);

  let signalHtml = "";
  let maText = "";

  if (!def.isForex && n >= 21) {
    const ma20 = calculateMA(closes.slice(-20), 20);
    const deviation = calculateDeviation(price, ma20);
    const trend = determineTrend(closes, 20);
    const signalInfo = determineSignal(deviation, trend);
    const signalClass =
      signalInfo.signal === "🟢" ? "signal-green" : signalInfo.signal === "🟡" ? "signal-yellow" : "signal-red";
    signalHtml = `<span class="market-card-signal ${signalClass}">${signalInfo.signal} ${signalInfo.text}</span>`;
    maText = "MA20 " + Number(ma20).toFixed(2);
  }

  return `
    <div class="market-card">
      <div class="market-card-name">${def.icon} ${def.name}</div>
      <div class="market-card-price-row">
        <span class="market-card-price">${priceText}</span>
        ${dailyChange.text ? `<span class="daily-change ${dailyChange.cls} market-card-change">${dailyChange.text}</span>` : ""}
      </div>
      ${maText || signalHtml ? `<div class="market-card-footer">
        ${maText ? `<span class="market-card-ma">${maText}</span>` : ""}
        ${signalHtml}
      </div>` : ""}
    </div>
  `;
}

// ── Stock Cards ────────────────────────────────────────────────────────────────

function renderSkeletonCards(tickers) {
  const cards = document.getElementById("cards");
  cards.innerHTML = "";
  const fragment = document.createDocumentFragment();

  tickers.forEach(function (ticker) {
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
        <div class="metric"><span class="label">均線</span><span class="value">-</span></div>
        <div class="metric"><span class="label">與均線距離</span><span class="value">-</span></div>
        <div class="metric"><span class="label">最後交易日</span><span class="value">-</span></div>
      </div>
    `;
    fragment.appendChild(card);
  });

  cards.appendChild(fragment);
}

function renderAllCards(tickers, quotes) {
  const cards = document.getElementById("cards");
  cards.innerHTML = "";
  cardDataMap.clear();
  const fragment = document.createDocumentFragment();

  tickers.forEach(function (ticker) {
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

  tickers.forEach(function (ticker) {
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
  const providerLabel = formatProviderLabel(quote && (quote.source || quote.provider) || ticker.provider);

  const result = evaluateQuote(ticker, quote, strategyKey);
  cardDataMap.set(ticker.code, { ticker: ticker, result: result });
  const statusClass = getStatusClass(result);

  const deviationText = result.deviationText || "-";
  const deviationClass = result.deviationClass || "";
  const cardMetrics = result.metrics.filter(function (m) {
    return m.label !== "與均線距離" && m.label !== "來源";
  });

  const strategyTooltip = escAttr(getStrategyTooltip(strategyKey));

  card.className = "card " + (result.status === "error" || result.status === "no_data" ? "error" : "");
  card.dataset.code = ticker.code;
  card.innerHTML = `
    <div class="status-bar ${statusClass}"></div>
    <div class="card-header">
      <div class="card-heading">
        <div class="card-title">
          <span class="code">${ticker.code}</span>
          <span class="name">${nameText}</span>
        </div>
        <div class="card-meta">
          <span class="strategy-badge strategy-${strategyKey}">
            ${strategyLabel}<span class="tooltip-icon" data-tooltip="${strategyTooltip}">ⓘ</span>
          </span>
          ${deviationText !== "-" ? `<span class="deviation-tag ${deviationClass}">${deviationText}</span>` : ""}
          <span class="source-tag">來源：${providerLabel}</span>
        </div>
      </div>
      <div class="card-status ${statusClass}">${result.statusText}</div>
    </div>
    <div class="price">${result.priceText}${result.dailyChangeText ? `<span class="daily-change ${result.dailyChangeClass}">${result.dailyChangeText}</span>` : ""}</div>
    <div class="metrics">
      ${cardMetrics.map(function (metric) {
        return `<div class="metric">
          <span class="label">${metric.label}</span>
          <span class="value">${metric.value}</span>
        </div>`;
      }).join("")}
    </div>
  `;

  return card;
}

function evaluateQuote(_ticker, quote, strategy) {
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
      deviationText: "-",
      deviationClass: "",
      maLabel: "-",
      metrics: [
        { label: "均線", value: "-" },
        { label: "與均線距離", value: "-" },
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
  const totalDays = closes.length;
  const currentPrice = totalDays > 0 ? closes[totalDays - 1] : null;
  const plan = getStrategyPlan(strategy, totalDays);

  if (currentPrice == null) {
    return buildErrorState("資料錯誤", lastTradingDate, source);
  }

  const maPrimary =
    plan.primary && totalDays >= plan.primary ? calculateMA(closes.slice(-plan.primary), plan.primary) : null;
  const maSecondary =
    plan.secondary && totalDays >= plan.secondary ? calculateMA(closes.slice(-plan.secondary), plan.secondary) : null;
  const maTertiary =
    plan.tertiary && totalDays >= plan.tertiary ? calculateMA(closes.slice(-plan.tertiary), plan.tertiary) : null;
  const dailyChange = buildDailyChange(closes);

  if (totalDays < plan.required) {
    const statusText = "資料累積中（" + totalDays + " / " + plan.required + " 天）";
    return {
      status: "accumulating",
      statusText: statusText,
      priceText: formatNumber(currentPrice),
      dailyChangeText: dailyChange.text,
      dailyChangeClass: dailyChange.cls,
      deviationText: "-",
      deviationClass: "",
      maLabel: plan.primaryLabel,
      metrics: buildMetrics({
        maPrimaryLabel: plan.primaryLabel, maPrimary: maPrimary,
        maSecondaryLabel: plan.secondaryLabel, maSecondary: maSecondary,
        maTertiaryLabel: plan.tertiaryLabel, maTertiary: maTertiary,
        deviation: null, lastTradingDate: lastTradingDate, source: source,
      }),
    };
  }

  if (maPrimary == null) {
    return buildErrorState("資料累積中", lastTradingDate, source, currentPrice);
  }

  const deviation = calculateDeviation(currentPrice, maPrimary);
  const trend = determineTrend(closes, plan.primary);
  const signalInfo = determineSignal(deviation, trend);
  const deviationText = formatDeviationOrDash(deviation);
  const deviationClass = deviation > 2 ? "deviation-up" : deviation < -2 ? "deviation-down" : "deviation-mid";

  return {
    status: "ok",
    statusText: signalInfo.signal + " " + signalInfo.text,
    priceText: formatNumber(currentPrice),
    dailyChangeText: dailyChange.text,
    dailyChangeClass: dailyChange.cls,
    deviationText: deviationText,
    deviationClass: deviationClass,
    maLabel: plan.primaryLabel,
    metrics: buildMetrics({
      maPrimaryLabel: plan.primaryLabel, maPrimary: maPrimary,
      maSecondaryLabel: plan.secondaryLabel, maSecondary: maSecondary,
      maTertiaryLabel: plan.tertiaryLabel, maTertiary: maTertiary,
      deviation: deviation, lastTradingDate: lastTradingDate, source: source,
    }),
  };
}

function buildMetrics({ maPrimaryLabel, maPrimary, maSecondaryLabel, maSecondary, maTertiaryLabel, maTertiary, deviation, lastTradingDate, source }) {
  const metrics = [];
  if (maPrimaryLabel) metrics.push({ label: maPrimaryLabel, value: formatNumberOrDash(maPrimary) });
  if (maSecondaryLabel) metrics.push({ label: maSecondaryLabel, value: formatNumberOrDash(maSecondary) });
  if (maTertiaryLabel) metrics.push({ label: maTertiaryLabel, value: formatNumberOrDash(maTertiary) });
  metrics.push({ label: "與均線距離", value: formatDeviationOrDash(deviation) });
  metrics.push({ label: "最後交易日", value: lastTradingDate || "-" });
  metrics.push({ label: "來源", value: formatProviderLabel(source) });
  return metrics;
}

function buildErrorState(message, lastTradingDate, source, currentPrice) {
  return {
    status: "error",
    statusText: message,
    priceText: currentPrice != null ? formatNumber(currentPrice) : "-",
    deviationText: "-",
    deviationClass: "",
    maLabel: "-",
    metrics: [
      { label: "均線", value: "-" },
      { label: "與均線距離", value: "-" },
      { label: "最後交易日", value: lastTradingDate || "-" },
      { label: "來源", value: formatProviderLabel(source) },
    ],
  };
}

function getStrategyPlan(strategy, totalDays) {
  if (strategy === "short") {
    return { primary: 10, secondary: 5, tertiary: 20, required: 11,
      primaryLabel: "10日均線", secondaryLabel: "5日均線", tertiaryLabel: "20日均線" };
  }
  if (strategy === "long") {
    if (totalDays >= 121) {
      return { primary: 120, secondary: 60, tertiary: 20, required: 121,
        primaryLabel: "120日均線", secondaryLabel: "60日均線", tertiaryLabel: "20日均線" };
    }
    if (totalDays >= 61) {
      return { primary: 60, secondary: 20, tertiary: null, required: 61,
        primaryLabel: "60日均線", secondaryLabel: "20日均線", tertiaryLabel: "" };
    }
    return { primary: null, secondary: null, tertiary: null, required: 61,
      primaryLabel: "60日均線", secondaryLabel: "", tertiaryLabel: "" };
  }
  return { primary: 20, secondary: 10, tertiary: 60, required: 21,
    primaryLabel: "20日均線", secondaryLabel: "10日均線", tertiaryLabel: "60日均線" };
}

// ── Tooltip helpers ───────────────────────────────────────────────────────────

function getStrategyTooltip(strategy) {
  if (strategy === "long") return "觀察 60/120 日均線，適合持有數個月以上的長線投資。";
  if (strategy === "short") return "觀察 5/10 日均線，適合持有數天至數週的短線操作。";
  return "觀察 20 日均線，適合持有數週至數月的波段操作。";
}

function getMetricTooltip(label) {
  const maMatch = label.match(/^(\d+)日均線$/);
  if (maMatch) {
    const n = maMatch[1];
    const approx = n === "5" ? "約 1 週" : n === "10" ? "約 2 週" : n === "20" ? "約 1 個月" :
      n === "60" ? "約 3 個月" : n === "120" ? "約半年" : "";
    return "最近 " + n + " 個交易日的平均收盤價（" + approx + "），用來觀察趨勢方向。";
  }
  if (label === "與均線距離") return "現在價格偏離均線的百分比。超過 +2% 進入順勢區，低於 -2% 進入趨勢轉弱區。";
  if (label === "最後交易日") return "最近一筆收盤資料的日期。本工具使用每日收盤價，建議收盤後查看。";
  if (label === "來源") return "資料來源：TWSE（台灣證交所）、TPEx（證券櫃買中心）、Yahoo Finance。";
  return "";
}

function escAttr(str) {
  return String(str || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ── Calc / signal ─────────────────────────────────────────────────────────────

async function fetchWithTimeout(url, options, timeout) {
  const controller = new AbortController();
  const id = setTimeout(function () { controller.abort(); }, timeout);
  try {
    return await fetch(url, Object.assign({}, options, { signal: controller.signal }));
  } finally {
    clearTimeout(id);
  }
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
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function determineTrend(closes, period) {
  if (closes.length < period + 1) return "UP_OR_FLAT";
  const maToday = calculateMA(closes.slice(-period), period);
  const maYesterday = calculateMA(closes.slice(-(period + 1), -1), period);
  return maToday >= maYesterday ? "UP_OR_FLAT" : "DOWN";
}

function determineSignal(deviationPercent, maTrend) {
  if (deviationPercent >= -2 && deviationPercent <= 2) return { signal: "🟡", text: "觀望中" };
  if (deviationPercent < -2) return { signal: "🔴", text: "趨勢轉弱" };
  if (maTrend === "UP_OR_FLAT") return { signal: "🟢", text: "順勢區" };
  return { signal: "🔴", text: "趨勢轉弱" };
}

function buildDailyChange(closes) {
  if (closes.length < 2) return { text: "", cls: "" };
  const current = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  if (!prev) return { text: "", cls: "" };
  const change = roundToTwo(current - prev);
  const changePct = roundToTwo((change / prev) * 100);
  const sign = change > 0 ? "+" : "";
  const text = sign + change.toFixed(2) + " (" + sign + changePct.toFixed(2) + "%)";
  const cls = change > 0 ? "daily-change-up" : change < 0 ? "daily-change-down" : "daily-change-flat";
  return { text: text, cls: cls };
}

function calculateMA(prices, period) {
  const sum = prices.reduce(function (acc, price) { return acc + price; }, 0);
  return roundToTwo(sum / period);
}

function calculateDeviation(currentPrice, ma) {
  return roundToTwo(((currentPrice - ma) / ma) * 100);
}

function resolveStrategy(ticker) {
  const raw = String(ticker && ticker.strategy || "").toLowerCase();
  if (raw === "long" || raw === "mid" || raw === "short") return raw;
  const code = String(ticker && ticker.code || "").toUpperCase();
  if (code === "0050" || code === "006208") return "long";
  if (code === "00631L") return "short";
  return "mid";
}

function getStrategyLabel(strategy) {
  if (strategy === "long") return "長期";
  if (strategy === "short") return "短期";
  return "中期";
}

function normalizeProvider(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "twse" || raw === "tpex" || raw === "yahoo") return raw;
  return "twse";
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
  return sign + Number(value).toFixed(2) + "%";
}

function deriveLastTradingDate(timestamps) {
  if (!Array.isArray(timestamps) || timestamps.length === 0) return "";
  const lastTs = timestamps[timestamps.length - 1];
  if (!lastTs) return "";
  const date = new Date(lastTs * 1000);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return year + "-" + month + "-" + day;
}

function roundToTwo(num) {
  return Math.round(num * 100) / 100;
}

function getErrorMessage(error) {
  if (!error) return "未知錯誤";
  if (error.name === "AbortError") return "連線逾時";
  return error.message || "未知錯誤";
}

// ── Local cache ───────────────────────────────────────────────────────────────

function loadLocalCache() {
  try {
    const raw = localStorage.getItem(LOCAL_CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw);
    if (!cached || !cached.quotes || !cached.savedAt) return null;
    if (Date.now() - cached.savedAt > LOCAL_CACHE_MAX_AGE_MS) return null;
    return cached;
  } catch (e) {
    return null;
  }
}

function saveLocalCache(quotesPayload) {
  try {
    localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify({
      quotes: quotesPayload.quotes,
      savedAt: Date.now(),
    }));
  } catch (e) {}
}

function showCacheInfo(savedAt) {
  const errorBox = document.getElementById("error-box");
  if (!errorBox) return;
  const date = new Date(savedAt);
  const timeStr = String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0");
  errorBox.textContent = "顯示快取資料（" + timeStr + "），正在更新中…";
  errorBox.className = "error-banner info-banner";
  errorBox.hidden = false;
}

function showError(message) {
  const errorBox = document.getElementById("error-box");
  if (!errorBox) return;
  errorBox.textContent = message;
  errorBox.className = "error-banner";
  errorBox.hidden = false;
}

function clearError() {
  const errorBox = document.getElementById("error-box");
  if (!errorBox) return;
  errorBox.textContent = "";
  errorBox.className = "error-banner";
  errorBox.hidden = true;
}

// ── Yahoo Finance URL ─────────────────────────────────────────────────────────

function buildYahooFinanceUrl(code, provider) {
  const upper = String(code || "").toUpperCase();
  const suffix = provider === "tpex" ? ".TWO" : ".TW";
  return "https://tw.finance.yahoo.com/quote/" + upper + suffix;
}

// ── Bottom Sheet ──────────────────────────────────────────────────────────────

function openBottomSheet(code) {
  const data = cardDataMap.get(code);
  if (!data) return;
  const { ticker, result } = data;

  const strategyKey = resolveStrategy(ticker);
  const strategyLabel = getStrategyLabel(strategyKey);
  const statusClass = getStatusClass(result);
  const yahooUrl = buildYahooFinanceUrl(ticker.code, ticker.provider);
  const nameText = ticker.name || ticker.code;

  document.getElementById("bs-title").innerHTML =
    `<span class="code">${ticker.code}</span><span class="name">${nameText}</span>`;

  const dailyHtml = result.dailyChangeText
    ? `<span class="daily-change ${result.dailyChangeClass}">${result.dailyChangeText}</span>`
    : "";

  document.getElementById("bs-body").innerHTML = `
    <div class="bs-signal-row">
      <span class="card-status ${statusClass}">${result.statusText}</span>
      <span class="strategy-badge strategy-${strategyKey}">${strategyLabel}</span>
    </div>
    <div class="bs-price">${result.priceText}${dailyHtml}</div>
    <div class="bs-metrics">
      ${result.metrics.map(function (m) {
        const tip = getMetricTooltip(m.label);
        const tipHtml = tip ? `<span class="tooltip-icon" data-tooltip="${escAttr(tip)}">ⓘ</span>` : "";
        return `<div class="metric">
          <span class="label">${m.label}${tipHtml}</span>
          <span class="value">${m.value}</span>
        </div>`;
      }).join("")}
    </div>
    <a href="${yahooUrl}" target="_blank" rel="noopener" class="yahoo-link">在 Yahoo Finance 查看 →</a>
  `;

  const bs = document.getElementById("bottom-sheet");
  bs.hidden = false;
  document.body.classList.add("sheet-open");
  requestAnimationFrame(function () { bs.classList.add("open"); });
}

function closeBottomSheet() {
  const bs = document.getElementById("bottom-sheet");
  bs.classList.remove("open");
  document.body.classList.remove("sheet-open");
  bs.addEventListener("transitionend", function () { bs.hidden = true; }, { once: true });
}

function isPlaceholderEndpoint() {
  return GAS_ENDPOINT.includes("REPLACE_WITH_YOUR_DEPLOYMENT") || GAS_ENDPOINT.includes("SET_YOUR_GAS_DEPLOYMENT");
}

// ── Drawer ────────────────────────────────────────────────────────────────────

function openDrawer() {
  renderDrawerList();
  document.getElementById("drawer-overlay").classList.add("open");
  document.getElementById("drawer").classList.add("open");
  document.body.style.overflow = "hidden";
}

function closeDrawer() {
  document.getElementById("drawer-overlay").classList.remove("open");
  document.getElementById("drawer").classList.remove("open");
  document.body.style.overflow = "";
}

function renderDrawerList() {
  const tickers = loadTickers();
  const listEl = document.getElementById("drawer-list");
  const titleEl = document.getElementById("drawer-list-title");

  titleEl.textContent = "追蹤中（" + tickers.length + "）";

  if (tickers.length === 0) {
    listEl.innerHTML = '<div class="drawer-empty">尚未新增任何標的</div>';
    return;
  }

  const localCache = loadLocalCache();
  const cachedQuotes = localCache && localCache.quotes ? localCache.quotes : {};

  listEl.innerHTML = tickers.map(function (ticker, idx) {
    const strategyLabel = getStrategyLabel(resolveStrategy(ticker));
    const strategyKey = resolveStrategy(ticker);
    const isFirst = idx === 0;
    const isLast = idx === tickers.length - 1;
    const displayName = ticker.name && ticker.name !== ticker.code ? ticker.name : "";
    const q = cachedQuotes[ticker.code];
    const hasWarning = q && (q.status === "no_data" || q.status === "error");

    return `
      <div class="drawer-item${hasWarning ? " drawer-item-warn" : ""}">
        <div class="drawer-item-info">
          <div class="drawer-item-top">
            <span class="drawer-item-code">${ticker.code}</span>
            <span class="strategy-badge strategy-${strategyKey}" style="font-size:11px;padding:2px 6px;">${strategyLabel}</span>
            ${hasWarning ? `<span class="drawer-item-warning" title="查無資料，請確認代碼是否正確">⚠️</span>` : ""}
          </div>
          <div class="drawer-item-name-row" id="name-row-${idx}">
            <span class="drawer-item-name">${displayName || "（點擊 ✏️ 加入名稱）"}</span>
            <button class="drawer-item-btn" type="button" onclick="startEditName(${idx})" title="修改名稱" style="font-size:12px;">✏️</button>
          </div>
        </div>
        <div class="drawer-item-actions">
          <button class="drawer-item-btn" type="button" ${isFirst ? "disabled" : ""} onclick="moveTicker(${idx}, -1)" title="上移">↑</button>
          <button class="drawer-item-btn" type="button" ${isLast ? "disabled" : ""} onclick="moveTicker(${idx}, 1)" title="下移">↓</button>
          <button class="drawer-item-btn delete" type="button" onclick="removeTicker(${idx})" title="刪除">🗑</button>
        </div>
      </div>
    `;
  }).join("");
}

function handleAddTicker() {
  const codeInput = document.getElementById("input-code");
  const strategyInput = document.getElementById("input-strategy");
  const errorEl = document.getElementById("drawer-error");

  const code = codeInput.value.trim().toUpperCase();
  const strategy = strategyInput.value;

  errorEl.hidden = true;
  errorEl.textContent = "";
  codeInput.classList.remove("error");

  if (!code) {
    showDrawerError("請輸入股票代碼", codeInput);
    return;
  }
  if (!/^[A-Za-z0-9]+$/.test(code)) {
    showDrawerError("代碼只能包含數字與英文字母", codeInput);
    return;
  }

  const tickers = loadTickers();
  if (tickers.some(function (t) { return t.code === code; })) {
    showDrawerError("「" + code + "」已在清單中", codeInput);
    return;
  }

  tickers.push({ code: code, name: code, strategy: strategy, provider: "twse" });
  saveTickers(tickers);
  codeInput.value = "";
  strategyInput.value = "mid";

  renderDrawerList();
  refreshCardsWithCache();
}

function removeTicker(idx) {
  const tickers = loadTickers();
  tickers.splice(idx, 1);
  saveTickers(tickers);
  renderDrawerList();
  refreshCardsWithCache();
}

function moveTicker(idx, direction) {
  const tickers = loadTickers();
  const target = idx + direction;
  if (target < 0 || target >= tickers.length) return;
  const temp = tickers[idx];
  tickers[idx] = tickers[target];
  tickers[target] = temp;
  saveTickers(tickers);
  renderDrawerList();
  refreshCardsWithCache();
}

function startEditName(idx) {
  const tickers = loadTickers();
  const ticker = tickers[idx];
  if (!ticker) return;
  const row = document.getElementById("name-row-" + idx);
  if (!row) return;
  const currentName = ticker.name && ticker.name !== ticker.code ? ticker.name : "";
  row.innerHTML = `
    <input class="drawer-name-input" type="text" value="${escAttr(currentName)}" placeholder="${escAttr(ticker.code)}" maxlength="20"
      onblur="saveEditName(${idx}, this)"
      onkeydown="if(event.key==='Enter'){this.blur();}if(event.key==='Escape'){this.dataset.cancel='1';this.blur();}">
  `;
  const input = row.querySelector("input");
  input.focus();
  input.select();
}

function saveEditName(idx, input) {
  if (input.dataset.cancel === "1") {
    renderDrawerList();
    return;
  }
  const newName = input.value.trim();
  const tickers = loadTickers();
  if (!tickers[idx]) return;
  tickers[idx].name = newName || tickers[idx].code;
  saveTickers(tickers);
  renderDrawerList();
  refreshCardsWithCache();
}

function showDrawerError(message, inputEl) {
  const errorEl = document.getElementById("drawer-error");
  errorEl.textContent = message;
  errorEl.hidden = false;
  if (inputEl) inputEl.classList.add("error");
}

// 清單變更後：立即用快取重繪卡片，並靜默背景更新
function refreshCardsWithCache() {
  const tickers = loadTickers();
  const cards = document.getElementById("cards");

  if (tickers.length === 0) {
    cards.innerHTML = "";
    renderEmptyState();
    return;
  }

  const localCache = loadLocalCache();
  if (localCache) {
    renderAllCards(tickers, localCache.quotes);
  } else {
    renderSkeletonCards(tickers);
  }

  // 背景靜默更新，完成後刷新卡片與側邊欄警示
  fetchQuotes(tickers).then(function (payload) {
    if (payload && payload.quotes) {
      saveLocalCache(payload);
      renderAllCards(tickers, payload.quotes);
      if (document.getElementById("drawer").classList.contains("open")) {
        renderDrawerList();
      }
    }
  }).catch(function (err) {
    console.error("Background refresh error:", err);
  });
}
