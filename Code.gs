const QUOTES_CACHE_PREFIX = "quote_v3_";
const QUOTES_CACHE_TTL = 600;
const MARKET_CACHE_KEY = "market_cache_v1";
const MARKET_CACHE_TTL = 600;
const ENABLE_YAHOO_FALLBACK = true;

const MARKET_SYMBOLS = [
  { symbol: "^TWII",  key: "twii",   name: "台股大盤",          range: "6mo" },
  { symbol: "^GSPC",  key: "gspc",   name: "美股 S&P 500",      range: "6mo" },
  { symbol: "TWD=X",  key: "twdusd", name: "台幣匯率 (USD/TWD)", range: "6mo" },
];

const TWSE_MONTHLY_URL = "https://www.twse.com.tw/exchangeReport/STOCK_DAY";
const TPEX_MONTHLY_URL = "https://www.tpex.org.tw/web/stock/aftertrading/daily_trading_info/st43_result.php";
const YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/";

function doGet(e) {
  const params = e && e.parameter ? e.parameter : {};
  const action = params.action ? String(params.action) : "";

  if (action === "quotes") {
    const tickers = parseCodesParam(params.codes || "");
    if (tickers.length === 0) {
      return jsonResponse({
        error: "Missing codes parameter",
        expected: "action=quotes&codes=0050:twse:long,2330:twse:mid",
      });
    }
    return jsonResponse(getQuotesBatch(tickers));
  }

  if (action === "market") {
    return jsonResponse(getMarketData());
  }

  return jsonResponse({
    error: "Missing parameters",
    expected: ["action=quotes&codes=CODE:PROVIDER:STRATEGY,...", "action=market"],
    received: params,
  });
}

// codes 格式：CODE:PROVIDER:STRATEGY 以逗號分隔
// 例：0050:twse:long,2330:twse:mid,6488:tpex:mid
function parseCodesParam(codesStr) {
  if (!codesStr) return [];
  return String(codesStr).split(",")
    .map(function(item) {
      const parts = item.trim().split(":");
      const code = String(parts[0] || "").trim();
      if (!code || !/^[A-Za-z0-9]+$/.test(code)) return null;
      const provider = normalizeProvider(parts[1] || "");
      const strategyRaw = String(parts[2] || "").toLowerCase();
      const strategy = ["long", "mid", "short"].includes(strategyRaw) ? strategyRaw : "mid";
      return { code: code, provider: provider, strategy: strategy };
    })
    .filter(Boolean);
}

function getQuotesBatch(tickers) {
  const cache = CacheService.getScriptCache();
  const quotes = {};
  const uncached = [];

  // 逐一檢查 per-ticker 快取
  tickers.forEach(function(ticker) {
    const cached = cache.get(QUOTES_CACHE_PREFIX + ticker.code);
    if (cached) {
      const parsed = JSON.parse(cached);
      parsed.cacheHit = true;
      quotes[ticker.code] = parsed;
    } else {
      uncached.push(ticker);
    }
  });

  if (uncached.length === 0) {
    return { quotes: quotes, meta: { generatedAt: new Date().toISOString(), cacheHit: true } };
  }

  // 依 provider 分組，各自並行抓取
  const twseTickers  = uncached.filter(function(t) { return t.provider === "twse"; });
  const tpexTickers  = uncached.filter(function(t) { return t.provider === "tpex"; });
  const yahooTickers = uncached.filter(function(t) { return t.provider === "yahoo"; });
  const monthlyTickers = twseTickers.concat(tpexTickers);

  // TWSE + TPEX：單次 fetchAll 跨所有標的所有月份
  if (monthlyTickers.length > 0) {
    const monthlyResults = fetchMonthlyBatch(monthlyTickers);
    Object.keys(monthlyResults).forEach(function(code) {
      quotes[code] = monthlyResults[code];
    });
  }

  // Yahoo：單次 fetchAll 跨所有標的
  if (yahooTickers.length > 0) {
    const yahooResults = fetchYahooBatch(yahooTickers, false);
    Object.keys(yahooResults).forEach(function(code) {
      quotes[code] = yahooResults[code];
    });
  }

  // Yahoo 備援：TWSE/TPEX 回 no_data 時自動嘗試 Yahoo
  if (ENABLE_YAHOO_FALLBACK) {
    const needsFallback = monthlyTickers.filter(function(t) {
      return quotes[t.code] && quotes[t.code].status === "no_data";
    });
    if (needsFallback.length > 0) {
      const fallbackResults = fetchYahooBatch(needsFallback, true);
      needsFallback.forEach(function(t) {
        if (fallbackResults[t.code] && fallbackResults[t.code].status === "ok") {
          quotes[t.code] = fallbackResults[t.code];
        }
      });
    }
  }

  // 快取各標的結果，附假日保護：新資料若為 no_data 且舊快取為 ok，保留舊快取
  uncached.forEach(function(ticker) {
    const result = quotes[ticker.code];
    if (!result) return;
    const cacheKey = QUOTES_CACHE_PREFIX + ticker.code;
    if (result.status === "no_data") {
      const existing = cache.get(cacheKey);
      if (existing) {
        try {
          const existingParsed = JSON.parse(existing);
          if (existingParsed.status === "ok") return;
        } catch (e) {}
      }
    }
    try {
      cache.put(cacheKey, JSON.stringify(result), QUOTES_CACHE_TTL);
    } catch (e) {}
  });

  return {
    quotes: quotes,
    meta: { generatedAt: new Date().toISOString(), cacheHit: false },
  };
}

// 將所有 TWSE/TPEX 標的的所有月份 URL 合併成一次 fetchAll
function fetchMonthlyBatch(tickers) {
  const allRequests = [];
  const requestMeta = [];

  tickers.forEach(function(ticker) {
    const provider = normalizeProvider(ticker.provider);
    const strategy = String(ticker.strategy || "mid").toLowerCase();
    const months = getRecentMonths(getMonthCountForStrategy(strategy));

    months.forEach(function(ym) {
      var url;
      if (provider === "tpex") {
        url = TPEX_MONTHLY_URL + "?l=zh-tw&d=" + toRocYearMonth(ym) + "&stkno=" + encodeURIComponent(ticker.code);
      } else {
        url = TWSE_MONTHLY_URL + "?response=json&date=" + ym + "01&stockNo=" + encodeURIComponent(ticker.code);
      }
      allRequests.push({ url: url, method: "get", muteHttpExceptions: true, followRedirects: true });
      requestMeta.push({ code: ticker.code, provider: provider });
    });
  });

  const responses = UrlFetchApp.fetchAll(allRequests);

  const rowsByCode = {};
  const providerByCode = {};
  tickers.forEach(function(t) {
    rowsByCode[t.code] = [];
    providerByCode[t.code] = normalizeProvider(t.provider);
  });

  responses.forEach(function(response, i) {
    const meta = requestMeta[i];
    if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) return;
    const data = safeJsonParse(response.getContentText());
    if (!data) return;

    if (meta.provider === "tpex") {
      const fields = data.fields || [];
      const table = data.aaData || data.data;
      if (!Array.isArray(table)) return;
      const dIdx = fields.indexOf("日期") !== -1 ? fields.indexOf("日期") : 0;
      const cIdx = fields.indexOf("收盤價") !== -1 ? fields.indexOf("收盤價") : 6;
      table.forEach(function(row) { rowsByCode[meta.code].push({ date: row[dIdx], close: row[cIdx] }); });
    } else {
      const fields = data.fields || [];
      const dateIdx = fields.indexOf("日期");
      const closeIdx = fields.indexOf("收盤價");
      if (dateIdx === -1 || closeIdx === -1 || !Array.isArray(data.data)) return;
      data.data.forEach(function(row) { rowsByCode[meta.code].push({ date: row[dateIdx], close: row[closeIdx] }); });
    }
  });

  const results = {};
  tickers.forEach(function(ticker) {
    results[ticker.code] = buildSeriesResult(rowsByCode[ticker.code], ticker.code, providerByCode[ticker.code]);
  });
  return results;
}

// 將所有 Yahoo 標的的 .TW/.TWO 同時送出，取第一個有效回應
function fetchYahooBatch(tickers, isFallback) {
  const allRequests = [];
  const requestMeta = [];

  tickers.forEach(function(ticker) {
    const strategy = String(ticker.strategy || "mid").toLowerCase();
    const range = getYahooRange(strategy);
    buildYahooSymbols(ticker.code).forEach(function(symbol, symIdx) {
      const url = YAHOO_CHART_URL + encodeURIComponent(symbol) + "?interval=1d&range=" + range;
      allRequests.push({ url: url, method: "get", muteHttpExceptions: true, followRedirects: true });
      requestMeta.push({ code: ticker.code, symIdx: symIdx });
    });
  });

  const responses = UrlFetchApp.fetchAll(allRequests);
  const resultsByCode = {};

  responses.forEach(function(response, i) {
    const meta = requestMeta[i];
    if (resultsByCode[meta.code] && resultsByCode[meta.code].status === "ok") return;
    if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) return;

    const data = safeJsonParse(response.getContentText());
    if (!data) return;
    const chart = data.chart;
    if (!chart || chart.error || !chart.result || !chart.result[0]) return;

    const node = chart.result[0];
    const timestamps = Array.isArray(node.timestamp) ? node.timestamp : [];
    const closes = node.indicators && node.indicators.quote && node.indicators.quote[0]
      ? node.indicators.quote[0].close || []
      : [];
    const series = normalizeSeries(timestamps, closes);
    if (series.timestamp.length === 0) return;

    const source = isFallback ? "yahoo_fallback" : "yahoo";
    resultsByCode[meta.code] = finalizeSeries(meta.code, series, source);
  });

  // 沒取到資料的補 no_data
  tickers.forEach(function(ticker) {
    if (!resultsByCode[ticker.code]) {
      const source = isFallback ? "yahoo_fallback" : "yahoo";
      resultsByCode[ticker.code] = { code: ticker.code, provider: "yahoo", source: source, status: "no_data", error: "NO_DATA" };
    }
  });

  return resultsByCode;
}

// ─── 市場總覽 ────────────────────────────────────────────────────────────────

function getMarketData() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(MARKET_CACHE_KEY);
  if (cached) {
    const payload = JSON.parse(cached);
    payload.meta.cacheHit = true;
    return payload;
  }

  const allRequests = MARKET_SYMBOLS.map(function(def) {
    return {
      url: YAHOO_CHART_URL + encodeURIComponent(def.symbol) + "?interval=1d&range=" + def.range,
      method: "get",
      muteHttpExceptions: true,
      followRedirects: true,
    };
  });

  const responses = UrlFetchApp.fetchAll(allRequests);
  const markets = {};

  MARKET_SYMBOLS.forEach(function(def, i) {
    markets[def.key] = parseMarketResponse(responses[i], def);
  });

  const payload = {
    markets: markets,
    meta: { generatedAt: new Date().toISOString(), cacheHit: false },
  };
  cache.put(MARKET_CACHE_KEY, JSON.stringify(payload), MARKET_CACHE_TTL);
  return payload;
}

function parseMarketResponse(response, def) {
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
    return { key: def.key, name: def.name, status: "error", error: "FETCH_FAILED" };
  }
  const data = safeJsonParse(response.getContentText());
  if (!data) return { key: def.key, name: def.name, status: "error", error: "PARSE_FAILED" };

  const chart = data.chart;
  if (!chart || chart.error || !chart.result || !chart.result[0]) {
    return { key: def.key, name: def.name, status: "no_data", error: "NO_DATA" };
  }

  const node = chart.result[0];
  const timestamps = Array.isArray(node.timestamp) ? node.timestamp : [];
  const closes = node.indicators && node.indicators.quote && node.indicators.quote[0]
    ? node.indicators.quote[0].close || []
    : [];
  const series = normalizeSeries(timestamps, closes);
  if (series.timestamp.length === 0) {
    return { key: def.key, name: def.name, status: "no_data", error: "NO_DATA" };
  }

  return {
    key: def.key,
    name: def.name,
    status: "ok",
    timestamp: series.timestamp,
    close: series.close,
    lastTradingDate: formatDate(series.timestamp[series.timestamp.length - 1]),
  };
}

// ─── 時間觸發器（僅預熱市場總覽） ─────────────────────────────────────────────

function refreshCacheOnSchedule() {
  const cache = CacheService.getScriptCache();
  cache.remove(MARKET_CACHE_KEY);
  getMarketData();
}

function setupTimeTrigger() {
  removeTimeTriggers();
  ScriptApp.newTrigger("refreshCacheOnSchedule")
    .timeBased()
    .everyMinutes(10)
    .create();
  Logger.log("觸發器已建立，每 10 分鐘自動預熱市場總覽快取。");
}

function removeTimeTriggers() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === "refreshCacheOnSchedule") {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  Logger.log("觸發器已移除。");
}

// ─── 共用工具函式 ─────────────────────────────────────────────────────────────

function buildSeriesResult(rows, code, source) {
  if (!rows || rows.length === 0) {
    return { code: code, provider: source, source: source, status: "no_data", error: "NO_DATA" };
  }
  const timestamps = [];
  const closes = [];
  rows.forEach(function(row) {
    const ts = parseDateToUnix(row.date);
    const close = parseNumber(row.close);
    if (ts && close) { timestamps.push(ts); closes.push(close); }
  });
  const series = normalizeSeries(timestamps, closes);
  if (series.timestamp.length === 0) {
    return { code: code, provider: source, source: source, status: "no_data", error: "NO_DATA" };
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
  return [upper + ".TW", upper + ".TWO"];
}

function normalizeProvider(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "twse" || raw === "tpex" || raw === "yahoo") return raw;
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
    months.push(y + String(m).padStart(2, "0"));
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
  }
  return months;
}

function toRocYearMonth(ym) {
  const year = Number(ym.slice(0, 4));
  const month = ym.slice(4, 6);
  return (year - 1911) + "/" + month;
}

function formatDate(timestampSeconds) {
  const date = new Date(timestampSeconds * 1000);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return year + "-" + month + "-" + day;
}

function safeJsonParse(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}

function jsonResponse(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
