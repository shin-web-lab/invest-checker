const SPREADSHEET_ID = "REPLACE_ME";
const SHEET_NAME = "REPLACE_ME";

const TICKERS_CACHE_KEY = "tickers_cache_v2";
const QUOTES_CACHE_KEY = "quotes_cache_v2";
const TICKERS_CACHE_TTL = 600;
const QUOTES_CACHE_TTL = 180;
const ENABLE_YAHOO_FALLBACK = true;

const TWSE_MONTHLY_URL = "https://www.twse.com.tw/exchangeReport/STOCK_DAY";
const TPEX_MONTHLY_URL = "https://www.tpex.org.tw/web/stock/aftertrading/daily_trading_info/st43_result.php";
const YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/";

function doGet(e) {
  const params = e && e.parameter ? e.parameter : {};
  const action = params.action ? String(params.action) : "";
  const code = params.code ? String(params.code).trim() : "";

  if (action === "tickers") {
    const listResult = getTickersFromSheet(true);
    return jsonResponse({
      tickers: listResult.tickers,
      meta: {
        generatedAt: new Date().toISOString(),
        cacheHit: listResult.cacheHit,
      },
    });
  }

  if (action === "quotes") {
    return jsonResponse(getQuotesBatch());
  }

  if (code) {
    return jsonResponse(getSingleQuote(code));
  }

  return jsonResponse({
    error: "Missing parameters",
    expected: ["action=tickers|quotes"],
    received: params,
  });
}

function getTickersFromSheet(onlyEnabled) {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(TICKERS_CACHE_KEY);
  if (cached) {
    return { tickers: JSON.parse(cached), cacheHit: true };
  }

  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    throw new Error("Sheet not found");
  }

  const values = sheet.getDataRange().getValues();
  if (values.length < 2) {
    cache.put(TICKERS_CACHE_KEY, JSON.stringify([]), TICKERS_CACHE_TTL);
    return { tickers: [], cacheHit: false };
  }

  const headers = values[0].map((v) => String(v).trim());
  const codeIdx = headers.indexOf("code");
  const nameIdx = headers.indexOf("name");
  const strategyIdx = headers.indexOf("strategy");
  const enabledIdx = headers.indexOf("enabled");
  const providerIdx = headers.indexOf("provider");

  if (codeIdx === -1 || nameIdx === -1 || enabledIdx === -1 || providerIdx === -1) {
    throw new Error("Invalid headers");
  }

  const result = [];
  for (let i = 1; i < values.length; i += 1) {
    const row = values[i];
    const hasData = row.some((cell) => cell !== "" && cell !== null && cell !== undefined);
    if (!hasData) continue;

    const enabled = row[enabledIdx] === true;
    if (onlyEnabled && !enabled) continue;

    const code = row[codeIdx] != null ? String(row[codeIdx]).trim() : "";
    const name = row[nameIdx] != null ? String(row[nameIdx]).trim() : "";
    const strategyRaw = strategyIdx !== -1 ? row[strategyIdx] : "";
    const strategy = strategyRaw != null ? String(strategyRaw).trim().toLowerCase() : "";
    const providerRaw = providerIdx !== -1 ? row[providerIdx] : "";
    const provider = normalizeProvider(providerRaw);

    if (!code) continue;

    result.push({
      code: code,
      name: name,
      strategy: strategy,
      enabled: enabled,
      provider: provider,
    });
  }

  cache.put(TICKERS_CACHE_KEY, JSON.stringify(result), TICKERS_CACHE_TTL);
  return { tickers: result, cacheHit: false };
}

function getQuotesBatch() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(QUOTES_CACHE_KEY);
  if (cached) {
    const payload = JSON.parse(cached);
    payload.meta = {
      generatedAt: payload.meta && payload.meta.generatedAt ? payload.meta.generatedAt : new Date().toISOString(),
      cacheHit: true,
    };
    return payload;
  }

  const listResult = getTickersFromSheet(true);
  const tickers = listResult.tickers;
  const quotes = {};

  for (let i = 0; i < tickers.length; i += 1) {
    const ticker = tickers[i];
    quotes[ticker.code] = fetchQuoteForTicker(ticker);
  }

  const payload = {
    quotes: quotes,
    meta: {
      generatedAt: new Date().toISOString(),
      cacheHit: false,
    },
  };

  cache.put(QUOTES_CACHE_KEY, JSON.stringify(payload), QUOTES_CACHE_TTL);
  return payload;
}

function getSingleQuote(code) {
  const cleanCode = String(code || "").trim();
  if (!cleanCode || cleanCode.includes(".")) {
    return { error: "Code not allowed" };
  }

  const listResult = getTickersFromSheet(true);
  const tickers = listResult.tickers;
  const ticker = tickers.find((item) => String(item.code || "").trim() === cleanCode);
  if (!ticker) {
    return { error: "Code not allowed" };
  }

  return fetchQuoteForTicker(ticker);
}

function fetchQuoteForTicker(ticker) {
  const provider = normalizeProvider(ticker.provider);
  const strategy = String(ticker.strategy || "").toLowerCase();

  let result = fetchByProvider(provider, ticker.code, strategy);
  if (result.status === "ok") {
    return result;
  }

  if (result.status === "no_data" && ENABLE_YAHOO_FALLBACK && provider !== "yahoo") {
    const fallback = fetchFromYahoo(ticker.code, strategy, true);
    if (fallback.status === "ok") {
      fallback.source = "yahoo_fallback";
      return fallback;
    }
  }

  return result;
}

function fetchByProvider(provider, code, strategy) {
  if (provider === "yahoo") {
    return fetchFromYahoo(code, strategy, false);
  }
  if (provider === "tpex") {
    return fetchFromTPEX(code, strategy);
  }
  return fetchFromTWSE(code, strategy);
}

function fetchFromTWSE(code, strategy) {
  const months = getRecentMonths(getMonthCountForStrategy(strategy));
  const urls = months.map((ym) => {
    return `${TWSE_MONTHLY_URL}?response=json&date=${ym}01&stockNo=${encodeURIComponent(code)}`;
  });
  const rows = fetchMonthlyRows(urls, "TWSE");
  return buildSeriesResult(rows, code, "twse");
}

function fetchFromTPEX(code, strategy) {
  const months = getRecentMonths(getMonthCountForStrategy(strategy));
  const urls = months.map((ym) => {
    const roc = toRocYearMonth(ym);
    return `${TPEX_MONTHLY_URL}?l=zh-tw&d=${roc}&stkno=${encodeURIComponent(code)}`;
  });
  const rows = fetchMonthlyRows(urls, "TPEX");
  return buildSeriesResult(rows, code, "tpex");
}

function fetchFromYahoo(code, strategy, isFallback) {
  const range = getYahooRange(strategy);
  const symbols = buildYahooSymbols(code);

  for (let i = 0; i < symbols.length; i += 1) {
    const symbol = symbols[i];
    const url = `${YAHOO_CHART_URL}${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
    const response = fetchJson(url);
    if (!response) {
      continue;
    }

    const chart = response.chart;
    if (!chart || chart.error || !chart.result || !chart.result[0]) {
      const errorMessage = chart && chart.error ? String(chart.error.description || "") : "";
      if (errorMessage && errorMessage.toLowerCase().includes("no data")) {
        continue;
      }
      if (i < symbols.length - 1) {
        continue;
      }
      return {
        code: code,
        provider: "yahoo",
        source: isFallback ? "yahoo_fallback" : "yahoo",
        status: "error",
        error: "UPSTREAM_ERROR",
      };
    }

    const node = chart.result[0];
    const timestamps = Array.isArray(node.timestamp) ? node.timestamp : [];
    const closes = node.indicators && node.indicators.quote && node.indicators.quote[0]
      ? node.indicators.quote[0].close || []
      : [];

    const series = normalizeSeries(timestamps, closes);
    if (series.timestamp.length === 0) {
      continue;
    }

    return finalizeSeries(code, series, isFallback ? "yahoo_fallback" : "yahoo");
  }

  return {
    code: code,
    provider: "yahoo",
    source: "yahoo",
    status: "no_data",
    error: "NO_DATA",
  };
}

function fetchMonthlyRows(urls, market) {
  const rows = [];
  const requests = urls.map((url) => ({
    url: url,
    method: "get",
    muteHttpExceptions: true,
    followRedirects: true,
  }));

  const responses = UrlFetchApp.fetchAll(requests);
  for (let i = 0; i < responses.length; i += 1) {
    const response = responses[i];
    if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
      continue;
    }
    const data = safeJsonParse(response.getContentText());
    if (!data) continue;

    if (market === "TWSE") {
      const fields = data.fields || [];
      const dateIdx = fields.indexOf("日期");
      const closeIdx = fields.indexOf("收盤價");
      if (dateIdx === -1 || closeIdx === -1 || !Array.isArray(data.data)) {
        continue;
      }
      data.data.forEach((row) => {
        rows.push({ date: row[dateIdx], close: row[closeIdx] });
      });
    }

    if (market === "TPEX") {
      const fields = data.fields || [];
      const dateIdx = fields.indexOf("日期");
      const closeIdx = fields.indexOf("收盤價");
      const table = data.aaData || data.data;
      if (!Array.isArray(table)) {
        continue;
      }
      const dIdx = dateIdx !== -1 ? dateIdx : 0;
      const cIdx = closeIdx !== -1 ? closeIdx : 6;
      table.forEach((row) => {
        rows.push({ date: row[dIdx], close: row[cIdx] });
      });
    }
  }

  return rows;
}

function buildSeriesResult(rows, code, source) {
  if (!rows || rows.length === 0) {
    return {
      code: code,
      provider: source,
      source: source,
      status: "no_data",
      error: "NO_DATA",
    };
  }

  const timestamps = [];
  const closes = [];
  rows.forEach((row) => {
    const ts = parseDateToUnix(row.date);
    const close = parseNumber(row.close);
    if (ts && close) {
      timestamps.push(ts);
      closes.push(close);
    }
  });

  const series = normalizeSeries(timestamps, closes);
  if (series.timestamp.length === 0) {
    return {
      code: code,
      provider: source,
      source: source,
      status: "no_data",
      error: "NO_DATA",
    };
  }

  return finalizeSeries(code, series, source);
}

function finalizeSeries(code, series, source) {
  const lastTradingDate = series.timestamp.length > 0
    ? formatDate(series.timestamp[series.timestamp.length - 1])
    : null;

  return {
    code: code,
    provider: source,
    source: source,
    timestamp: series.timestamp,
    close: series.close,
    lastTradingDate: lastTradingDate,
    status: "ok",
  };
}

function normalizeSeries(timestamps, closes) {
  const filteredTimestamps = [];
  const filteredCloses = [];
  const length = Math.min(timestamps.length, closes.length);
  for (let i = 0; i < length; i += 1) {
    const price = closes[i];
    if (price !== null && price !== undefined && Number(price) !== 0) {
      filteredTimestamps.push(Number(timestamps[i]));
      filteredCloses.push(Number(price));
    }
  }
  return { timestamp: filteredTimestamps, close: filteredCloses };
}

function getMonthCountForStrategy(strategy) {
  const required = getRequiredDays(strategy);
  const months = Math.ceil(required / 22) + 1;
  if (months < 3) return 3;
  if (months > 12) return 12;
  return months;
}

function getRequiredDays(strategy) {
  if (strategy === "short") return 11;
  if (strategy === "long") return 121;
  return 21;
}

function getYahooRange(strategy) {
  if (strategy === "long") return "1y";
  if (strategy === "mid") return "6mo";
  return "3mo";
}

function buildYahooSymbols(code) {
  const upper = String(code || "").trim().toUpperCase();
  return [`${upper}.TW`, `${upper}.TWO`];
}

function normalizeProvider(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "twse" || raw === "tpex" || raw === "yahoo") {
    return raw;
  }
  return "twse";
}

function parseDateToUnix(dateStr) {
  if (!dateStr) return null;
  const s = String(dateStr).trim();
  if (s.includes("/")) {
    const parts = s.split("/");
    if (parts.length === 3) {
      const y = Number(parts[0]) + 1911;
      const m = Number(parts[1]);
      const d = Number(parts[2]);
      if (!Number.isNaN(y) && !Number.isNaN(m) && !Number.isNaN(d)) {
        return Math.floor(new Date(y, m - 1, d).getTime() / 1000);
      }
    }
  }
  if (s.includes("-")) {
    const parts = s.split("-");
    if (parts.length === 3) {
      const y = Number(parts[0]);
      const m = Number(parts[1]);
      const d = Number(parts[2]);
      if (!Number.isNaN(y) && !Number.isNaN(m) && !Number.isNaN(d)) {
        return Math.floor(new Date(y, m - 1, d).getTime() / 1000);
      }
    }
  }
  return null;
}

function parseNumber(value) {
  if (value == null) return null;
  const n = Number(String(value).replace(/,/g, ""));
  if (Number.isNaN(n) || n === 0) return null;
  return n;
}

function getRecentMonths(count) {
  const months = [];
  const now = new Date();
  let y = now.getFullYear();
  let m = now.getMonth() + 1;
  for (let i = 0; i < count; i += 1) {
    const ym = `${y}${String(m).padStart(2, "0")}`;
    months.push(ym);
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return months;
}

function toRocYearMonth(ym) {
  const year = Number(ym.slice(0, 4));
  const month = ym.slice(4, 6);
  const rocYear = year - 1911;
  return `${rocYear}/${month}`;
}

function formatDate(timestampSeconds) {
  const date = new Date(timestampSeconds * 1000);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function fetchJson(url) {
  try {
    const response = UrlFetchApp.fetch(url, {
      method: "get",
      muteHttpExceptions: true,
      followRedirects: true,
    });
    const status = response.getResponseCode();
    if (status < 200 || status >= 300) {
      return null;
    }
    return safeJsonParse(response.getContentText());
  } catch (err) {
    return null;
  }
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
}

function jsonResponse(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
