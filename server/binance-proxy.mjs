import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || process.env.BINANCE_PROXY_PORT || 3001);
const BINANCE_BASE = (process.env.BINANCE_FAPI_BASE || "https://fapi.binance.com").replace(
  /\/$/,
  ""
);
const BINANCE_WS_BASE = (process.env.BINANCE_FAPI_WS_BASE || "wss://fstream.binance.com").replace(/\/$/, "");
const ALLOWED_SIGNED_PATHS = new Set([
  "/fapi/v2/account",
  "/fapi/v2/positionRisk",
  "/fapi/v1/order",
  "/fapi/v1/allOpenOrders",
  "/fapi/v1/openOrders",
  "/fapi/v1/userTrades",
]);
const ALLOWED_PUBLIC_PATHS = new Set(["/fapi/v1/exchangeInfo", "/fapi/v1/premiumIndex"]);
const cycleWorkers = new Map();
const accountStreams = new Map();
const markPriceStreams = new Map(); // symbol → { ws, lastPrice, connecting, clientIds: Set }
const sseClients = new Map(); // clientId → { res, symbol, streamKey }
let _sseClientId = 0;
const CYCLE_FALLBACK_POLL_MS = Number(process.env.BINANCE_CYCLE_FALLBACK_POLL_MS || 10000);

// ── htpasswd user management ──────────────────────────────────────────────────
// HTPASSWD_FILE: path to nginx .htpasswd file (Ubuntu VPS only).
// ADMIN_TOKEN:   auto-generated on first run and saved to .admin_token next to this file.
//                Override with ADMIN_TOKEN env var if you prefer.
const HTPASSWD_FILE = process.env.HTPASSWD_FILE || "/etc/nginx/.htpasswd";

const ADMIN_TOKEN_FILE = join(__dirname, ".admin_token");
let ADMIN_TOKEN = (process.env.ADMIN_TOKEN || "").trim();
if (!ADMIN_TOKEN) {
  try { ADMIN_TOKEN = fs.readFileSync(ADMIN_TOKEN_FILE, "utf8").trim(); } catch { /* not yet created */ }
}
if (!ADMIN_TOKEN) {
  ADMIN_TOKEN = crypto.randomBytes(32).toString("hex");
  try { fs.writeFileSync(ADMIN_TOKEN_FILE, ADMIN_TOKEN, "utf8"); } catch { /* ignore write error */ }
  console.log(`[admin] Generated admin token — saved to ${ADMIN_TOKEN_FILE}`);
}

// Generates an APR1-MD5 password hash (same format as `htpasswd -m`).
// Pure Node.js — no external dependencies needed.
function apr1Md5(password, salt) {
  const chars = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  if (!salt) salt = Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  const pw = Buffer.from(password, "utf8");
  const sp = Buffer.from(salt, "utf8");
  const magic = Buffer.from("$apr1$", "utf8");
  const ctx = crypto.createHash("md5");
  ctx.update(pw); ctx.update(magic); ctx.update(sp);
  const ctx1 = crypto.createHash("md5");
  ctx1.update(pw); ctx1.update(sp); ctx1.update(pw);
  let fin = ctx1.digest();
  for (let pl = pw.length; pl > 0; pl -= 16) ctx.update(fin.slice(0, Math.min(16, pl)));
  for (let i = pw.length; i; i >>= 1) ctx.update(i & 1 ? Buffer.alloc(1) : pw.slice(0, 1));
  fin = ctx.digest();
  for (let i = 0; i < 1000; i++) {
    const c = crypto.createHash("md5");
    if (i & 1) c.update(pw); else c.update(fin);
    if (i % 3) c.update(sp);
    if (i % 7) c.update(pw);
    if (i & 1) c.update(fin); else c.update(pw);
    fin = c.digest();
  }
  const to64 = (v, n) => { let r = ""; for (; n-- > 0; v >>= 6) r += chars[v & 0x3f]; return r; };
  return `$apr1$${salt}$` +
    to64((fin[0] << 16) | (fin[6]  << 8) | fin[12], 4) +
    to64((fin[1] << 16) | (fin[7]  << 8) | fin[13], 4) +
    to64((fin[2] << 16) | (fin[8]  << 8) | fin[14], 4) +
    to64((fin[3] << 16) | (fin[9]  << 8) | fin[15], 4) +
    to64((fin[4] << 16) | (fin[10] << 8) | fin[5],  4) +
    to64(fin[11], 2);
}

function readHtpasswd() {
  try {
    return fs.readFileSync(HTPASSWD_FILE, "utf8")
      .split("\n").filter(Boolean)
      .map(line => { const i = line.indexOf(":"); return { username: line.slice(0, i), hash: line.slice(i + 1) }; });
  } catch { return []; }
}

function writeHtpasswd(entries) {
  fs.writeFileSync(HTPASSWD_FILE, entries.map(e => `${e.username}:${e.hash}`).join("\n") + "\n", "utf8");
}

function htpasswdSet(username, password) {
  const entries = readHtpasswd();
  const hash = apr1Md5(password);
  const idx = entries.findIndex(e => e.username === username);
  if (idx >= 0) entries[idx].hash = hash; else entries.push({ username, hash });
  writeHtpasswd(entries);
}

function htpasswdDelete(username) {
  writeHtpasswd(readHtpasswd().filter(e => e.username !== username));
}

function checkAdminToken(body) {
  return ADMIN_TOKEN && String(body.adminToken || "") === ADMIN_TOKEN;
}

function streamTag(stream) {
  return `[ws ${String(stream?.key || "unknown").slice(0, 18)}]`;
}

function sseWrite(res, eventName, data) {
  try {
    res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    // client disconnected
  }
}

function broadcastMarkPrice(symbol, price) {
  for (const [, client] of sseClients) {
    if (client.symbol === symbol) sseWrite(client.res, "markPrice", { symbol, price });
  }
}

function broadcastOrderUpdate(skey, fill) {
  // Filter by both streamKey AND symbol: two SSE clients on the same API key but different
  // symbols share a streamKey. Without the symbol check, ETHUSDT fills would appear in the
  // BTCUSDT UI and vice versa.
  const sym = String(fill.symbol || "").toUpperCase();
  for (const [, client] of sseClients) {
    if (client.streamKey === skey && client.symbol === sym) sseWrite(client.res, "orderUpdate", fill);
  }
}

function connectMarkPriceStream(symbol) {
  const mps = markPriceStreams.get(symbol);
  if (!mps || mps.connecting || mps.ws) return;
  mps.connecting = true;
  const wsUrl = `${BINANCE_WS_BASE}/ws/${symbol.toLowerCase()}@markPrice@1s`;
  const ws = new WebSocket(wsUrl);
  mps.ws = ws;
  ws.on("open", () => {
    mps.connecting = false;
    mps.lastMessageAt = Date.now();
    console.log(`[markPrice ${symbol}] connected`);
    // Health check: stream should produce a message every ~1s. If >5s pass without
    // one the connection has silently stalled — force-close so the close handler reconnects.
    if (mps.healthTimer) clearInterval(mps.healthTimer);
    mps.healthTimer = setInterval(() => {
      if (!mps.ws) { clearInterval(mps.healthTimer); mps.healthTimer = null; return; }
      if (Date.now() - mps.lastMessageAt > 5000) {
        console.warn(`[markPrice ${symbol}] stale (no message >5s), reconnecting`);
        clearInterval(mps.healthTimer);
        mps.healthTimer = null;
        try { mps.ws.close(); } catch { /* ignore */ }
      }
    }, 3000);
  });
  ws.on("message", (raw) => {
    try {
      const d = JSON.parse(String(raw));
      if (d && d.p) {
        mps.lastPrice = String(d.p);
        mps.lastMessageAt = Date.now();
        broadcastMarkPrice(symbol, mps.lastPrice);
      }
    } catch {
      // ignore malformed
    }
  });
  ws.on("close", () => {
    if (mps.healthTimer) { clearInterval(mps.healthTimer); mps.healthTimer = null; }
    mps.ws = null;
    mps.connecting = false;
    if (mps.clientIds.size > 0) {
      setTimeout(() => connectMarkPriceStream(symbol), 2000);
    }
  });
  ws.on("error", (err) => {
    console.error(`[markPrice ${symbol}] error: ${err.message}`);
    mps.connecting = false;
  });
}

function getOrCreateMarkPriceStream(symbol) {
  if (!markPriceStreams.has(symbol)) {
    markPriceStreams.set(symbol, { ws: null, lastPrice: null, connecting: false, clientIds: new Set(), healthTimer: null, lastMessageAt: 0 });
  }
  const mps = markPriceStreams.get(symbol);
  if (!mps.ws && !mps.connecting) connectMarkPriceStream(symbol);
  return mps;
}

function releaseMarkPriceStream(symbol, clientId) {
  const mps = markPriceStreams.get(symbol);
  if (!mps) return;
  mps.clientIds.delete(clientId);
  if (mps.clientIds.size === 0) {
    if (mps.healthTimer) { clearInterval(mps.healthTimer); mps.healthTimer = null; }
    if (mps.ws) { try { mps.ws.close(); } catch { /* ignore */ } }
    markPriceStreams.delete(symbol);
    console.log(`[markPrice ${symbol}] stream released`);
  }
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function collectJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk);
      if (raw.length > 2_000_000) {
        reject(new Error("Body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function toQuery(params) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    usp.set(k, String(v));
  }
  return usp.toString();
}

async function callBinance({ method, path, apiKey, apiSecret, params = {} }) {
  const timestamp = Date.now();
  const q = toQuery({ ...params, recvWindow: 10000, timestamp });
  const signature = crypto.createHmac("sha256", apiSecret).update(q).digest("hex");
  const url = `${BINANCE_BASE}${path}?${q}&signature=${signature}`;
  const response = await fetch(url, {
    method,
    headers: {
      "X-MBX-APIKEY": apiKey,
    },
  });
  const text = await response.text();
  let data = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // keep text
  }
  if (!response.ok) {
    const msg = data && typeof data === "object" && "msg" in data ? String(data.msg) : text;
    const err = new Error(msg || response.statusText);
    err.statusCode = response.status;
    err.payload = data;
    throw err;
  }
  return data;
}

const BROKER_API_BASE = "https://api.binance.com";

async function callBroker({ method, path, apiKey, apiSecret, params = {} }) {
  const timestamp = Date.now();
  const q = toQuery({ ...params, recvWindow: 10000, timestamp });
  const signature = crypto.createHmac("sha256", apiSecret).update(q).digest("hex");
  // For Binance SAPI endpoints (api.binance.com), all signed params — including for POST —
  // must be in the URL query string. Putting them in the request body causes -1022 (invalid signature).
  const url = `${BROKER_API_BASE}${path}?${q}&signature=${signature}`;
  const response = await fetch(url, { method, headers: { "X-MBX-APIKEY": apiKey } });
  const text = await response.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) {
    const msg = data && typeof data === "object" && "msg" in data ? String(data.msg) : text;
    const err = new Error(msg || response.statusText);
    err.statusCode = response.status;
    err.payload = data;
    throw err;
  }
  return data;
}

async function callPublic(path, params = {}) {
  const q = toQuery(params);
  const url = `${BINANCE_BASE}${path}${q ? `?${q}` : ""}`;
  const response = await fetch(url);
  const text = await response.text();
  let data = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // keep text
  }
  if (!response.ok) {
    const err = new Error(text || response.statusText);
    err.statusCode = response.status;
    err.payload = data;
    throw err;
  }
  return data;
}

async function callApiKeyOnly({ method, path, apiKey, params = {} }) {
  const q = toQuery(params);
  const url = `${BINANCE_BASE}${path}${q ? `?${q}` : ""}`;
  const response = await fetch(url, {
    method,
    headers: {
      "X-MBX-APIKEY": apiKey,
    },
  });
  const text = await response.text();
  let data = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // keep text
  }
  if (!response.ok) {
    const msg = data && typeof data === "object" && "msg" in data ? String(data.msg) : text;
    const err = new Error(msg || response.statusText);
    err.statusCode = response.status;
    err.payload = data;
    throw err;
  }
  return data;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Shared open-orders cache to prevent N workers on the same symbol from each issuing
// a separate GET /openOrders during the same fallback poll window.
// GET /openOrders costs 40 weight. 17 workers × 40 = 680/10s > Binance's 200/10s limit.
// This cache ensures at most 1 fetch per apiKey::symbol every OPEN_ORDERS_CACHE_MS ms.
const openOrdersCache = new Map(); // "apiKey::symbol" → { openIds, fetchedAt, inFlight, waiters }
const OPEN_ORDERS_CACHE_MS = 5_000;

// Returns a Set of open order IDs, or null if the fetch failed.
// Null signals callers to skip individual order checks (avoids 136 GET /order calls on error).
async function fetchOpenOrdersShared(apiKey, apiSecret, symbol) {
  const cacheKey = `${apiKey}::${symbol}`;
  let cache = openOrdersCache.get(cacheKey);
  if (!cache) {
    cache = { openIds: null, fetchedAt: 0, inFlight: false, waiters: [] };
    openOrdersCache.set(cacheKey, cache);
  }
  // Return cached result if fresh (null means last fetch failed — still return null)
  if (cache.fetchedAt > 0 && Date.now() - cache.fetchedAt < OPEN_ORDERS_CACHE_MS) return cache.openIds;
  if (cache.inFlight) {
    return new Promise((resolve) => { cache.waiters.push(resolve); });
  }
  cache.inFlight = true;
  try {
    const raw = await callBinance({ method: "GET", path: "/fapi/v1/openOrders", apiKey, apiSecret, params: { symbol } });
    const openIds = new Set((Array.isArray(raw) ? raw : []).map((o) => Number(o.orderId)));
    cache.openIds = openIds;
    cache.fetchedAt = Date.now();
    const waiters = cache.waiters.splice(0);
    for (const w of waiters) w(openIds);
    return openIds;
  } catch (err) {
    // Store null so waiters know the fetch failed (null → skip individual order checks).
    // fetchedAt stays 0 so the next call retries immediately.
    cache.openIds = null;
    const waiters = cache.waiters.splice(0);
    for (const w of waiters) w(null);
    throw err;
  } finally {
    cache.inFlight = false;
  }
}

// Global order placement rate limiter.
// Binance USD-M Futures allows 300 orders/10s. With 17 concurrent workers each
// placing 8 TP orders simultaneously, a naive burst would send 136 requests at once.
// Each caller reserves a slot at least ORDER_GAP_MS after the previous one.
// 40ms = 25 orders/s = 250 orders/10s — comfortably under the limit.
// Node.js is single-threaded: the synchronous slot reservation is race-free.
let _nextOrderSlotAt = 0;
const ORDER_GAP_MS = 40;

async function orderRateLimitWait() {
  const now = Date.now();
  const mySlotAt = Math.max(now, _nextOrderSlotAt);
  _nextOrderSlotAt = mySlotAt + ORDER_GAP_MS;
  const waitMs = mySlotAt - now;
  if (waitMs > 0) await sleep(waitMs);
}

// Retry wrapper for single order placements triggered by cycle fills.
// Returns the placed orderId (> 0) on success, 0 on failure after maxAttempts.
// Does NOT throw — caller checks the return value.
async function placeLimitOrderWithRetry(worker, params, label, maxAttempts = 3) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const placed = await placeLimitOrder(worker, params);
      const id = Number(placed && placed.orderId);
      if (id > 0) return id;
      // Binance returned 200 with no orderId — retrying won't change that.
      lastErr = new Error("no orderId in response");
      break;
    } catch (err) {
      lastErr = err;
      const code = err?.payload?.code ? Number(err.payload.code) : undefined;
      // Terminal errors where retrying is pointless.
      if (code === -1015 || code === -2019 || code === -1111) break;
      if (attempt < maxAttempts) await sleep(300 * attempt); // 300 ms, 600 ms
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : "unknown";
  worker.lastError = `${label}: ${msg}`;
  console.error(`[cycle ${worker.sessionId}] ${worker.lastError}`);
  return 0;
}

// After bulk TP placement, fetch open orders and adopt any matching untracked orders.
// Recovers order IDs that Binance accepted but whose HTTP response was dropped mid-flight.
// Returns the number of orders recovered.
async function reconcileWorkerTpOrders(worker, prePlacementKnownIds) {
  try {
    const openOrders = await callBinance({
      method: "GET",
      path: "/fapi/v1/openOrders",
      apiKey: worker.apiKey,
      apiSecret: worker.apiSecret,
      params: { symbol: worker.symbol },
    });
    if (!Array.isArray(openOrders)) return 0;

    const { tpSide } = sidesForDirection(worker.direction);
    let recovered = 0;

    for (const o of openOrders) {
      const orderId = Number(o.orderId);
      if (!(orderId > 0)) continue;
      if (worker.allKnownOrderIds.has(orderId)) continue;  // already tracked
      if (prePlacementKnownIds.has(orderId)) continue;     // predated this placement run

      const oSide = String(o.side || "");
      if (oSide !== tpSide) continue;

      // Hedge mode: match by positionSide. One-Way mode: match by reduceOnly flag.
      if (worker.positionSide === "LONG" || worker.positionSide === "SHORT") {
        if (String(o.positionSide || "") !== worker.positionSide) continue;
      } else {
        const isReduceOnly = o.reduceOnly === true || o.reduceOnly === "true";
        if (!isReduceOnly) continue;
      }

      // Match price within one tick — our TP rows are at exact prices.
      const oPriceNum = Number(o.price);
      const matchesRow = worker.rows.some(
        (row) => Math.abs(Number(row.price) - oPriceNum) <= Number(worker.tickSize)
      );
      if (matchesRow) {
        worker.trackedCycleOrderIds.add(orderId);
        worker.allKnownOrderIds.add(orderId);
        recovered++;
        console.log(`[cycle ${worker.sessionId}] reconciled untracked TP #${orderId} @ ${o.price}`);
      }
    }
    return recovered;
  } catch (err) {
    console.warn(
      `[cycle ${worker.sessionId}] reconciliation failed: ${err instanceof Error ? err.message : "unknown"}`
    );
    return 0;
  }
}

function roundToStep(value, step, mode = "floor") {
  const v = Number(value);
  const s = Number(step);
  if (!(v > 0) || !(s > 0)) return 0;
  const n = v / s;
  const rounded = mode === "round" ? Math.round(n) : Math.floor(n);
  const safe = rounded * s;
  const precision = Math.max(0, (String(step).split(".")[1] || "").length);
  return Number(safe.toFixed(precision));
}

function sidesForDirection(direction) {
  return direction === "LONG" ? { entrySide: "BUY", tpSide: "SELL" } : { entrySide: "SELL", tpSide: "BUY" };
}

function newCycleId() {
  return `cycle_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function placeLimitOrder(worker, { side, quantity, price, reduceOnly }) {
  const params = {
    symbol: worker.symbol,
    side,
    type: "LIMIT",
    quantity: String(quantity),
    price: String(price),
    timeInForce: "GTC",
    positionSide: worker.positionSide,
    reduceOnly: reduceOnly ? "true" : undefined,
  };
  if (worker.positionSide === "LONG" || worker.positionSide === "SHORT") {
    delete params.reduceOnly;
  }
  await orderRateLimitWait();
  try {
    return await callBinance({
      method: "POST",
      path: "/fapi/v1/order",
      apiKey: worker.apiKey,
      apiSecret: worker.apiSecret,
      params,
    });
  } catch (error) {
    const code =
      error &&
      typeof error === "object" &&
      "payload" in error &&
      error.payload &&
      typeof error.payload === "object" &&
      "code" in error.payload
        ? Number(error.payload.code)
        : undefined;
    if (code === -4061) {
      const retryParams = { ...params };
      delete retryParams.positionSide;
      return callBinance({
        method: "POST",
        path: "/fapi/v1/order",
        apiKey: worker.apiKey,
        apiSecret: worker.apiSecret,
        params: retryParams,
      });
    }
    throw error;
  }
}

function streamKey(apiKey, apiSecret) {
  return `${apiKey}::${apiSecret}`;
}

async function createListenKey(apiKey) {
  const data = await callApiKeyOnly({
    method: "POST",
    path: "/fapi/v1/listenKey",
    apiKey,
  });
  const k = data && typeof data === "object" && "listenKey" in data ? String(data.listenKey || "") : "";
  if (!k) throw new Error("listenKey missing");
  return k;
}

async function keepAliveListenKey(apiKey, listenKey) {
  await callApiKeyOnly({
    method: "PUT",
    path: "/fapi/v1/listenKey",
    apiKey,
    params: { listenKey },
  });
}

async function closeListenKey(apiKey, listenKey) {
  await callApiKeyOnly({
    method: "DELETE",
    path: "/fapi/v1/listenKey",
    apiKey,
    params: { listenKey },
  });
}

function dispatchOrderTradeUpdate(stream, payload) {
  const o = payload?.o;
  if (!o) return;

  const orderId = Number(o.i);
  const symbol = String(o.s || "");
  if (!(orderId > 0) || !symbol) return;

  const side = String(o.S || "");
  const executionType = String(o.x || ""); // NEW | TRADE | CANCELED | EXPIRED | AMENDMENT
  const orderStatus = String(o.X || "");   // NEW | PARTIALLY_FILLED | FILLED | CANCELED | EXPIRED
  const price = String(o.p || "0");
  const origQty = String(o.q || "0");
  const executedQty = String(o.z || "0");
  const lastFillQty = Number(o.l || 0);
  const lastFillPrice = Number(o.L || o.ap || 0);
  const tradeId = Number(o.t || 0);

  // Broadcast full order state to SSE clients so the UI can update open-orders
  // and recent fills directly from WebSocket data — no REST call needed.
  broadcastOrderUpdate(stream.key, {
    orderId, symbol, side,
    orderStatus, executionType,
    price, origQty, executedQty,
    lastFillQty, lastFillPrice, tradeId,
  });

  // Only notify cycle-worker listeners about actual trade fills.
  if (executionType !== "TRADE" || !(lastFillQty > 0)) return;
  // Include orderStatus so handlers know whether this is a partial or final fill.
  // PARTIALLY_FILLED: entry stays open; FILLED: entry is fully consumed.
  // positionSide (o.ps) is used in hedge-mode to route fills to the correct worker only.
  const positionSide = String(o.ps || "BOTH");
  const fill = { orderId, symbol, side, qty: lastFillQty, price: lastFillPrice, orderStatus, positionSide };
  for (const cb of stream.listeners.values()) {
    try {
      cb(fill);
    } catch {
      // ignore listener errors
    }
  }
}

async function connectAccountStream(stream) {
  if (stream.connecting || stream.ws) return;
  stream.connecting = true;
  console.log(`${streamTag(stream)} connecting...`);
  try {
    stream.listenKey = await createListenKey(stream.apiKey);
    console.log(`${streamTag(stream)} listenKey created`);
    const wsUrl = `${BINANCE_WS_BASE}/ws/${stream.listenKey}`;
    const ws = new WebSocket(wsUrl);
    stream.ws = ws;
    ws.on("open", () => {
      stream.connected = true;
      stream.lastError = "";
      stream.lastMessageAt = Date.now();
      console.log(`${streamTag(stream)} connected`);
      // Health check: Binance pings every ~3 min; NAT/cloud proxies can silently drop
      // TCP connections after ~5 min of inactivity. If nothing is heard for 5 minutes,
      // force-close so the close handler triggers a fresh reconnect.
      if (stream.healthTimer) clearInterval(stream.healthTimer);
      stream.healthTimer = setInterval(() => {
        if (!stream.ws) { clearInterval(stream.healthTimer); stream.healthTimer = null; return; }
        if (Date.now() - stream.lastMessageAt > 5 * 60 * 1000) {
          console.warn(`${streamTag(stream)} stale (no message >5 min), forcing reconnect`);
          clearInterval(stream.healthTimer);
          stream.healthTimer = null;
          try { stream.ws.close(); } catch { /* ignore */ }
        }
      }, 60_000);
    });
    // ws-level ping frames (Binance sends every ~3 min) keep lastMessageAt fresh
    // so the health check above doesn't misfire during quiet market periods.
    ws.on("ping", () => { stream.lastMessageAt = Date.now(); });
    ws.on("message", (raw) => {
      stream.lastMessageAt = Date.now();
      try {
        const payload = JSON.parse(String(raw));
        if (payload?.e === "ORDER_TRADE_UPDATE") dispatchOrderTradeUpdate(stream, payload);
      } catch {
        // ignore malformed messages
      }
    });
    ws.on("error", (err) => {
      stream.lastError = err instanceof Error ? err.message : "ws error";
      console.error(`${streamTag(stream)} error: ${stream.lastError}`);
    });
    ws.on("close", () => {
      if (stream.healthTimer) { clearInterval(stream.healthTimer); stream.healthTimer = null; }
      stream.ws = null;
      stream.connected = false;
      console.warn(`${streamTag(stream)} closed`);
      if (stream.listeners.size > 0) {
        if (stream.reconnectTimer) clearTimeout(stream.reconnectTimer);
        stream.reconnectTimer = setTimeout(() => {
          console.log(`${streamTag(stream)} reconnecting...`);
          void connectAccountStream(stream);
        }, 1000);
      }
    });
    if (stream.keepAliveTimer) clearInterval(stream.keepAliveTimer);
    stream.keepAliveTimer = setInterval(() => {
      if (!stream.listenKey) return;
      void keepAliveListenKey(stream.apiKey, stream.listenKey).catch((e) => {
        stream.lastError = e instanceof Error ? e.message : "listenKey keepalive failed";
        console.error(`${streamTag(stream)} keepalive error: ${stream.lastError}`);
      });
    }, 30 * 60 * 1000);
  } catch (err) {
    stream.lastError = err instanceof Error ? err.message : "connect failed";
    console.error(`${streamTag(stream)} connect failed: ${stream.lastError}`);
    if (stream.listeners.size > 0) {
      if (stream.reconnectTimer) clearTimeout(stream.reconnectTimer);
      stream.reconnectTimer = setTimeout(() => {
        console.log(`${streamTag(stream)} retrying after connect failure...`);
        void connectAccountStream(stream);
      }, 5000);
    }
  } finally {
    stream.connecting = false;
  }
}

async function getOrCreateAccountStream(apiKey, apiSecret) {
  const key = streamKey(apiKey, apiSecret);
  let stream = accountStreams.get(key);
  if (!stream) {
    stream = {
      key,
      apiKey,
      apiSecret,
      listenKey: "",
      ws: null,
      listeners: new Map(),
      keepAliveTimer: null,
      reconnectTimer: null,
      healthTimer: null,
      connected: false,
      connecting: false,
      lastError: "",
      lastMessageAt: 0,
    };
    accountStreams.set(key, stream);
    console.log(`${streamTag(stream)} stream created`);
  }
  await connectAccountStream(stream);
  return stream;
}

async function releaseAccountStream(apiKey, apiSecret, sessionId) {
  const key = streamKey(apiKey, apiSecret);
  const stream = accountStreams.get(key);
  if (!stream) return;
  stream.listeners.delete(sessionId);
  console.log(`${streamTag(stream)} detached session ${sessionId}`);
  if (stream.listeners.size > 0) return;
  if (stream.keepAliveTimer) clearInterval(stream.keepAliveTimer);
  if (stream.reconnectTimer) clearTimeout(stream.reconnectTimer);
  if (stream.healthTimer) { clearInterval(stream.healthTimer); stream.healthTimer = null; }
  if (stream.ws) {
    try {
      stream.ws.close();
    } catch {
      // ignore
    }
  }
  if (stream.listenKey) {
    try {
      await closeListenKey(stream.apiKey, stream.listenKey);
      console.log(`${streamTag(stream)} listenKey closed`);
    } catch {
      // ignore
    }
  }
  accountStreams.delete(key);
  console.log(`${streamTag(stream)} stream released`);
}

function stopCycleWorker(sessionId) {
  const worker = cycleWorkers.get(sessionId);
  if (!worker) return null;
  if (worker.timer) clearInterval(worker.timer);
  if (worker.pollTimer) clearInterval(worker.pollTimer);
  void releaseAccountStream(worker.apiKey, worker.apiSecret, worker.sessionId);
  cycleWorkers.delete(sessionId);
  return worker;
}

async function cancelOrderBestEffort(worker, orderId) {
  try {
    await callBinance({
      method: "DELETE",
      path: "/fapi/v1/order",
      apiKey: worker.apiKey,
      apiSecret: worker.apiSecret,
      params: { symbol: worker.symbol, orderId },
    });
    return true;
  } catch (error) {
    const code =
      error &&
      typeof error === "object" &&
      "payload" in error &&
      error.payload &&
      typeof error.payload === "object" &&
      "code" in error.payload
        ? Number(error.payload.code)
        : undefined;
    // -2011: unknown order (already filled/canceled); treat as non-fatal.
    if (code === -2011) return false;
    return false;
  }
}

async function postSplitOrdersFromEntryFill(worker, fillQty) {
  const { tpSide } = sidesForDirection(worker.direction);
  // Snapshot known IDs before placement so reconciliation only looks at new orders.
  const prePlacementKnownIds = new Set(worker.allKnownOrderIds);
  let failedCount = 0;

  for (const row of worker.rows) {
    const qty = roundToStep(fillQty * (Number(row.percent) / 100), worker.stepSize, "floor");
    if (!(qty > 0)) continue;

    let tracked = false;
    let lastErr = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const placed = await placeLimitOrder(worker, {
          side: tpSide,
          quantity: qty,
          price: row.price,
          reduceOnly: true,
        });
        const tpId = Number(placed && placed.orderId);
        if (tpId > 0) {
          worker.trackedCycleOrderIds.add(tpId);
          worker.allKnownOrderIds.add(tpId);
          tracked = true;
        }
        // Got a 2xx — don't retry even without orderId; reconcile step handles that case.
        break;
      } catch (err) {
        lastErr = err;
        const code = err?.payload?.code ? Number(err.payload.code) : undefined;
        // Too many open orders or insufficient margin — retrying won't help.
        if (code === -1015 || code === -2019) break;
        if (attempt < 3) await sleep(300 * attempt);
      }
    }

    if (!tracked) {
      failedCount++;
      worker.lastError = lastErr instanceof Error
        ? `TP row ${row.price}: ${lastErr.message}`
        : `TP row ${row.price}: no orderId returned`;
      console.error(`[cycle ${worker.sessionId}] TP row ${row.price} not tracked after retries`);
    }

    await sleep(120);
  }

  // Reconcile: adopt orders that Binance accepted but whose HTTP response was dropped.
  const recovered = await reconcileWorkerTpOrders(worker, prePlacementKnownIds);
  worker.placementGaps += Math.max(0, failedCount - recovered);

  if (worker.placementGaps > 0) {
    console.warn(
      `[cycle ${worker.sessionId}] ${worker.placementGaps} TP row(s) untracked after reconciliation — position partially uncovered`
    );
  }
}

// On restart, scan all open orders for the symbol and adopt any at anchor/row prices
// that aren't already tracked. Fixes the case where the frontend's knownOrderIds is stale
// (e.g., the user was viewing a different symbol when new cycle orders were placed).
// Does NOT use the shared cache — needs fresh data immediately after restart.
async function adoptUnknownOpenOrders(worker) {
  try {
    const openOrders = await callBinance({
      method: "GET",
      path: "/fapi/v1/openOrders",
      apiKey: worker.apiKey,
      apiSecret: worker.apiSecret,
      params: { symbol: worker.symbol },
    });
    if (!Array.isArray(openOrders)) return;

    const { tpSide, entrySide } = sidesForDirection(worker.direction);
    const isHedge = worker.positionSide === "LONG" || worker.positionSide === "SHORT";
    let adopted = 0;

    for (const o of openOrders) {
      const orderId = Number(o.orderId);
      if (!(orderId > 0)) continue;
      if (worker.allKnownOrderIds.has(orderId)) continue;

      const price = Number(o.price);
      const side = String(o.side || "");
      const oPs = String(o.positionSide || "BOTH");

      // In hedge mode: skip orders for the wrong position side
      if (isHedge && oPs !== "BOTH" && oPs !== worker.positionSide) continue;

      const isReduceOnly = o.reduceOnly === true || o.reduceOnly === "true";

      // Adopt re-entry orders: entry side, at anchor price, NOT reduceOnly
      if (side === entrySide && Math.abs(price - Number(worker.anchorPrice)) <= Number(worker.tickSize)) {
        if (!isHedge && isReduceOnly) continue; // one-way re-entries must not be reduceOnly
        worker.trackedCycleOrderIds.add(orderId);
        worker.allKnownOrderIds.add(orderId);
        adopted++;
        console.log(`[cycle ${worker.sessionId}] adopted untracked re-entry #${orderId} @ ${o.price}`);
        continue;
      }

      // Adopt TP orders: TP side, at a row price
      if (side === tpSide) {
        if (!isHedge && !isReduceOnly) continue; // one-way TPs must be reduceOnly
        const matchesRow = worker.rows.some(
          (row) => Math.abs(Number(row.price) - price) <= Number(worker.tickSize)
        );
        if (matchesRow) {
          worker.trackedCycleOrderIds.add(orderId);
          worker.allKnownOrderIds.add(orderId);
          adopted++;
          console.log(`[cycle ${worker.sessionId}] adopted untracked TP #${orderId} @ ${o.price}`);
        }
      }
    }

    if (adopted > 0) {
      console.log(`[cycle ${worker.sessionId}] adopted ${adopted} previously untracked cycle order(s) — stale existingOrderIds on restart`);
    }
  } catch (err) {
    console.warn(`[cycle ${worker.sessionId}] adoptUnknownOpenOrders failed: ${err instanceof Error ? err.message : "unknown"}`);
  }
}

async function bootstrapWorker(worker) {
  const entryOrderId = Array.from(worker.trackedEntryOrderIds)[0];
  if (!(entryOrderId > 0)) return;
  const o = await callBinance({
    method: "GET",
    path: "/fapi/v1/order",
    apiKey: worker.apiKey,
    apiSecret: worker.apiSecret,
    params: { symbol: worker.symbol, orderId: entryOrderId },
  });
  const status = String(o?.status ?? "");
  const executedQty = Number(o?.executedQty ?? 0);
  if (status === "FILLED" && executedQty > 0) {
    if (worker.trackedCycleOrderIds.size > 0) {
      // Restart scenario: TP orders already exist on Binance (pre-populated from
      // existingOrderIds). Placing new TPs would create duplicates. Skip placement;
      // the fallback poll handles any that filled while the proxy was down.
      console.log(`[cycle ${worker.sessionId}] bootstrap: entry FILLED, ${worker.trackedCycleOrderIds.size} existing cycle orders already tracked — skipping TP placement`);
    } else {
      // Fresh start: no existing TPs, place the full grid.
      await postSplitOrdersFromEntryFill(worker, executedQty);
    }
    worker.trackedEntryOrderIds.delete(entryOrderId);
  }
  // OPEN / PARTIALLY_FILLED: keep entry in trackedEntryOrderIds.
  // The WebSocket stream or fallback poll will handle future fill events.
}

async function handleWorkerFill(worker, t) {
  const orderId = Number(t.orderId);
  if (!(orderId > 0)) return;
  const fillQty = Number(t.qty);
  if (!(fillQty > 0)) return;
  const tradePrice = Number(t.price);
  const { entrySide, tpSide } = sidesForDirection(worker.direction);

  if (worker.trackedEntryOrderIds.has(orderId)) {
    if (String(t.side) !== entrySide) return;
    // Track cumulative covered qty so the fallback poll can deduct already-placed TPs.
    // If the stream drops mid-fill, the poll would otherwise re-place TPs for the full
    // executedQty (including qty already covered here) → duplicate / over-sized TP grid.
    const prev = worker.coveredEntryQty.get(orderId) || 0;
    worker.coveredEntryQty.set(orderId, prev + fillQty);
    await postSplitOrdersFromEntryFill(worker, fillQty);
    // Critical: only remove the entry from tracking when it is FULLY filled.
    // A PARTIALLY_FILLED event means the order is still open on Binance — keeping it
    // in trackedEntryOrderIds ensures the next partial fill (same orderId) is handled too.
    if (String(t.orderStatus || "") === "FILLED") {
      worker.trackedEntryOrderIds.delete(orderId);
      worker.coveredEntryQty.delete(orderId);
    }
    return;
  }

  if (!worker.trackedCycleOrderIds.has(orderId)) return;
  const sourcePrice = worker.anchorSourcePriceByOrderId.get(orderId);
  // Classify by fill price: re-entry orders are priced at anchorPrice (fill there),
  // TP orders are priced at row prices (always at least 1 step away from anchor).
  // Previously guarded by sourcePrice !== undefined — this caused an infinite re-entry loop
  // on restart because anchorSourcePriceByOrderId is cleared between proxy sessions.
  const isAnchorFill = Math.abs(tradePrice - Number(worker.anchorPrice)) <= Number(worker.tickSize);

  if (isAnchorFill) {
    // Re-entry filled at anchor → place TP. Use stored sourcePrice for orders we placed;
    // fall back to rows[0] for unclassified orders restored after a proxy restart.
    const tpRowPrice = sourcePrice !== undefined
      ? Number(sourcePrice)
      : Number(worker.rows[0]?.price || worker.anchorPrice);
    const id = await placeLimitOrderWithRetry(worker, {
      side: tpSide,
      quantity: fillQty,
      price: tpRowPrice,
      reduceOnly: true,
    }, `recycled TP (fill #${orderId})`);
    if (id > 0) {
      worker.trackedCycleOrderIds.add(id);
      worker.allKnownOrderIds.add(id);
    } else {
      // Placement failed after retries: this qty chunk has no TP coverage.
      worker.cycleGaps = (worker.cycleGaps || 0) + 1;
    }
    worker.trackedCycleOrderIds.delete(orderId);
    worker.anchorSourcePriceByOrderId.delete(orderId);
  } else {
    const id = await placeLimitOrderWithRetry(worker, {
      side: entrySide,
      quantity: fillQty,
      price: worker.anchorPrice,
      reduceOnly: false,
    }, `re-entry (fill #${orderId})`);
    if (id > 0) {
      worker.trackedCycleOrderIds.add(id);
      worker.anchorSourcePriceByOrderId.set(id, String(tradePrice));
      worker.allKnownOrderIds.add(id);
    } else {
      worker.cycleGaps = (worker.cycleGaps || 0) + 1;
    }
    worker.trackedCycleOrderIds.delete(orderId);
  }
}

async function handleWorkerFillByOrderStatus(worker, orderId, executedQty, orderPrice) {
  if (!(orderId > 0) || !(executedQty > 0)) return;
  const { entrySide, tpSide } = sidesForDirection(worker.direction);

  if (worker.trackedEntryOrderIds.has(orderId)) {
    // Deduct qty already handled by the WebSocket path to avoid duplicate TP placement.
    // Scenario: WebSocket covers partial fill (50 of 100 units) then stream drops;
    // poll sees FILLED with executedQty=100 — only place TPs for the remaining 50.
    const alreadyCovered = worker.coveredEntryQty.get(orderId) || 0;
    const uncoveredQty = executedQty - alreadyCovered;
    if (uncoveredQty > 0) {
      await postSplitOrdersFromEntryFill(worker, uncoveredQty);
    }
    worker.trackedEntryOrderIds.delete(orderId);
    worker.coveredEntryQty.delete(orderId);
    return;
  }

  if (!worker.trackedCycleOrderIds.has(orderId)) return;
  const sourcePrice = worker.anchorSourcePriceByOrderId.get(orderId);
  const isAnchorFill = Math.abs(orderPrice - Number(worker.anchorPrice)) <= Number(worker.tickSize);
  if (isAnchorFill) {
    const tpRowPrice = sourcePrice !== undefined
      ? Number(sourcePrice)
      : Number(worker.rows[0]?.price || worker.anchorPrice);
    const id = await placeLimitOrderWithRetry(worker, {
      side: tpSide,
      quantity: executedQty,
      price: tpRowPrice,
      reduceOnly: true,
    }, `poll recycled TP (fill #${orderId})`);
    if (id > 0) {
      worker.trackedCycleOrderIds.add(id);
      worker.allKnownOrderIds.add(id);
    } else {
      worker.cycleGaps = (worker.cycleGaps || 0) + 1;
    }
    worker.trackedCycleOrderIds.delete(orderId);
    worker.anchorSourcePriceByOrderId.delete(orderId);
  } else {
    const id = await placeLimitOrderWithRetry(worker, {
      side: entrySide,
      quantity: executedQty,
      price: worker.anchorPrice,
      reduceOnly: false,
    }, `poll re-entry (fill #${orderId})`);
    if (id > 0) {
      worker.trackedCycleOrderIds.add(id);
      worker.anchorSourcePriceByOrderId.set(id, String(orderPrice > 0 ? orderPrice : worker.anchorPrice));
      worker.allKnownOrderIds.add(id);
    } else {
      worker.cycleGaps = (worker.cycleGaps || 0) + 1;
    }
    worker.trackedCycleOrderIds.delete(orderId);
  }
}

async function pollWorkerOrderStatus(worker) {
  if (worker.busy) return;
  worker.busy = true;
  try {
    const trackedIds = new Set([
      ...Array.from(worker.trackedEntryOrderIds),
      ...Array.from(worker.trackedCycleOrderIds),
    ].map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0));
    if (trackedIds.size === 0) return;

    // Use shared cache: all workers on the same symbol share one GET /openOrders per
    // cache window. 17 workers × GET(weight=40) = 680/10s would exceed Binance's limit.
    // Returns null if the fetch failed — in that case skip individual order checks to
    // avoid replacing 1 failed bulk call with N individual calls (up to 136 × weight=1).
    const openIds = await fetchOpenOrdersShared(worker.apiKey, worker.apiSecret, worker.symbol);
    if (!openIds) return; // bulk fetch failed; retry on next poll interval

    // Any tracked order absent from the open list was filled or cancelled.
    // Only then fetch its individual status to get executedQty/price.
    for (const id of trackedIds) {
      if (openIds.has(id)) continue;
      try {
        const ord = await callBinance({
          method: "GET",
          path: "/fapi/v1/order",
          apiKey: worker.apiKey,
          apiSecret: worker.apiSecret,
          params: { symbol: worker.symbol, orderId: id },
        });
        const status = String(ord?.status || "");
        // Clean up canceled/expired orders immediately so the poll doesn't waste
        // a GET /order on them every tick for the lifetime of the worker.
        if (status === "CANCELED" || status === "EXPIRED") {
          worker.trackedEntryOrderIds.delete(id);
          worker.trackedCycleOrderIds.delete(id);
          continue;
        }
        if (status !== "FILLED") continue;
        const executedQty = Number(ord?.executedQty || 0);
        const orderPrice = Number(ord?.price || 0);
        await handleWorkerFillByOrderStatus(worker, id, executedQty, orderPrice);
      } catch {
        // ignore a single order status error
      }
    }
  } catch (error) {
    worker.lastError = error instanceof Error ? `fallback poll: ${error.message}` : "fallback poll failed";
  } finally {
    worker.busy = false;
    // Drain any fills that queued while busy=true (WebSocket fills that arrived during the poll).
    if (worker.fillQueue.length > 0) {
      setTimeout(() => void processWorkerQueue(worker), 0);
    }
  }
}

async function processWorkerQueue(worker) {
  if (worker.busy) return;
  worker.busy = true;
  try {
    while (worker.fillQueue.length > 0) {
      const next = worker.fillQueue.shift();
      if (!next) continue;
      if (String(next.symbol || "").toUpperCase() !== worker.symbol) continue;
      // In hedge mode, reject fills for the opposite position side to prevent a LONG TP fill
      // from triggering a SHORT worker's re-entry logic (and vice versa).
      if (worker.positionSide === "LONG" || worker.positionSide === "SHORT") {
        const fillPs = String(next.positionSide || "BOTH");
        if (fillPs !== "BOTH" && fillPs !== worker.positionSide) continue;
      }
      await handleWorkerFill(worker, next);
    }
  } catch (error) {
    worker.lastError = error instanceof Error ? error.message : "cycle worker error";
  } finally {
    worker.busy = false;
    if (worker.fillQueue.length > 0) {
      setTimeout(() => void processWorkerQueue(worker), 50);
    }
  }
}

function startCycleWorker(worker) {
  void (async () => {
    try {
      const stream = await getOrCreateAccountStream(worker.apiKey, worker.apiSecret);
      stream.listeners.set(worker.sessionId, (fill) => {
        worker.fillQueue.push(fill);
        void processWorkerQueue(worker);
      });
      worker.streamKey = stream.key;
      console.log(`[cycle ${worker.sessionId}] attached to stream ${streamTag(stream)}`);
    } catch (error) {
      worker.lastError = error instanceof Error ? error.message : "user stream attach failed";
      console.error(`[cycle ${worker.sessionId}] attach failed: ${worker.lastError}`);
    }
  })();
  worker.pollTimer = setInterval(() => {
    const stream = worker.streamKey ? accountStreams.get(worker.streamKey) : null;
    const streamStale =
      !!stream &&
      stream.connected &&
      Number.isFinite(Number(stream.lastMessageAt)) &&
      Date.now() - Number(stream.lastMessageAt) > 30_000;
    const streamHealthy = !!stream && stream.connected && !streamStale;
    const hasPendingOrders =
      worker.trackedEntryOrderIds.size > 0 || worker.trackedCycleOrderIds.size > 0;
    // Only fall back to REST polling when the WebSocket stream is unavailable or stale.
    if (hasPendingOrders && !streamHealthy) {
      void pollWorkerOrderStatus(worker);
    }
  }, CYCLE_FALLBACK_POLL_MS);
  cycleWorkers.set(worker.sessionId, worker);
}

// ── Server-side broker helpers (shared by routes + auto-transfer worker) ──────

// Fetch all sub-account USD-M futures balances as [{ email, assets }] where
// assets[symbol] = { available, wallet }. `available` = maxWithdrawAmount.
async function fetchBrokerFuturesBalances(brokerKey, brokerSecret) {
  const listData = await callBroker({
    method: "GET", path: "/sapi/v1/sub-account/list",
    apiKey: brokerKey, apiSecret: brokerSecret, params: {},
  });
  const emails = Array.isArray(listData?.subAccounts)
    ? listData.subAccounts.map((a) => String(a.email || "")).filter(Boolean)
    : [];
  return Promise.all(emails.map(async (email) => {
    try {
      const detail = await callBroker({
        method: "GET", path: "/sapi/v2/sub-account/futures/account",
        apiKey: brokerKey, apiSecret: brokerSecret,
        params: { email, futuresType: 1 },
      });
      const rawAssets = Array.isArray(detail?.futureAccountResp?.assets)
        ? detail.futureAccountResp.assets : [];
      const assets = {};
      for (const a of rawAssets) {
        if (!a.asset) continue;
        assets[String(a.asset)] = {
          available: String(a.maxWithdrawAmount ?? "0"),
          wallet:    String(a.walletBalance    ?? "0"),
        };
      }
      return { email, assets, ok: true };
    } catch {
      // Per-account fetch failed — mark ok:false so callers can tell "unknown"
      // apart from a genuine zero balance (never treat a failed fetch as 0).
      return { email, assets: {}, ok: false };
    }
  }));
}

const VALID_WALLET_TYPES = new Set(["SPOT", "UMFUTURE", "CMFUTURE", "MARGIN", "ISOLATED_MARGIN", "FUNDING", "OPTIONS", "MAIN"]);

// Execute a single sub-account transfer. Returns Binance's response, or throws
// an Error with .statusCode / .payload set. Mirrors the /api/broker/transfer route.
async function executeBrokerTransfer({ brokerKey, brokerSecret, fromEmail, toEmail, asset, amount, fromAccountType, toAccountType, futuresType }) {
  const amt = Number(amount);
  if (!(amt > 0)) { const e = new Error("Invalid amount"); e.statusCode = 400; throw e; }
  const ft = Number(futuresType ?? 1);
  const fallbackType = ft === 2 ? "CMFUTURE" : "UMFUTURE";
  const fromT = VALID_WALLET_TYPES.has(String(fromAccountType)) ? String(fromAccountType) : fallbackType;
  const toT   = VALID_WALLET_TYPES.has(String(toAccountType))   ? String(toAccountType)   : fallbackType;
  const fe = fromEmail ? String(fromEmail) : null;
  const te = toEmail   ? String(toEmail)   : null;

  if (fe && te) {
    if (fromT !== toT) {
      const e = new Error(
        `Sub-to-sub cross-wallet transfers are not supported by Binance (${fromT} → ${toT}). ` +
        `Transfer to master first, then from master to the destination sub-account.`);
      e.statusCode = 400; throw e;
    }
    const futuresTypeVal = fromT === "CMFUTURE" ? 2 : 1;
    return callBroker({
      method: "POST", path: "/sapi/v1/sub-account/futures/internalTransfer",
      apiKey: brokerKey, apiSecret: brokerSecret,
      params: { fromEmail: fe, toEmail: te, futuresType: futuresTypeVal, asset, amount: String(amt) },
    });
  }
  const params = { fromAccountType: fromT, toAccountType: toT, asset, amount: String(amt) };
  if (fe) params.fromEmail = fe;
  if (te) params.toEmail   = te;
  return callBroker({
    method: "POST", path: "/sapi/v1/asset/universalTransfer",
    apiKey: brokerKey, apiSecret: brokerSecret, params,
  });
}

// ── Auto-transfer background worker ───────────────────────────────────────────
// Runs the auto-transfer rule loop inside the always-on proxy process so it keeps
// running when the browser page is refreshed or closed. Jobs are keyed by broker
// API key and persisted to disk so a proxy restart resumes them.

const AUTO_JOBS_FILE = join(__dirname, ".auto-transfer-jobs.json");
const autoTransferJobs = new Map(); // brokerKey → job

const isMasterId = (id) => !id || String(id).toLowerCase() === "master";

function makeAutoLog(rule, status, msg) {
  return { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, time: new Date().toLocaleTimeString(), rule, status, msg };
}

// Evaluate every enabled rule once and execute the transfers it calls for.
async function runAutoRulesOnceServer(job) {
  // null → the whole balance fetch failed (list call errored) this cycle.
  const perAccount = await fetchBrokerFuturesBalances(job.brokerKey, job.brokerSecret).catch(() => null);
  const byEmail = new Map((perAccount || []).map((r) => [r.email, r]));
  // Returns:
  //   null → wallet type has no balance data we can read (non-UMFUTURE)
  //   NaN  → balance is UNKNOWN this cycle (fetch failed) — must not be treated as 0
  //   number → the actual available balance (a genuine 0 only when the account fetch succeeded)
  const getAvail = (email, asset, walletType) => {
    if (walletType !== "UMFUTURE") return null;
    if (perAccount === null) return NaN;              // list call failed
    const acct = byEmail.get(email);
    if (!acct || acct.ok === false) return NaN;       // this account's fetch failed / missing
    return Number(acct.assets?.[asset]?.available ?? 0);
  };
  const UNKNOWN_MSG = "Balance unavailable (API error) — skipped, will retry next cycle";

  const out = [];
  for (const rule of (job.rules || []).filter((r) => r.enabled)) {
    const label = rule.label || `${rule.from} → ${rule.to}`;
    let amount = null;
    try {
      if (rule.type === "pull" && rule.pullAbove != null && rule.keepBalance != null && !isMasterId(rule.from)) {
        const avail = getAvail(rule.from, rule.asset, rule.fromWalletType ?? "UMFUTURE");
        if (avail === null) { out.push(makeAutoLog(label, "skip", `Balance check not supported for ${rule.fromWalletType} wallet (use Fixed type instead)`)); continue; }
        if (Number.isNaN(avail)) { out.push(makeAutoLog(label, "skip", UNKNOWN_MSG)); continue; }
        if (avail > rule.pullAbove) {
          amount = avail - rule.keepBalance;
          if (amount <= 0) { out.push(makeAutoLog(label, "skip", "Computed amount ≤ 0")); continue; }
        } else { out.push(makeAutoLog(label, "skip", `${avail.toFixed(2)} ≤ ${rule.pullAbove} (below threshold)`)); continue; }
      } else if (rule.type === "topup" && rule.topUpTo != null && rule.topUpBelow != null) {
        const avail = getAvail(rule.to, rule.asset, rule.toWalletType ?? "UMFUTURE");
        if (avail === null) { out.push(makeAutoLog(label, "skip", `Balance check not supported for ${rule.toWalletType} wallet (use Fixed type instead)`)); continue; }
        if (Number.isNaN(avail)) { out.push(makeAutoLog(label, "skip", UNKNOWN_MSG)); continue; }
        if (avail < rule.topUpBelow) {
          amount = rule.topUpTo - avail;
          if (amount <= 0) { out.push(makeAutoLog(label, "skip", "Computed amount ≤ 0")); continue; }
        } else { out.push(makeAutoLog(label, "skip", `${avail.toFixed(2)} ≥ ${rule.topUpBelow} (above threshold)`)); continue; }
      } else if (rule.type === "fixed" && rule.amount != null && rule.amount > 0) {
        amount = rule.amount;
      } else {
        out.push(makeAutoLog(label, "skip", "Rule not configured")); continue;
      }

      const resp = await executeBrokerTransfer({
        brokerKey: job.brokerKey, brokerSecret: job.brokerSecret,
        fromEmail: !isMasterId(rule.from) ? rule.from : null,
        toEmail:   !isMasterId(rule.to)   ? rule.to   : null,
        asset: rule.asset,
        amount: amount.toFixed(4),
        fromAccountType: rule.fromWalletType,
        toAccountType:   rule.toWalletType,
      });
      const txId = resp?.txnId ?? resp?.tranId ?? "—";
      out.push(makeAutoLog(label, "ok", `Transferred ${amount.toFixed(2)} ${rule.asset} — TxID: ${txId}`));
    } catch (err) {
      out.push(makeAutoLog(label, "error", err?.message ?? "Failed"));
    }
  }
  return out;
}

async function runAutoJobCycle(job) {
  if (job.cycleInFlight) return; // never overlap cycles for the same job
  job.cycleInFlight = true;
  job.lastRunAt = Date.now();
  job.nextRunAt = Date.now() + job.intervalSec * 1000;
  try {
    const entries = await runAutoRulesOnceServer(job);
    if (entries.length) job.log = [...entries, ...job.log].slice(0, 100);
  } catch (err) {
    job.log = [makeAutoLog("auto", "error", err?.message ?? "cycle failed"), ...job.log].slice(0, 100);
  } finally {
    job.cycleInFlight = false;
  }
}

function stopAutoJob(brokerKey) {
  const job = autoTransferJobs.get(brokerKey);
  if (!job) return;
  if (job.timer) clearInterval(job.timer);
  job.timer = null;
  job.running = false;
}

function persistAutoJobs() {
  try {
    const arr = Array.from(autoTransferJobs.values())
      .filter((j) => j.running)
      .map((j) => ({ brokerKey: j.brokerKey, brokerSecret: j.brokerSecret, rules: j.rules, intervalSec: j.intervalSec }));
    fs.writeFileSync(AUTO_JOBS_FILE, JSON.stringify(arr, null, 2), "utf8");
  } catch (err) {
    console.error(`[auto] failed to persist jobs: ${err.message}`);
  }
}

// Start (or restart) a job. Fires one cycle immediately when `immediate` is set,
// then repeats on the interval. Starts each run with a fresh activity log.
function startAutoJob({ brokerKey, brokerSecret, rules, intervalSec, immediate = true }) {
  stopAutoJob(brokerKey);
  const sec = Math.max(10, Number(intervalSec) || 60);
  const job = {
    brokerKey, brokerSecret,
    rules: Array.isArray(rules) ? rules : [],
    intervalSec: sec,
    running: true,
    timer: null,
    log: [], // fresh log on each explicit start; use /auto/clear-log to clear while running
    lastRunAt: null,
    nextRunAt: null,
    cycleInFlight: false,
  };
  autoTransferJobs.set(brokerKey, job);
  if (immediate) void runAutoJobCycle(job);
  job.timer = setInterval(() => void runAutoJobCycle(job), sec * 1000);
  persistAutoJobs();
  return job;
}

function loadAutoJobs() {
  let arr;
  try { arr = JSON.parse(fs.readFileSync(AUTO_JOBS_FILE, "utf8")); } catch { return; }
  if (!Array.isArray(arr)) return;
  let resumed = 0;
  for (const j of arr) {
    if (j?.brokerKey && j?.brokerSecret) {
      // Resume without firing immediately — avoids a burst of transfers on restart.
      startAutoJob({ brokerKey: j.brokerKey, brokerSecret: j.brokerSecret, rules: j.rules, intervalSec: j.intervalSec, immediate: false });
      resumed++;
    }
  }
  if (resumed) console.log(`[auto] resumed ${resumed} auto-transfer job(s) from disk`);
}

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
  : [];

const server = http.createServer(async (req, res) => {
  const origin = req.headers["origin"] || "";
  if (origin && (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  try {
    if (!req.url) return sendJson(res, 400, { error: "Missing URL" });
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/binance/public") {
      const path = url.searchParams.get("path") || "";
      if (!ALLOWED_PUBLIC_PATHS.has(path)) {
        return sendJson(res, 400, { error: "Unsupported public path" });
      }
      const params = {};
      for (const [k, v] of url.searchParams.entries()) {
        if (k === "path") continue;
        params[k] = v;
      }
      const data = await callPublic(path, params);
      return sendJson(res, 200, data);
    }

    if (req.method === "POST" && url.pathname === "/api/binance/signed") {
      const body = await collectJson(req);
      const method = String(body.method || "GET").toUpperCase();
      const rawPath = String(body.path || "");
      const path = rawPath.trim().replace(/\/+$/, "");
      const apiKey = String(body.apiKey || "");
      const apiSecret = String(body.apiSecret || "");
      const params = body.params && typeof body.params === "object" ? { ...body.params } : {};

      if (!["GET", "POST", "DELETE"].includes(method)) {
        return sendJson(res, 400, { error: "Invalid method" });
      }
      if (!path) {
        return sendJson(res, 400, { error: "Missing path" });
      }
      if (!ALLOWED_SIGNED_PATHS.has(path)) {
        return sendJson(res, 400, {
          error: "Unsupported signed path",
          path,
          hint: "Restart the proxy after upgrading (npm run dev:api). Allowed paths match this server version.",
        });
      }
      if (!apiKey || !apiSecret) {
        return sendJson(res, 400, { error: "Missing API credentials" });
      }

      // Safety normalization: Binance rejects reduceOnly in Hedge Mode orders
      // (positionSide LONG/SHORT). Ignore it at the proxy to avoid client mismatch/caching issues.
      if (path === "/fapi/v1/order") {
        const ps = typeof params.positionSide === "string" ? params.positionSide.toUpperCase() : "";
        if (ps === "LONG" || ps === "SHORT") {
          delete params.reduceOnly;
        }
      }

      try {
        const data = await callBinance({ method, path, apiKey, apiSecret, params });
        return sendJson(res, 200, data);
      } catch (error) {
        // If account is in One-way mode but client sent Hedge positionSide,
        // auto-retry once without positionSide/reduceOnly to match One-way format.
        const code =
          error &&
          typeof error === "object" &&
          "payload" in error &&
          error.payload &&
          typeof error.payload === "object" &&
          "code" in error.payload
            ? Number(error.payload.code)
            : undefined;
        // One-way account rejected positionSide — retry without it only.
        // Keep reduceOnly: stripping it turns reduce-only step limits into opening orders and can
        // invalidate or auto-cancel other working limits on the same symbol.
        if (path === "/fapi/v1/order" && code === -4061) {
          const retryParams = { ...params };
          delete retryParams.positionSide;
          const retried = await callBinance({
            method,
            path,
            apiKey,
            apiSecret,
            params: retryParams,
          });
          return sendJson(res, 200, retried);
        }
        throw error;
      }
    }

    if (req.method === "POST" && url.pathname === "/api/binance/cycle/start") {
      const body = await collectJson(req);
      const apiKey = String(body.apiKey || "");
      const apiSecret = String(body.apiSecret || "");
      const symbol = String(body.symbol || "").trim().toUpperCase();
      const direction = String(body.direction || "").toUpperCase();
      const anchorPrice = Number(body.anchorPrice);
      const stepSize = Number(body.stepSize);
      const tickSize = Number(body.tickSize);
      const entryOrderId = Number(body.entryOrderId);
      const positionSideRaw = typeof body.positionSide === "string" ? String(body.positionSide).toUpperCase() : "";
      const positionSide =
        positionSideRaw === "LONG" || positionSideRaw === "SHORT" || positionSideRaw === "BOTH"
          ? positionSideRaw
          : undefined;
      const rows = Array.isArray(body.rows)
        ? body.rows
            .map((r) => ({ price: Number(r?.price), percent: Number(r?.percent) }))
            .filter((r) => r.price > 0 && r.percent > 0)
        : [];
      // existingOrderIds: provided on restart so the backend knows which orders were
      // previously tracked. Prevents bootstrap from placing duplicate TP orders.
      const existingOrderIds = Array.isArray(body.existingOrderIds)
        ? body.existingOrderIds.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0)
        : [];

      if (!apiKey || !apiSecret) return sendJson(res, 400, { error: "Missing API credentials" });
      if (!symbol) return sendJson(res, 400, { error: "Missing symbol" });
      if (direction !== "LONG" && direction !== "SHORT") {
        return sendJson(res, 400, { error: "Invalid direction" });
      }
      if (!(anchorPrice > 0) || !(stepSize > 0) || !(tickSize > 0) || !(entryOrderId > 0)) {
        return sendJson(res, 400, { error: "Invalid numeric inputs" });
      }
      if (rows.length === 0) return sendJson(res, 400, { error: "Missing rows" });

      // existingOrderIds from the frontend includes the entry order + all TP orders that
      // were tracked at the time of the proxy crash. Cycle IDs are those other than entryOrderId.
      const cycleOrderIds = existingOrderIds.filter((id) => id !== entryOrderId);
      const isRestart = cycleOrderIds.length > 0;

      const sessionId = typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId : newCycleId();
      stopCycleWorker(sessionId);
      const worker = {
        sessionId,
        apiKey,
        apiSecret,
        symbol,
        direction,
        anchorPrice,
        positionSide,
        stepSize,
        tickSize,
        rows,
        // Always track the entry order so partially-filled entries are handled even on restart.
        // bootstrapWorker will skip TP placement when cycle orders already exist.
        trackedEntryOrderIds: new Set([entryOrderId]),
        // Pre-populate with previously-known cycle order IDs on restart.
        // The fallback poll will detect any that filled while the proxy was down.
        trackedCycleOrderIds: new Set(cycleOrderIds),
        anchorSourcePriceByOrderId: new Map(),
        // Tracks how much fill qty has already been handled for each entry order via WebSocket.
        // Prevents the fallback poll from placing duplicate TPs when the stream dropped mid-fill.
        coveredEntryQty: new Map(),
        allKnownOrderIds: new Set([entryOrderId, ...existingOrderIds]),
        fillQueue: [],
        streamKey: "",
        timer: null,
        pollTimer: null,
        busy: false,
        lastTradeId: 0,
        lastError: "",
        placementGaps: 0,
        cycleGaps: 0,
      };
      try {
        await bootstrapWorker(worker);
      } catch (error) {
        worker.lastError = error instanceof Error ? `bootstrap: ${error.message}` : "bootstrap failed";
      }
      // On restart: adopt open orders at anchor/row prices that weren't in existingOrderIds.
      // Fixes stale knownOrderIds when the frontend was viewing a different symbol and missed
      // orders placed by the backend during that time.
      if (isRestart) {
        await adoptUnknownOpenOrders(worker);
      }
      startCycleWorker(worker);
      // On restart, poll for fills that occurred while the proxy was down.
      // Add random jitter (0–3 s) to prevent 17 simultaneous restarts from all polling at t+500ms
      // and hitting Binance's rate limit at once. Combined with the shared openOrdersCache, at most
      // 1 GET /openOrders goes out per apiKey::symbol per cache window.
      if (isRestart && worker.trackedCycleOrderIds.size > 0) {
        const jitter = Math.floor(Math.random() * 3000);
        setTimeout(() => void pollWorkerOrderStatus(worker), 500 + jitter);
      }
      return sendJson(res, 200, { ok: true, sessionId });
    }

    if (req.method === "POST" && url.pathname === "/api/binance/cycle/stop") {
      const body = await collectJson(req);
      const sessionId = String(body.sessionId || "").trim();
      const cancelOrders = body.cancelOrders === true;
      const fallbackApiKey = String(body.apiKey || "");
      const fallbackApiSecret = String(body.apiSecret || "");
      const fallbackSymbol = String(body.symbol || "").trim().toUpperCase();
      const fallbackOrderIds = Array.isArray(body.knownOrderIds)
        ? body.knownOrderIds.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0)
        : [];
      if (!sessionId) return sendJson(res, 400, { error: "Missing sessionId" });
      const worker = stopCycleWorker(sessionId);
      let cancelRequested = 0;
      let cancelDone = 0;
      if (!worker) {
        if (cancelOrders && fallbackApiKey && fallbackApiSecret && fallbackSymbol && fallbackOrderIds.length > 0) {
          const shadowWorker = {
            apiKey: fallbackApiKey,
            apiSecret: fallbackApiSecret,
            symbol: fallbackSymbol,
          };
          cancelRequested = fallbackOrderIds.length;
          for (const id of fallbackOrderIds) {
            const done = await cancelOrderBestEffort(shadowWorker, id);
            if (done) cancelDone += 1;
          }
        }
        return sendJson(res, 200, { ok: true, stopped: false, cancelRequested, cancelDone });
      }
      if (cancelOrders) {
        const ids = Array.from(worker.allKnownOrderIds)
          .map((x) => Number(x))
          .filter((x) => Number.isFinite(x) && x > 0);
        cancelRequested = ids.length;
        for (const id of ids) {
          const done = await cancelOrderBestEffort(worker, id);
          if (done) cancelDone += 1;
        }
      }
      return sendJson(res, 200, { ok: true, stopped: true, cancelRequested, cancelDone });
    }

    if (req.method === "GET" && url.pathname === "/api/binance/events") {
      const symbol = String(url.searchParams.get("symbol") || "").trim().toUpperCase();
      const apiKey = String(url.searchParams.get("apiKey") || "");
      const apiSecret = String(url.searchParams.get("apiSecret") || "");
      if (!symbol) return sendJson(res, 400, { error: "Missing symbol" });

      const clientId = `sse_${++_sseClientId}`;
      const skey = apiKey && apiSecret ? streamKey(apiKey, apiSecret) : null;

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(": connected\n\n");

      sseClients.set(clientId, { res, symbol, streamKey: skey });

      // Subscribe to mark price WebSocket for this symbol
      const mps = getOrCreateMarkPriceStream(symbol);
      mps.clientIds.add(clientId);
      if (mps.lastPrice) {
        sseWrite(res, "markPrice", { symbol, price: mps.lastPrice });
      }

      // Attach to user data stream so order fills are forwarded
      if (apiKey && apiSecret) {
        void getOrCreateAccountStream(apiKey, apiSecret).catch(() => {});
      }

      const pingTimer = setInterval(() => {
        try { res.write(": ping\n\n"); } catch { clearInterval(pingTimer); }
      }, 25_000);

      req.on("close", () => {
        clearInterval(pingTimer);
        sseClients.delete(clientId);
        releaseMarkPriceStream(symbol, clientId);
        console.log(`[sse ${clientId}] disconnected`);
      });

      return;
    }

    if (req.method === "GET" && url.pathname === "/api/binance/cycle/status") {
      const sessionId = String(url.searchParams.get("sessionId") || "").trim();
      if (!sessionId) return sendJson(res, 400, { error: "Missing sessionId" });
      const worker = cycleWorkers.get(sessionId);
      if (!worker) return sendJson(res, 404, { error: "Not found" });
      const stream = worker.streamKey ? accountStreams.get(worker.streamKey) : null;
      return sendJson(res, 200, {
        ok: true,
        sessionId,
        symbol: worker.symbol,
        direction: worker.direction,
        trackedEntryCount: worker.trackedEntryOrderIds.size,
        trackedCycleCount: worker.trackedCycleOrderIds.size,
        knownOrderIds: Array.from(worker.allKnownOrderIds || []),
        lastTradeId: worker.lastTradeId,
        streamConnected: !!stream?.connected,
        streamError: stream?.lastError || null,
        lastError: worker.lastError || null,
        placementGaps: worker.placementGaps || 0,
        cycleGaps: worker.cycleGaps || 0,
      });
    }

    // Flush the shared open-orders cache on demand (no restart needed).
    // Useful after deploying new backend code or when the cache seems stale.
    if (req.method === "POST" && url.pathname === "/api/binance/admin/flush-cache") {
      const cleared = openOrdersCache.size;
      openOrdersCache.clear();
      return sendJson(res, 200, { ok: true, clearedEntries: cleared });
    }

    // ── Sub-account API routes ────────────────────────────────────────────────
    // Uses standard master-account sub-account endpoints (no Exchange Link required).
    // Required permissions: "Enable Reading" + "Allow Universal Transfer".

    // List all sub-accounts
    if (req.method === "POST" && url.pathname === "/api/broker/accounts") {
      const body = await collectJson(req);
      const brokerKey = String(body.brokerKey || "");
      const brokerSecret = String(body.brokerSecret || "");
      if (!brokerKey || !brokerSecret) return sendJson(res, 400, { error: "Missing broker credentials" });
      try {
        const data = await callBroker({ method: "GET", path: "/sapi/v1/sub-account/list", apiKey: brokerKey, apiSecret: brokerSecret, params: {} });
        const raw = Array.isArray(data?.subAccounts) ? data.subAccounts : [];
        const accounts = raw.map((a) => ({ email: String(a.email || "") })).filter((a) => a.email);
        return sendJson(res, 200, { accounts });
      } catch (err) {
        return sendJson(res, err.statusCode || 500, { error: err.message, code: err.payload?.code });
      }
    }

    // Get all sub-account USDT-M futures balances, broken down per asset.
    // Uses /sapi/v2/sub-account/futures/account per sub-account (parallel) so we get
    // maxWithdrawAmount per asset (USDT, USDC, BNB …), which is the only accurate number
    // for "how much of this coin can actually be transferred out right now".
    if (req.method === "POST" && url.pathname === "/api/broker/balances") {
      const body = await collectJson(req);
      const brokerKey = String(body.brokerKey || "");
      const brokerSecret = String(body.brokerSecret || "");
      if (!brokerKey || !brokerSecret) return sendJson(res, 400, { error: "Missing broker credentials" });
      try {
        const perAccount = await fetchBrokerFuturesBalances(brokerKey, brokerSecret);
        return sendJson(res, 200, { futuresSummary: perAccount });
      } catch (err) {
        return sendJson(res, err.statusCode || 500, { error: err.message, code: err.payload?.code });
      }
    }

    // Execute a sub-account transfer.
    // Sub→Sub (same futures wallet): /sapi/v1/sub-account/futures/internalTransfer
    // Master↔Sub (any wallet type):  /sapi/v1/asset/universalTransfer
    // Binance's universalTransfer does NOT support both fromEmail+toEmail simultaneously
    // on regular (non-broker) accounts — it returns 404.
    if (req.method === "POST" && url.pathname === "/api/broker/transfer") {
      const body = await collectJson(req);
      const brokerKey = String(body.brokerKey || "");
      const brokerSecret = String(body.brokerSecret || "");
      if (!brokerKey || !brokerSecret) return sendJson(res, 400, { error: "Missing broker credentials" });
      const amount = Number(body.amount);
      if (!(amount > 0)) return sendJson(res, 400, { error: "Invalid amount" });
      const asset = String(body.asset || "USDT");

      try {
        const data = await executeBrokerTransfer({
          brokerKey, brokerSecret,
          fromEmail: body.fromEmail ? String(body.fromEmail) : null,
          toEmail:   body.toEmail   ? String(body.toEmail)   : null,
          asset, amount,
          fromAccountType: body.fromAccountType,
          toAccountType:   body.toAccountType,
          futuresType:     body.futuresType,
        });
        return sendJson(res, 200, data);
      } catch (err) {
        return sendJson(res, err.statusCode || 500, { error: err.message, code: err.payload?.code });
      }
    }

    // ── Auto-transfer background worker routes ────────────────────────────────
    // The rule loop runs inside this always-on proxy process (keyed by broker key),
    // so it keeps executing when the browser page is refreshed or closed.

    // Start / restart a job with the given rules + interval. Fires one cycle now.
    if (req.method === "POST" && url.pathname === "/api/broker/auto/start") {
      const body = await collectJson(req);
      const brokerKey = String(body.brokerKey || "");
      const brokerSecret = String(body.brokerSecret || "");
      if (!brokerKey || !brokerSecret) return sendJson(res, 400, { error: "Missing broker credentials" });
      const rules = Array.isArray(body.rules) ? body.rules : [];
      const job = startAutoJob({ brokerKey, brokerSecret, rules, intervalSec: body.intervalSec });
      return sendJson(res, 200, {
        ok: true, running: true, intervalSec: job.intervalSec,
        rules: job.rules, log: job.log, lastRunAt: job.lastRunAt, nextRunAt: job.nextRunAt,
      });
    }

    // Update a running job's rules / interval without firing an immediate cycle.
    if (req.method === "POST" && url.pathname === "/api/broker/auto/update") {
      const body = await collectJson(req);
      const brokerKey = String(body.brokerKey || "");
      if (!brokerKey) return sendJson(res, 400, { error: "Missing broker credentials" });
      const job = autoTransferJobs.get(brokerKey);
      if (!job || !job.running) return sendJson(res, 404, { error: "No running job" });
      if (Array.isArray(body.rules)) job.rules = body.rules;
      if (body.intervalSec != null) {
        const sec = Math.max(10, Number(body.intervalSec) || 60);
        if (sec !== job.intervalSec) {
          job.intervalSec = sec;
          if (job.timer) clearInterval(job.timer);
          job.timer = setInterval(() => void runAutoJobCycle(job), sec * 1000);
        }
      }
      persistAutoJobs();
      return sendJson(res, 200, { ok: true, running: true, intervalSec: job.intervalSec });
    }

    // Stop a running job. Pass `purge: true` (used by Factory Reset) to also drop the
    // job and its activity log from memory so nothing reappears on reconnect.
    if (req.method === "POST" && url.pathname === "/api/broker/auto/stop") {
      const body = await collectJson(req);
      const brokerKey = String(body.brokerKey || "");
      if (!brokerKey) return sendJson(res, 400, { error: "Missing broker credentials" });
      stopAutoJob(brokerKey);
      if (body.purge) autoTransferJobs.delete(brokerKey);
      persistAutoJobs();
      const job = autoTransferJobs.get(brokerKey);
      return sendJson(res, 200, { ok: true, running: false, log: job?.log ?? [] });
    }

    // Poll job status — used by the page to hydrate state after a refresh and to
    // stream the activity log while running.
    if (req.method === "POST" && url.pathname === "/api/broker/auto/status") {
      const body = await collectJson(req);
      const brokerKey = String(body.brokerKey || "");
      if (!brokerKey) return sendJson(res, 400, { error: "Missing broker credentials" });
      const job = autoTransferJobs.get(brokerKey);
      if (!job) return sendJson(res, 200, { ok: true, running: false, rules: [], log: [], intervalSec: null });
      return sendJson(res, 200, {
        ok: true, running: !!job.running, intervalSec: job.intervalSec,
        rules: job.rules, log: job.log, lastRunAt: job.lastRunAt, nextRunAt: job.nextRunAt,
      });
    }

    // Clear the activity log for a job (running or stopped) so old history stops
    // reappearing when the page polls status.
    if (req.method === "POST" && url.pathname === "/api/broker/auto/clear-log") {
      const body = await collectJson(req);
      const brokerKey = String(body.brokerKey || "");
      if (!brokerKey) return sendJson(res, 400, { error: "Missing broker credentials" });
      const job = autoTransferJobs.get(brokerKey);
      if (job) job.log = [];
      return sendJson(res, 200, { ok: true, log: [] });
    }

    // ── Admin: htpasswd user management ─────────────────────────────────────
    // Token is auto-generated on startup. Frontend fetches it via /api/admin/my-token.

    // Returns the admin token — the site's htpasswd login already acts as the auth gate here.
    if (req.method === "GET" && url.pathname === "/api/admin/my-token") {
      return sendJson(res, 200, { token: ADMIN_TOKEN });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/list-users") {
      const body = await collectJson(req);
      if (!checkAdminToken(body)) return sendJson(res, 403, { error: "Unauthorized" });
      if (!fs.existsSync(HTPASSWD_FILE)) {
        return sendJson(res, 200, { users: [], warning: `htpasswd file not found at ${HTPASSWD_FILE} (Windows / no nginx?)` });
      }
      return sendJson(res, 200, { users: readHtpasswd().map(e => e.username) });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/set-password") {
      const body = await collectJson(req);
      if (!checkAdminToken(body)) return sendJson(res, 403, { error: "Unauthorized" });
      const username = String(body.username || "").trim();
      const password = String(body.password || "");
      if (!username) return sendJson(res, 400, { error: "Missing username" });
      if (password.length < 4) return sendJson(res, 400, { error: "Password must be at least 4 characters" });
      if (!fs.existsSync(HTPASSWD_FILE) && !body.createFile) {
        return sendJson(res, 400, { error: `htpasswd file not found at ${HTPASSWD_FILE}. On Windows, htpasswd is managed by your web server.` });
      }
      try {
        htpasswdSet(username, password);
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/admin/delete-user") {
      const body = await collectJson(req);
      if (!checkAdminToken(body)) return sendJson(res, 403, { error: "Unauthorized" });
      const username = String(body.username || "").trim();
      if (!username) return sendJson(res, 400, { error: "Missing username" });
      try {
        htpasswdDelete(username);
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    return sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    const statusCode = Number(error.statusCode || 500);
    return sendJson(res, statusCode, {
      error: error.message || "Proxy error",
      details: error.payload || undefined,
    });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Binance proxy listening on http://0.0.0.0:${PORT}`);
  loadAutoJobs();
});
