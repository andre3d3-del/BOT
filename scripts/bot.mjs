#!/usr/bin/env node
/**
 * Binance Futures Bot — Unified Manager (fully standalone)
 *
 * Runs the full DCA grid cycle without needing the proxy backend:
 *   Entry LIMIT fills → places TPs → each TP fills → re-entry at anchor
 *   → re-entry fills → recycles that TP → repeats forever
 *
 * Usage:  node scripts/bot.mjs   OR   npm run bot
 */

import { createHmac }                              from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname }                        from "node:path";
import { fileURLToPath }                           from "node:url";

const __dir    = dirname(fileURLToPath(import.meta.url));
const CFG_PATH = resolve(__dir, "config.json");

// ═══════════════════════════════════════════════════════════════════════════════
// ANSI + output
// ═══════════════════════════════════════════════════════════════════════════════
const R   = "\x1b[0m";
const w   = s  => process.stdout.write(String(s));
const wl  = (s = "") => process.stdout.write(String(s) + "\n");
const clr = () => w("\x1b[2J\x1b[H");
const CL  = "\x1b[2K\r";

const bold   = s => `\x1b[1m${s}${R}`;
const dim    = s => `\x1b[2m${s}${R}`;
const green  = s => `\x1b[32m${s}${R}`;
const red    = s => `\x1b[31m${s}${R}`;
const yellow = s => `\x1b[33m${s}${R}`;
const cyan   = s => `\x1b[36m${s}${R}`;
const white  = s => `\x1b[37m${s}${R}`;
const stripA = s => String(s).replace(/\x1b\[[^m]*m/g, "");

// ═══════════════════════════════════════════════════════════════════════════════
// Raw mode
// ═══════════════════════════════════════════════════════════════════════════════
let rawOn = false;
function enterRaw() {
  if (!process.stdin.isTTY || rawOn) return;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  w("\x1b[?25l");
  rawOn = true;
}
function exitRaw() {
  if (!rawOn) return;
  try { process.stdin.setRawMode(false); } catch {}
  process.stdin.pause();
  w("\x1b[?25h");
  rawOn = false;
}
process.on("SIGINT", () => { exitRaw(); process.exit(0); });
process.on("exit",   exitRaw);

// ═══════════════════════════════════════════════════════════════════════════════
// TUI primitives
// ═══════════════════════════════════════════════════════════════════════════════

async function fullMenu(items, initial = 0, headerFn = null) {
  const sel = items.filter(x => x !== "─");
  let idx   = Math.max(0, Math.min(initial, sel.length - 1));
  const draw = () => {
    clr();
    if (headerFn) headerFn();
    for (const item of items) {
      if (item === "─") wl(dim("  ─────────────────────────────────────────────"));
      else { const a = sel[idx] === item; wl(a ? `  ${cyan("▶")} ${bold(item)}` : `  ${dim("  " + item)}`); }
    }
    wl(); w(dim("  ↑↓ navigate   Enter select   Ctrl+C quit"));
  };
  return new Promise(res => {
    draw();
    const onKey = k => {
      if (k === "\x03") { exitRaw(); process.exit(0); }
      if      (k === "\x1b[A") { idx = (idx - 1 + sel.length) % sel.length; draw(); }
      else if (k === "\x1b[B") { idx = (idx + 1) % sel.length; draw(); }
      else if (k === "\r")  { process.stdin.removeListener("data", onKey); res({ index: idx, label: sel[idx] }); }
    };
    process.stdin.on("data", onKey);
  });
}

async function inlineMenu(items, initial = 0) {
  const sel = items.filter(x => x !== "─");
  let idx   = Math.max(0, Math.min(initial, sel.length - 1));
  const lines = items.length;
  const draw  = first => {
    if (!first) w(`\x1b[${lines}A`);
    for (const item of items) {
      w(CL);
      if (item === "─") wl(dim("  ─────────────────────────────────────────────"));
      else { const a = sel[idx] === item; wl(a ? `  ${cyan("▶")} ${bold(item)}` : `  ${dim("  " + item)}`); }
    }
  };
  return new Promise(res => {
    draw(true);
    const onKey = k => {
      if (k === "\x03") { exitRaw(); process.exit(0); }
      if      (k === "\x1b[A") { idx = (idx - 1 + sel.length) % sel.length; draw(false); }
      else if (k === "\x1b[B") { idx = (idx + 1) % sel.length; draw(false); }
      else if (k === "\r") { process.stdin.removeListener("data", onKey); wl(); res({ index: idx, label: sel[idx] }); }
    };
    process.stdin.on("data", onKey);
  });
}

async function textInput(prompt, def = "") {
  let buf = "", defShowing = !!def;
  w(`  ${bold(prompt)}: `); if (def) w(dim(def));
  return new Promise(res => {
    const onKey = k => {
      if (k === "\x03") { exitRaw(); process.exit(0); }
      if (k === "\r") { process.stdin.removeListener("data", onKey); wl(); res(buf || def); return; }
      if (k === "\x7f") { if (buf.length > 0) { buf = buf.slice(0, -1); w("\b \b"); } return; }
      if (k.charCodeAt(0) >= 32 && k.charCodeAt(0) < 127) {
        if (defShowing) { w(CL); w(`  ${bold(prompt)}: `); defShowing = false; }
        buf += k; w(k);
      }
    };
    process.stdin.on("data", onKey);
  });
}

async function secretInput(prompt, def = "") {
  let buf = "";
  const masked = def ? "****" + def.slice(-4) : "";
  w(`  ${bold(prompt)}: `); if (masked) w(dim(masked));
  return new Promise(res => {
    const onKey = k => {
      if (k === "\x03") { exitRaw(); process.exit(0); }
      if (k === "\r") { process.stdin.removeListener("data", onKey); wl(); res(buf || def); return; }
      if (k === "\x7f") { if (buf.length > 0) { buf = buf.slice(0, -1); w("\b \b"); } return; }
      if (k.charCodeAt(0) >= 32 && k.charCodeAt(0) < 127) {
        if (masked && buf.length === 0) { w(CL); w(`  ${bold(prompt)}: `); }
        buf += k; w("*");
      }
    };
    process.stdin.on("data", onKey);
  });
}

async function yesNo(prompt) {
  wl(); w(`  ${bold(prompt)} ${dim("(y/n)")}: `);
  return new Promise(res => {
    const onKey = k => {
      if (k === "\x03") { exitRaw(); process.exit(0); }
      process.stdin.removeListener("data", onKey); wl(k); res(k === "y" || k === "Y");
    };
    process.stdin.once("data", onKey);
  });
}

async function anyKey(msg = "Press any key to return...") {
  wl(); w(dim(`  ${msg}`));
  return new Promise(res => {
    const onKey = k => {
      if (k === "\x03") { exitRaw(); process.exit(0); }
      process.stdin.removeListener("data", onKey); wl(); res();
    };
    process.stdin.once("data", onKey);
  });
}

// Wait for keypress OR timeout (returns key string or null on timeout)
async function waitKey(ms) {
  return new Promise(res => {
    let timer = setTimeout(() => { process.stdin.removeListener("data", onKey); res(null); }, ms);
    const onKey = k => {
      clearTimeout(timer);
      process.stdin.removeListener("data", onKey);
      if (k === "\x03") { exitRaw(); process.exit(0); }
      res(k);
    };
    process.stdin.on("data", onKey);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Drawing helpers
// ═══════════════════════════════════════════════════════════════════════════════
function drawBox(title, width = 52) {
  const inner = width - 2, pad = inner - stripA(title).length;
  wl(`  ${cyan("╔" + "═".repeat(inner) + "╗")}`);
  wl(`  ${cyan("║")}${" ".repeat(Math.floor(pad / 2))}${bold(title)}${" ".repeat(Math.ceil(pad / 2))}${cyan("║")}`);
  wl(`  ${cyan("╚" + "═".repeat(inner) + "╝")}`);
}

function drawTable(headers, rows, colWidths) {
  const ln = (l, c, r) => "  " + l + colWidths.map(n => "─".repeat(n + 2)).join(c) + r;
  const row = cells => "  │" + cells.map((c, i) => ` ${String(c).padEnd(colWidths[i])} `).join("│") + "│";
  wl(ln("┌", "┬", "┐")); wl(row(headers)); wl(ln("├", "┼", "┤"));
  for (const r of rows) wl(row(r));
  wl(ln("└", "┴", "┘"));
}

function drawGrid(cols, rows, title) {
  const widths = cols.map((c, ci) => Math.max(stripA(String(c)).length, ...rows.map(r => stripA(String(r[ci] ?? "")).length)) + 2);
  const hline  = (l, m, r) => `  ${l}${widths.map(n => "─".repeat(n)).join(m)}${r}`;
  const rowStr = cells => `  │${cells.map((v, ci) => { const s = String(v ?? ""), p = widths[ci] - stripA(s).length - 1; return ` ${s}${" ".repeat(Math.max(0, p))}│`; }).join("")}`;
  const total  = widths.reduce((a, b) => a + b, 0) + widths.length - 1;
  const lines  = [];
  if (title) { const t = ` ${title} `, pad = Math.max(0, total - stripA(t).length); lines.push(`  ┌${"─".repeat(Math.floor(pad / 2))}${t}${"─".repeat(Math.ceil(pad / 2))}${"─".repeat(widths.length - 1)}┐`); }
  else lines.push(hline("┌", "┬", "┐"));
  lines.push(rowStr(cols.map(c => bold(String(c)))));
  lines.push(hline("├", "┼", "┤"));
  if (!rows.length) lines.push(`  │${" ".repeat(total)}│`);
  else rows.forEach((r, i) => { lines.push(rowStr(r)); if (i < rows.length - 1) lines.push(hline("├", "┼", "┤")); });
  lines.push(hline("└", "┴", "┘"));
  return lines.join("\n");
}

const fmt     = (n, d = 4) => { const x = Number(n); return Number.isFinite(x) ? x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) : "—"; };
const maskKey = s => (!s || s.length < 8) ? (s ? "****" : dim("(not set)")) : s.slice(0, 4) + "****" + s.slice(-4);
const ts      = () => new Date().toLocaleTimeString();

// ═══════════════════════════════════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════════════════════════════════
function loadConfig(p = CFG_PATH) { try { return JSON.parse(readFileSync(resolve(p), "utf8")); } catch { return {}; } }
function saveConfig(cfg, p = CFG_PATH) { writeFileSync(resolve(p), JSON.stringify(cfg, null, 2) + "\n", "utf8"); }

// ═══════════════════════════════════════════════════════════════════════════════
// Public IP
// ═══════════════════════════════════════════════════════════════════════════════
async function getPublicIp() {
  for (const fn of [
    () => fetch("https://api.ipify.org?format=json").then(r => r.json()).then(d => String(d.ip)),
    () => fetch("https://checkip.amazonaws.com/").then(r => r.text()).then(t => t.trim()),
    () => fetch("https://ifconfig.me/ip").then(r => r.text()).then(t => t.trim()),
  ]) { try { const ip = await fn(); if (ip && ip.includes(".")) return ip; } catch {} }
  return "unavailable";
}

// ═══════════════════════════════════════════════════════════════════════════════
// Binance FAPI (USD-M futures)
// ═══════════════════════════════════════════════════════════════════════════════
const FAPI_BASE = "https://fapi.binance.com";
const FAPI_TEST = "https://testnet.binancefuture.com";
const fapiBase  = testnet => testnet ? FAPI_TEST : FAPI_BASE;
const clientOrderId = () => `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`.slice(0, 36);

async function callFapi(method, path, key, secret, params = {}, testnet = false) {
  const qs  = Object.entries({ ...params, timestamp: Date.now() })
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
  const sig    = createHmac("sha256", secret).update(qs).digest("hex");
  const signed = `${qs}&signature=${sig}`;
  const base   = fapiBase(testnet);
  const url    = (method === "GET" || method === "DELETE") ? `${base}${path}?${signed}` : `${base}${path}`;
  const res    = await fetch(url, {
    method,
    headers: { "X-MBX-APIKEY": key, ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    body: method === "POST" ? signed : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) { const err = new Error(data?.msg || text || res.statusText); err.code = data?.code; throw err; }
  return data;
}

async function fetchPublic(path, params = {}, testnet = false) {
  const qs  = Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => `${k}=${v}`).join("&");
  const res = await fetch(`${fapiBase(testnet)}${path}${qs ? "?" + qs : ""}`);
  const txt = await res.text();
  if (!res.ok) throw new Error(txt || res.statusText);
  return JSON.parse(txt);
}

async function getFilters(symbol, testnet = false) {
  const info = await fetchPublic("/fapi/v1/exchangeInfo", {}, testnet);
  const sym  = (info.symbols || []).find(s => s.symbol === symbol);
  if (!sym) throw new Error(`Symbol ${symbol} not found`);
  let tickSize = 0.01, stepSize = 0.001;
  for (const f of sym.filters || []) {
    if (f.filterType === "PRICE_FILTER" && f.tickSize) tickSize = Number(f.tickSize);
    if (f.filterType === "LOT_SIZE"     && f.stepSize) stepSize = Number(f.stepSize);
  }
  return { tickSize, stepSize };
}

async function getMarkPrice(symbol, testnet = false) {
  const d = await fetchPublic("/fapi/v1/premiumIndex", { symbol }, testnet);
  return String(d.markPrice || "");
}

// ═══════════════════════════════════════════════════════════════════════════════
// Binance SAPI (broker / sub-accounts)
// ═══════════════════════════════════════════════════════════════════════════════
async function callSapi(method, path, key, secret, params = {}, baseUrl = "https://api.binance.com") {
  const p   = { ...params, recvWindow: "10000", timestamp: String(Date.now()) };
  for (const k of Object.keys(p)) { if (p[k] == null) delete p[k]; }
  const qs  = new URLSearchParams(p).toString();
  const sig = createHmac("sha256", secret).update(qs).digest("hex");
  let url, body, headers = { "X-MBX-APIKEY": key };
  if (method === "POST") { url = `${baseUrl}${path}`; body = `${qs}&signature=${sig}`; headers["Content-Type"] = "application/x-www-form-urlencoded"; }
  else url = `${baseUrl}${path}?${qs}&signature=${sig}`;
  const res  = await fetch(url, { method, headers, body });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { msg: text }; }
  if (!res.ok) { const err = new Error(data?.msg || text); err.binanceCode = data?.code ? Number(data.code) : undefined; throw err; }
  return data;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Strategy math  (mirrors StrategyPanel.tsx + symbolFilters.ts)
// ═══════════════════════════════════════════════════════════════════════════════
function roundToStep(value, step, mode = "floor") {
  const v = Number(value), s = Number(step);
  if (!(v > 0) || !(s > 0)) return "0";
  const dec = Math.max(0, Math.ceil(-Math.log10(s)));
  const n   = mode === "floor" ? Math.floor(v / s) * s : Math.round(v / s) * s;
  return n.toFixed(dec);
}
const tpFactor = (dir, pct, lvl) => { const m = (pct / 100) * lvl; return dir === "LONG" ? 1 + m : 1 - m; };
const sides    = dir => dir === "LONG" ? { entrySide: "BUY", tpSide: "SELL" } : { entrySide: "SELL", tpSide: "BUY" };

function computeSession({ direction, anchor, totalUsdt, baseQty, volPct, step, tickSize, stepSize, hedgeMode }) {
  const an = Number(anchor), vp = Number(volPct), st = Number(step);
  if (!(an > 0) || !(vp > 0) || vp > 100 || !(st > 0)) return null;
  let entryQty;
  if (Number(baseQty) > 0) entryQty = Number(roundToStep(Number(baseQty), stepSize, "floor"));
  else if (Number(totalUsdt) > 0) entryQty = Number(roundToStep(Number(totalUsdt) / an, stepSize, "floor"));
  else return null;
  if (!(entryQty > 0)) return null;
  const levels  = Math.min(200, Math.max(1, Math.floor(100 / vp)));
  const unitQty = Number(roundToStep(entryQty * (vp / 100), stepSize, "floor"));
  if (!(unitQty > 0)) return null;
  const rows = [];
  for (let i = 1; i <= levels; i++) {
    const price = roundToStep(an * tpFactor(direction, st, i), tickSize, "round");
    if (!(Number(price) > 0)) continue;
    rows.push({ level: i, price, qty: unitQty, percent: vp });
  }
  if (!rows.length) return null;
  const entryPrice = roundToStep(an, tickSize, "round");
  const entryQuote = Number(totalUsdt) > 0 ? Number(totalUsdt) : entryQty * an;
  let qOut = 0, uQty = 0;
  for (const r of rows) { qOut += Number(r.price) * r.qty; uQty += r.qty; }
  const profit = direction === "LONG" ? qOut - uQty * an : uQty * an - qOut;
  return { entryPrice, entryQty, entryQuote, rows, unitQty, positionSide: hedgeMode ? direction : undefined, profit, roi: entryQuote > 0 ? (profit / entryQuote) * 100 : 0 };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Order helpers
// ═══════════════════════════════════════════════════════════════════════════════
async function getOrder(key, secret, symbol, orderId, testnet) {
  return callFapi("GET", "/fapi/v1/order", key, secret, { symbol, orderId }, testnet);
}

async function cancelOrder(key, secret, symbol, orderId, testnet) {
  try { return await callFapi("DELETE", "/fapi/v1/order", key, secret, { symbol, orderId }, testnet); } catch {}
}

async function cancelAllOrders(key, secret, symbol, testnet) {
  try { return await callFapi("DELETE", "/fapi/v1/allOpenOrders", key, secret, { symbol }, testnet); } catch {}
}

async function placeLimitOrder(key, secret, symbol, side, qty, price, positionSide, reduceOnly, testnet) {
  const params = {
    symbol, side, type: "LIMIT", timeInForce: "GTC",
    quantity: String(qty), price: String(price),
    ...(positionSide ? { positionSide } : {}),
    ...(!positionSide && reduceOnly ? { reduceOnly: "true" } : {}),
    newClientOrderId: clientOrderId(),
  };
  // auto-retry without positionSide on -4061 (one-way account)
  try {
    const r = await callFapi("POST", "/fapi/v1/order", key, secret, params, testnet);
    return { orderId: Number(r.orderId), positionSideUsed: positionSide };
  } catch (err) {
    if (err.code === -4061 && positionSide) {
      const { positionSide: _x, ...noPs } = params;
      const r = await callFapi("POST", "/fapi/v1/order", key, secret, noPs, testnet);
      return { orderId: Number(r.orderId), positionSideUsed: undefined };
    }
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Cycle worker  (fully standalone — no proxy needed)
// ═══════════════════════════════════════════════════════════════════════════════

// Global active cycle (only one session at a time)
let CYCLE = null;

/**
 * Cycle state shape:
 * {
 *   sessionId, apiKey, apiSecret, symbol, direction, sess,
 *   testnet, startedAt,
 *   phase: "waiting_entry" | "active" | "stopping" | "stopped",
 *   entryOrderId, entryFilledAt,
 *   tpOrders: [{orderId, level, price, qty, status}],  // all current TPs
 *   reEntries: [{orderId, tpLevel, tpPrice, qty, status}],  // pending re-entries
 *   cycleCount, profitUsdt,
 *   log: [{time, msg}],   // last 20 events
 *   lastPollAt, pollError,
 * }
 */

function addLog(cycle, msg) {
  cycle.log.push({ time: ts(), msg });
  if (cycle.log.length > 30) cycle.log.shift();
}

async function tickCycle(cycle) {
  if (cycle.phase === "stopped" || cycle.phase === "stopping") return;
  const { apiKey, apiSecret, symbol, direction, sess, testnet } = cycle;
  const { entrySide, tpSide } = sides(direction);

  try {
    // ── Phase: waiting for entry to fill ──────────────────────────────────────
    if (cycle.phase === "waiting_entry") {
      const order = await getOrder(apiKey, apiSecret, symbol, cycle.entryOrderId, testnet);
      if (order.status === "FILLED") {
        addLog(cycle, `Entry filled — placing ${sess.rows.length} TPs`);
        cycle.entryFilledAt = Date.now();
        cycle.tpOrders = [];
        for (const row of sess.rows) {
          try {
            const r = await placeLimitOrder(apiKey, apiSecret, symbol, tpSide, row.qty, row.price, sess.positionSide, true, testnet);
            cycle.tpOrders.push({ orderId: r.orderId, level: row.level, price: row.price, qty: row.qty, status: "OPEN" });
          } catch (err) {
            addLog(cycle, `⚠ TP${row.level} failed: ${err.message}`);
          }
        }
        cycle.cycleCount++;
        cycle.phase = "active";
        addLog(cycle, `Cycle #${cycle.cycleCount} started — ${cycle.tpOrders.length} TPs placed`);
      }
    }

    // ── Phase: active — watching TPs and re-entries ───────────────────────────
    else if (cycle.phase === "active") {
      // Check open TPs
      for (const tp of cycle.tpOrders) {
        if (tp.status !== "OPEN") continue;
        const order = await getOrder(apiKey, apiSecret, symbol, tp.orderId, testnet);
        if (order.status === "FILLED") {
          tp.status = "FILLED";
          const gain = direction === "LONG"
            ? (Number(tp.price) - Number(sess.entryPrice)) * tp.qty
            : (Number(sess.entryPrice) - Number(tp.price)) * tp.qty;
          cycle.profitUsdt = (cycle.profitUsdt || 0) + gain;
          addLog(cycle, `TP${tp.level} filled @ ${tp.price}  (+$${gain.toFixed(4)}) — placing re-entry`);
          // Place re-entry at anchor
          try {
            const r = await placeLimitOrder(apiKey, apiSecret, symbol, entrySide, tp.qty, sess.entryPrice, sess.positionSide, false, testnet);
            cycle.reEntries.push({ orderId: r.orderId, tpLevel: tp.level, tpPrice: tp.price, qty: tp.qty, status: "OPEN" });
          } catch (err) {
            addLog(cycle, `⚠ Re-entry for TP${tp.level} failed: ${err.message}`);
          }
        }
      }

      // Check pending re-entries
      for (const re of cycle.reEntries) {
        if (re.status !== "OPEN") continue;
        const order = await getOrder(apiKey, apiSecret, symbol, re.orderId, testnet);
        if (order.status === "FILLED") {
          re.status = "FILLED";
          addLog(cycle, `Re-entry filled @ ${sess.entryPrice} — recycling TP${re.tpLevel} @ ${re.tpPrice}`);
          // Recycle the TP at its original price
          try {
            const r = await placeLimitOrder(apiKey, apiSecret, symbol, tpSide, re.qty, re.tpPrice, sess.positionSide, true, testnet);
            // Replace filled TP with recycled one
            const idx = cycle.tpOrders.findIndex(t => t.level === re.tpLevel);
            if (idx >= 0) cycle.tpOrders[idx] = { orderId: r.orderId, level: re.tpLevel, price: re.tpPrice, qty: re.qty, status: "OPEN" };
            else cycle.tpOrders.push({ orderId: r.orderId, level: re.tpLevel, price: re.tpPrice, qty: re.qty, status: "OPEN" });
          } catch (err) {
            addLog(cycle, `⚠ Recycle TP${re.tpLevel} failed: ${err.message}`);
          }
        }
      }

      // Clean up completed re-entries
      cycle.reEntries = cycle.reEntries.filter(r => r.status !== "FILLED");
    }

    cycle.lastPollAt = Date.now();
    cycle.pollError  = null;
  } catch (err) {
    cycle.pollError = err.message;
    cycle.lastPollAt = Date.now();
  }
}

function startCycleWorker(cycleData) {
  CYCLE = { ...cycleData, phase: "waiting_entry", tpOrders: [], reEntries: [], cycleCount: 0, profitUsdt: 0, log: [], lastPollAt: null, pollError: null, startedAt: Date.now() };
  addLog(CYCLE, `Session started — waiting for entry fill`);
  CYCLE._interval = setInterval(async () => {
    if (CYCLE) await tickCycle(CYCLE);
  }, 3000);
}

async function stopCycleWorker(cancelOrders = true) {
  if (!CYCLE) return;
  CYCLE.phase = "stopping";
  clearInterval(CYCLE._interval);
  if (cancelOrders) {
    await cancelAllOrders(CYCLE.apiKey, CYCLE.apiSecret, CYCLE.symbol, CYCLE.testnet);
    addLog(CYCLE, "All orders cancelled");
  }
  CYCLE.phase = "stopped";
  CYCLE = null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Session monitor screen
// ═══════════════════════════════════════════════════════════════════════════════
async function screenMonitor() {
  if (!CYCLE) {
    clr(); drawBox("Session Monitor");
    wl(dim("\n  No active session.\n"));
    await anyKey(); return;
  }

  const drawMonitor = () => {
    if (!CYCLE) return;
    const c       = CYCLE;
    const runtime = Math.floor((Date.now() - c.startedAt) / 1000);
    const hh      = String(Math.floor(runtime / 3600)).padStart(2, "0");
    const mm      = String(Math.floor((runtime % 3600) / 60)).padStart(2, "0");
    const ss_     = String(runtime % 60).padStart(2, "0");

    clr();
    drawBox(`Session — ${c.symbol} ${c.direction}`);
    wl();
    wl(`  ${bold("ID")}:       ${dim(c.sessionId)}`);
    wl(`  ${bold("Runtime")}: ${hh}:${mm}:${ss_}`);
    wl(`  ${bold("Phase")}:   ${c.phase === "waiting_entry" ? yellow("Waiting for entry fill") : c.phase === "active" ? green("Active") : red(c.phase)}`);
    wl(`  ${bold("Cycles")}: ${c.cycleCount}   ${bold("Profit")}: ${c.profitUsdt >= 0 ? green : red}(${c.profitUsdt >= 0 ? "+" : ""}$${(c.profitUsdt || 0).toFixed(4)})`);
    if (c.pollError) wl(`  ${yellow("⚠ Poll error:")} ${dim(c.pollError)}`);
    wl();

    // Entry
    const entryLabel = c.phase === "waiting_entry" ? yellow("[waiting]") : green("[filled]");
    wl(`  ${bold("Entry")}:   ${sides(c.direction).entrySide} ${c.sess.entryQty} @ ${c.sess.entryPrice}  ${entryLabel}`);
    wl();

    // TPs
    const openTps   = c.tpOrders.filter(t => t.status === "OPEN");
    const filledTps = c.tpOrders.filter(t => t.status === "FILLED");
    if (c.tpOrders.length > 0) {
      wl(`  ${bold("TP orders")} — ${green(openTps.length + " open")}, ${dim(filledTps.length + " filled")}`);
      for (const tp of c.tpOrders.slice(0, 10)) {
        const marker = tp.status === "FILLED" ? dim("✓") : green("○");
        wl(`    ${marker} TP${tp.level}: ${tp.status === "FILLED" ? dim(tp.price) : yellow(tp.price)}  qty=${tp.qty}`);
      }
      if (c.tpOrders.length > 10) wl(dim(`    ... and ${c.tpOrders.length - 10} more`));
      wl();
    }

    // Pending re-entries
    if (c.reEntries.length > 0) {
      wl(`  ${bold("Pending re-entries")}:`);
      for (const re of c.reEntries) {
        wl(`    ${cyan("↺")} TP${re.tpLevel}: BUY ${re.qty} @ ${c.sess.entryPrice}  ${dim("→ recycles TP" + re.tpLevel + " @ " + re.tpPrice)}`);
      }
      wl();
    }

    // Log
    if (c.log.length > 0) {
      wl(`  ${bold("Recent events")}:`);
      const recent = c.log.slice(-8);
      for (const entry of recent) wl(`    ${dim(entry.time)}  ${entry.msg}`);
    }

    wl();
    wl(dim("  [q] Stop & cancel all   [b] Back to menu   auto-refresh every 5s"));
  };

  while (true) {
    if (!CYCLE) { clr(); drawBox("Session Monitor"); wl(dim("\n  Session ended.\n")); await anyKey(); return; }
    drawMonitor();
    const key = await waitKey(5000);
    if (key === "q" || key === "Q") {
      const ok = await yesNo("Stop session and cancel all open orders?");
      if (ok) { await stopCycleWorker(true); clr(); drawBox("Session Stopped"); wl(green("\n  ✓ All orders cancelled.\n")); await anyKey("Press any key to return to menu..."); return; }
    }
    if (key === "b" || key === "B" || key === "\x1b") break;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Bot session screens
// ═══════════════════════════════════════════════════════════════════════════════
function drawPreview(symbol, direction, sess, hedgeMode) {
  const { entrySide, tpSide } = sides(direction);
  const ps = sess.profit >= 0 ? "+" : "";
  wl(); wl(`  ${bold("Symbol")}:     ${white(symbol)}`);
  wl(`  ${bold("Direction")}: ${direction === "LONG" ? green("LONG") : red("SHORT")}`);
  wl(`  ${bold("Entry")}:     ${entrySide === "BUY" ? green(entrySide) : red(entrySide)} ${white(String(sess.entryQty))} @ ${yellow(sess.entryPrice)}  = $${sess.entryQuote.toFixed(2)}`);
  wl(`  ${bold("Mode")}:      ${hedgeMode ? yellow("Hedge (positionSide: " + direction + ")") : "One-Way"}`);
  wl(); wl(`  ${bold("TP rows → " + tpSide)} after entry fills (${sess.rows.length} levels, re-enters @ anchor each fill)`); wl();
  drawTable(
    ["#", "Price", "Qty", "% Move", "USDT out"],
    sess.rows.map(r => {
      const pct = (Number(r.price) / Number(sess.entryPrice) - 1) * 100;
      return [r.level, r.price, r.qty.toFixed(6), `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`, `$${(Number(r.price) * r.qty).toFixed(2)}`];
    }),
    [4, 14, 12, 8, 9]
  );
  wl(); wl(`  ${bold("Est. profit / cycle")}:    ${(sess.profit >= 0 ? green : red)(`${ps}$${sess.profit.toFixed(4)}  (${ps}${sess.roi.toFixed(3)}%)`)}`);
  wl(`  ${bold("Est. profit / TP level")}: ${(sess.profit >= 0 ? green : red)(`${ps}$${(sess.profit / sess.rows.length).toFixed(4)}`)}`);
}

async function screenNewSession(ctx) {
  if (CYCLE && CYCLE.phase !== "stopped") {
    clr(); drawBox("Start New Session");
    wl(yellow("\n  A session is already running.\n  Open 'View Active Session' to monitor or stop it first.\n"));
    await anyKey(); return;
  }

  const { apiKey, apiSecret, testnet, defaults } = ctx;

  clr(); drawBox("New Session — Step 1 / 6  Symbol");
  wl();
  const symbol = (await textInput("Symbol", defaults.symbol)).toUpperCase();

  clr(); drawBox("New Session — Step 2 / 6  Direction");
  wl(`\n  Symbol: ${bold(symbol)}\n`);
  const { label: dirLabel } = await inlineMenu([
    "LONG  —  BUY entry,  SELL TPs above anchor  (profit when price rises → returns)",
    "SHORT —  SELL entry, BUY TPs below anchor   (profit when price falls → returns)",
  ], 0);
  const direction = dirLabel.startsWith("LONG") ? "LONG" : "SHORT";

  clr(); drawBox("New Session — Step 3 / 6  Anchor Price");
  wl(`\n  Symbol:    ${bold(symbol)}`);
  wl(`  Direction: ${direction === "LONG" ? green("LONG") : red("SHORT")}\n`);
  w(`  ${dim("Fetching mark price...")}`);
  const markNum = await getMarkPrice(symbol, testnet).then(s => Number(s) || null).catch(() => null);
  w(CL);
  if (markNum) wl(`  ${dim("(mark: " + markNum.toLocaleString("en-US", { maximumFractionDigits: 4 }) + ")")}`);
  const anchorStr = await textInput("Anchor price", markNum ? String(Math.round(markNum)) : (defaults.anchor || ""));
  if (!(Number(anchorStr) > 0)) { wl(red("\n  Invalid price.")); await anyKey(); return; }

  clr(); drawBox("New Session — Step 4 / 6  Position Size");
  wl(`\n  Symbol: ${bold(symbol)}  Direction: ${direction === "LONG" ? green("LONG") : red("SHORT")}  Anchor: ${yellow(anchorStr)}\n`);
  wl(`  ${dim("Enter total in USDT, or press Enter then enter base qty.\n")}`);
  const totalStr = await textInput("Total USDT", defaults.totalUsdt);
  let baseQtyStr = "";
  if (!(Number(totalStr) > 0)) {
    wl(); baseQtyStr = await textInput("Base qty (BTC/ETH/etc)", "");
    if (!(Number(baseQtyStr) > 0)) { wl(red("\n  Need USDT total or base qty.")); await anyKey(); return; }
  }

  clr(); drawBox("New Session — Step 5 / 6  TP Grid");
  wl(`\n  Symbol: ${bold(symbol)}  Anchor: ${yellow(anchorStr)}  Size: ${Number(totalStr) > 0 ? "$" + totalStr : baseQtyStr + " (base)"}\n`);
  wl(`  ${dim("Vol/TP: % per level (12.5% → 8 levels, 10% → 10 levels)")}`);
  wl(`  ${dim("Spacing: % price gap between levels")}\n`);
  const volPctStr = await textInput("Vol per TP level (%)", defaults.volPct);
  wl();
  const stepStr   = await textInput("Spacing between TPs (%)", defaults.step);

  clr(); drawBox("New Session — Step 6 / 6  Position Mode");
  wl(`\n  Symbol: ${bold(symbol)}  Grid: ${volPctStr}% / TP,  ${stepStr}% spacing\n`);
  const { index: modeIdx } = await inlineMenu([
    "One-Way mode  —  no positionSide sent  (most accounts)",
    "Hedge mode    —  sends positionSide LONG or SHORT  (advanced)",
  ], 0);
  const hedgeMode = modeIdx === 1;

  clr(); drawBox("Fetching Exchange Filters");
  w(`\n  Fetching filters for ${bold(symbol)}...`);
  let tickSize, stepSize;
  try {
    ({ tickSize, stepSize } = await getFilters(symbol, testnet));
    wl(` ${green("✓")}  tick=${tickSize}  step=${stepSize}`);
  } catch (err) { wl(` ${red("✗")} ${err.message}`); await anyKey(); return; }

  const sess = computeSession({ direction, anchor: anchorStr, totalUsdt: totalStr, baseQty: baseQtyStr, volPct: volPctStr, step: stepStr, tickSize, stepSize, hedgeMode });
  if (!sess) { wl(red("\n  Position too small or vol% out of range. Increase total or reduce vol%.")); await anyKey(); return; }

  clr(); drawBox("New Session — Preview & Confirm");
  drawPreview(symbol, direction, sess, hedgeMode);
  wl(); wl(`  ${dim("The bot will manage this cycle automatically:")}`);
  wl(`  ${dim("  Entry fills → places TPs → each TP fills → re-entry @ anchor → recycles TP → repeats")}`);

  const ok = await yesNo("Start this session?");
  if (!ok) { wl(dim("\n  Cancelled.")); await anyKey(); return; }

  clr(); drawBox("Starting Session");
  wl();

  // Place entry order
  const { entrySide } = sides(direction);
  w(`  ${dim("→")} Placing ${cyan(entrySide)} ${sess.entryQty} ${symbol} @ ${yellow(sess.entryPrice)}...`);
  let entryOrderId = null;
  const t0 = Date.now();
  try {
    const r = await placeLimitOrder(apiKey, apiSecret, symbol, entrySide, sess.entryQty, sess.entryPrice, sess.positionSide, false, testnet);
    entryOrderId = r.orderId;
    if (r.positionSideUsed === undefined && hedgeMode) wl(` ${yellow("⚠  one-way account — placed without positionSide")}`);
    else wl(` ${green("✓")} #${entryOrderId}  ${dim("(" + (Date.now() - t0) + " ms)")}`);
    if (r.positionSideUsed === undefined) sess.positionSide = undefined;
  } catch (err) { wl(` ${red("✗")} ${err.message}`); await anyKey(); return; }

  // Start cycle worker
  const sessionId = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  startCycleWorker({ sessionId, apiKey, apiSecret, symbol, direction, sess, testnet, entryOrderId });
  CYCLE.entryOrderId = entryOrderId;

  wl(` ${green("✓")} Cycle worker started — session ID: ${dim(sessionId)}`);
  wl(); wl(`  ${dim("Entry fill → TPs auto-placed → each TP fill → re-entry @ anchor → repeats forever")}`);
  wl(); wl(`  ${cyan("→ Opening session monitor...")}`);

  await new Promise(r => setTimeout(r, 1500));
  await screenMonitor();
}

async function screenOrders(ctx) {
  const { apiKey, apiSecret, testnet, defaults } = ctx;
  const symbol = defaults.symbol.toUpperCase();
  clr(); drawBox(`Open Orders — ${symbol}`);
  w("\n  Loading...");
  try {
    const orders = await callFapi("GET", "/fapi/v1/openOrders", apiKey, apiSecret, { symbol }, testnet);
    w(CL);
    if (!orders?.length) wl(dim("\n  No open orders."));
    else { wl(); drawTable(["Order ID", "Side", "Price", "Qty", "Filled/Total", "PosSide"], orders.map(o => [o.orderId, o.side, o.price, o.origQty, `${o.executedQty}/${o.origQty}`, o.positionSide || "BOTH"]), [13, 5, 12, 10, 13, 7]); }
  } catch (err) { w(CL); wl(red(`\n  Error: ${err.message}`)); }
  await anyKey();
}

async function screenPositions(ctx) {
  const { apiKey, apiSecret, testnet, defaults } = ctx;
  clr(); drawBox(`Positions — ${defaults.symbol.toUpperCase()}`);
  w("\n  Loading...");
  try {
    const all = await callFapi("GET", "/fapi/v2/positionRisk", apiKey, apiSecret, { symbol: defaults.symbol.toUpperCase() }, testnet);
    const act = (all || []).filter(p => Math.abs(Number(p.positionAmt)) > 0);
    w(CL);
    if (!act.length) wl(dim("\n  No open positions."));
    else { wl(); drawTable(["Symbol", "Side", "Amt", "Entry", "Mark", "PnL"], act.map(p => { const pnl = Number(p.unrealizedProfit); return [p.symbol, p.positionSide || (Number(p.positionAmt) > 0 ? "LONG" : "SHORT"), Math.abs(Number(p.positionAmt)), p.entryPrice, p.markPrice, (pnl >= 0 ? "+" : "") + pnl.toFixed(4)]; }), [10, 6, 10, 12, 12, 12]); }
  } catch (err) { w(CL); wl(red(`\n  Error: ${err.message}`)); }
  await anyKey();
}

async function screenBalance(ctx) {
  const { apiKey, apiSecret, testnet } = ctx;
  clr(); drawBox("Account Balance");
  w("\n  Loading...");
  try {
    const acct = await callFapi("GET", "/fapi/v2/account", apiKey, apiSecret, {}, testnet);
    w(CL); wl();
    const usdt = (acct.assets || []).find(a => a.asset === "USDT");
    if (!usdt) wl(dim("  No USDT balance."));
    else {
      const pnl = Number(acct.totalUnrealizedProfit || 0);
      wl(`  ${bold("Wallet Balance")}:   ${white("$" + Number(usdt.walletBalance).toFixed(2))}`);
      wl(`  ${bold("Available")}:        ${green("$" + Number(usdt.availableBalance).toFixed(2))}`);
      wl(`  ${bold("Margin Balance")}:   ${white("$" + Number(acct.totalMarginBalance || 0).toFixed(2))}`);
      wl(`  ${bold("Unrealized PnL")}:   ${(pnl >= 0 ? green : red)((pnl >= 0 ? "+" : "") + "$" + pnl.toFixed(4))}`);
    }
  } catch (err) { w(CL); wl(red(`\n  Error: ${err.message}`)); }
  await anyKey();
}

// ═══════════════════════════════════════════════════════════════════════════════
// Fund transfer screens
// ═══════════════════════════════════════════════════════════════════════════════
async function listSubAccounts(bKey, bSecret) {
  const d = await callSapi("GET", "/sapi/v1/sub-account/list", bKey, bSecret, {});
  const raw = Array.isArray(d?.subAccounts) ? d.subAccounts : [];
  return raw.map(a => ({ email: String(a.email || "") })).filter(a => a.email);
}
async function getSubBalance(bKey, bSecret, email, futuresType = 1) {
  try {
    const d = await callSapi("GET", "/sapi/v2/sub-account/futures/account", bKey, bSecret, { email, futuresType });
    // USDT-M uses futureAccountResp; COIN-M uses deliveryAccountResp
    const resp = futuresType === 2 ? d?.deliveryAccountResp : d?.futureAccountResp;
    const assets = Array.isArray(resp?.assets) ? resp.assets : [];
    const mainAsset = futuresType === 1 ? "USDT" : "BTC";
    const found = assets.find(a => String(a.asset) === mainAsset);
    return { total: found?.walletBalance ?? "0", available: found?.availableBalance ?? "0", asset: mainAsset };
  } catch { return { total: "—", available: "—", asset: futuresType === 1 ? "USDT" : "BTC" }; }
}
async function doTransfer(bKey, bSecret, { from, to, asset, amount, futuresType, clientTranId }) {
  const isMaster = id => !id || String(id).toLowerCase() === "master";
  const fromEmail = !isMaster(from) ? from : null;
  const toEmail   = !isMaster(to)   ? to   : null;
  if (fromEmail && toEmail) {
    // Sub→Sub: dedicated internal transfer endpoint (needs "Enable Internal Transfer" permission)
    return callSapi("POST", "/sapi/v1/sub-account/futures/internalTransfer", bKey, bSecret, {
      fromEmail, toEmail, futuresType: futuresType || 1, asset, amount: String(amount),
      ...(clientTranId ? { clientTranId } : {}),
    });
  }
  // Master→Sub or Sub→Master: universal transfer (needs "Allow Universal Transfer" permission)
  const acctType = futuresType === 2 ? "CMFUTURE" : "UMFUTURE";
  return callSapi("POST", "/sapi/v1/asset/universalTransfer", bKey, bSecret, {
    fromAccountType: acctType, toAccountType: acctType,
    asset, amount: String(amount),
    ...(clientTranId ? { clientTranId } : {}),
    ...(fromEmail ? { fromEmail } : {}),
    ...(toEmail   ? { toEmail }   : {}),
  });
}

async function runAutoRules(bKey, bSecret, bBase, cfg, dryRun) {
  const rules = (cfg.transferRules ?? []).filter(r => r.enabled !== false);
  if (!rules.length) { wl(yellow("  No enabled transferRules in config.json\n")); return; }
  wl(dim(`\n  Processing ${rules.length} rule(s)…\n`));
  const isMaster = id => !id || String(id).toLowerCase() === "master";
  for (const rule of rules) {
    const ft = Number(rule.futuresType ?? 1), asset = String(rule.asset ?? "USDT");
    wl(bold(`  ● ${rule.label || rule.from + " → " + rule.to}`));
    let amount = null;
    // Pull excess from source sub-account (sub→any when pullAbove/keepBalance set)
    if (rule.pullAbove != null && rule.keepBalance != null && !isMaster(rule.from)) {
      w("  Checking source balance…");
      const bal = await getSubBalance(bKey, bSecret, rule.from, ft); w(`\r${CL}`);
      const avail = Number(bal.available); wl(dim(`  Balance: ${fmt(avail, 2)} ${asset}`));
      if (avail > Number(rule.pullAbove)) { amount = avail - Number(rule.keepBalance); wl(dim(`  Pull ${fmt(amount, 2)}`)); }
      else { wl(dim(`  Threshold not reached — skipped.\n`)); continue; }
    // Top-up destination (any→sub when topUpTo/topUpBelow set — works for master→sub AND sub→sub)
    } else if (rule.topUpTo != null && rule.topUpBelow != null) {
      w("  Checking dest balance…");
      const bal = await getSubBalance(bKey, bSecret, rule.to, ft); w(`\r${CL}`);
      const avail = Number(bal.available); wl(dim(`  Dest: ${fmt(avail, 2)} ${asset}`));
      if (avail < Number(rule.topUpBelow)) { amount = Number(rule.topUpTo) - avail; wl(dim(`  Top-up by ${fmt(amount, 2)}`)); }
      else { wl(dim(`  Above threshold — skipped.\n`)); continue; }
    // Fixed amount transfer
    } else if (rule.amount != null) {
      amount = Number(rule.amount);
    }
    if (!amount || amount <= 0) { wl(dim("  Nothing to transfer — skipped.\n")); continue; }
    if (dryRun) { wl(cyan(`  [dry-run] Would transfer ${fmt(amount, 2)} ${asset}\n`)); continue; }
    w("  Submitting…");
    try {
      const t0 = Date.now(), r = await doTransfer(bKey, bSecret, { from: rule.from, to: rule.to, asset, amount, futuresType: ft, clientTranId: `tf${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` });
      wl(`\r  ${green("✓")} TxID: ${r.txnId ?? r.tranId ?? "—"}  ${dim("(" + (Date.now() - t0) + " ms)")}\n`);
    } catch (err) { wl(`\r  ${red("✗")} ${err.message}\n`); }
  }
}

async function screenSubAccounts(bKey, bSecret, bBase, cfg) {
  while (true) {
    clr(); drawBox("Sub-account Balances");
    w("\n  Fetching sub-accounts…");
    try {
      const accounts = await listSubAccounts(bKey, bSecret); w(`\r${CL}`);
      if (!accounts.length) { wl(dim("\n  No sub-accounts found.\n")); }
      else {
        const lm = Object.fromEntries((cfg.subAccounts ?? []).map(s => [String(s.email ?? s.id ?? ""), s.label ?? ""]));
        w(`  Fetching balances (${accounts.length} accounts)…`);
        const rows = [];
        for (let i = 0; i < accounts.length; i++) {
          const email = String(accounts[i].email ?? "—");
          const lbl = lm[email] || "", bal = await getSubBalance(bKey, bSecret, email, 1);
          rows.push([lbl ? cyan(lbl) : "", dim(email), `${fmt(bal.total, 2)} ${bal.asset}`, `${fmt(bal.available, 2)} ${bal.asset}`]);
          w(`\r  Fetching balances… ${i + 1}/${accounts.length}`);
        }
        w(`\r${CL}`);
        wl(drawGrid(["Label", "Email (use in config from/to)", "Total", "Available"], rows, `USDT-M Futures (${accounts.length})`));
        wl(dim("  ↑ Copy the email address into transferRules from/to fields in config.json"));
      }
    } catch (err) { w(`\r${CL}`); wl(red(`\n  ✗ ${err.message}\n`)); }
    wl(); wl(dim("  r = refresh   any other key = back"));
    const key = await new Promise(res => { const f = k => { if (k === "\x03") { exitRaw(); process.exit(0); } process.stdin.removeListener("data", f); res(k); }; process.stdin.on("data", f); });
    if (key !== "r" && key !== "R") break;
  }
}

async function screenTransfer(bKey, bSecret, bBase) {
  clr(); drawBox("Transfer Funds");
  wl(`\n  ${dim("Use sub-account email address or 'master'. Emails are shown in 'List Sub-accounts'.")}\n`);
  const from   = (await textInput("From (email or 'master')", "")).trim();
  const to     = (await textInput("To   (email or 'master')", "")).trim();
  const asset  = ((await textInput("Asset", "USDT")).trim().toUpperCase()) || "USDT";
  const amtStr = (await textInput("Amount", "")).trim();
  const ftStr  = (await textInput("Futures Type (1=USDT-M, 2=COIN-M)", "1")).trim();
  const amount = Number(amtStr), ft = Number(ftStr) === 2 ? 2 : 1;
  const isMaster = id => !id || String(id).toLowerCase() === "master";
  if (amount <= 0) { wl(red("\n  Amount must be > 0.")); await anyKey(); return; }
  if (!from && !to) { wl(red("\n  From or To must be set.")); await anyKey(); return; }
  if (from.toLowerCase() === to.toLowerCase()) { wl(red("\n  From and To cannot be same.")); await anyKey(); return; }
  wl(`\n  ${dim("From")}  ${isMaster(from) ? bold("master") : from}`);
  wl(`  ${dim("To")}    ${isMaster(to) ? bold("master") : to}`);
  wl(`  ${dim("Amt")}   ${bold(fmt(amount, 4) + " " + asset)} (${ft === 2 ? "COIN-M" : "USDT-M"})`);
  const ok = await yesNo("Confirm transfer?");
  if (!ok) { wl(dim("\n  Cancelled.")); await anyKey(); return; }
  w("  Submitting…");
  try {
    const t0 = Date.now(), r = await doTransfer(bKey, bSecret, { from, to, asset, amount, futuresType: ft, clientTranId: `tf${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` });
    wl(`\r  ${green("✓")} TxID: ${r.txnId ?? r.tranId ?? "—"}  ${dim("(" + (Date.now() - t0) + " ms)")}`);
  } catch (err) { wl(`\r  ${red("✗")} ${err.message}`); if (err.binanceCode) wl(dim(`  Code: ${err.binanceCode}`)); }
  await anyKey();
}

async function screenAutoRules(bKey, bSecret, bBase, cfg) {
  clr(); drawBox("Auto Transfer Rules");
  const rules = (cfg.transferRules ?? []).filter(r => r.enabled !== false);
  if (!rules.length) { wl(yellow("\n  No enabled transferRules in config.json.")); wl(dim("  Add rules to config.json (see config.example.json).\n")); await anyKey(); return; }
  wl(dim(`\n  ${rules.length} rule(s):\n`));
  rules.forEach(r => wl(dim(`    • ${r.label || r.from + " → " + r.to}`)));
  const ok = await yesNo("\n  Run all rules now?");
  if (!ok) { wl(dim("  Cancelled.")); await anyKey(); return; }
  try { await runAutoRules(bKey, bSecret, bBase, cfg, false); }
  catch (err) { wl(red(`  ✗ ${err.message}\n`)); }
  await anyKey();
}

async function screenWatchMode(bKey, bSecret, bBase, cfg) {
  clr(); drawBox("Watch Mode — Auto Transfer Loop");
  const intStr = await textInput("Check interval (seconds)", "60");
  const intSec = Math.max(5, Number(intStr) || 60);
  wl(); wl(dim(`  Running every ${intSec}s. Press Ctrl+C to stop.\n`));
  exitRaw();
  let cycle = 0;
  while (true) {
    cycle++;
    wl(dim(`  ── Cycle ${cycle} @ ${ts()} ──`));
    try { await runAutoRules(bKey, bSecret, bBase, cfg, false); }
    catch (err) { wl(red(`  ✗ ${err.message}\n`)); }
    wl(dim(`  Next run in ${intSec}s…\n`));
    await new Promise(r => setTimeout(r, intSec * 1000));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Settings screen
// ═══════════════════════════════════════════════════════════════════════════════
async function screenSettings(cfg, cfgPath) {
  while (true) {
    const { label } = await fullMenu([
      "Edit Trading API Keys",
      "Edit Broker API Keys",
      "Edit Bot Defaults",
      "Edit Proxy URL",
      "─",
      "Save & Back",
      "Discard & Back",
    ], 0, () => {
      drawBox("Settings — Configuration");
      wl(`\n  ${dim("Config:")} ${cfgPath}`);
      wl(`\n  ${bold("Trading API")}  ${dim("(place orders)")}`);
      wl(`    Key:    ${maskKey(cfg?.trading?.apiKey)}`);
      wl(`    Secret: ${maskKey(cfg?.trading?.apiSecret)}`);
      wl(`\n  ${bold("Broker API")}  ${dim("(fund transfers)")}`);
      wl(`    Key:    ${maskKey(cfg?.broker?.apiKey)}`);
      wl(`    Secret: ${maskKey(cfg?.broker?.apiSecret)}`);
      wl(`\n  ${bold("Proxy URL")}:   ${cfg?.proxyUrl || dim("(not set — not required for standalone bot)")}`);
      wl(`\n  ${bold("Defaults")}:    ${cfg?.orderDefaults?.symbol || "BTCUSDT"} / $${cfg?.orderDefaults?.totalUsdt || "2000"} / ${cfg?.orderDefaults?.volPct || "12.5"}% vol / ${cfg?.orderDefaults?.step || "1"}% spacing`);
      wl();
    });

    if (label === "Discard & Back") return cfg;

    if (label === "Save & Back") {
      try { saveConfig(cfg, cfgPath); clr(); drawBox("Settings — Saved"); wl(green(`\n  ✓ Saved to ${cfgPath}`)); await anyKey("Press any key to return..."); return cfg; }
      catch (err) { wl(red(`\n  ✗ Could not save: ${err.message}`)); await anyKey(); }
      continue;
    }
    if (label === "Edit Trading API Keys") {
      clr(); drawBox("Settings — Trading API Keys");
      wl(`\n  ${dim("Press Enter to keep the current value.")}\n`);
      const key = await secretInput("Trading API Key", cfg?.trading?.apiKey || ""), secret = await secretInput("Trading API Secret", cfg?.trading?.apiSecret || "");
      cfg = { ...cfg, trading: { ...(cfg?.trading || {}), apiKey: key || cfg?.trading?.apiKey, apiSecret: secret || cfg?.trading?.apiSecret } };
      wl(green("  ✓ Updated (choose Save & Back to persist)")); await anyKey("Press any key to continue...");
    }
    else if (label === "Edit Broker API Keys") {
      clr(); drawBox("Settings — Broker API Keys");
      wl(`\n  ${dim("Press Enter to keep the current value.")}\n`);
      const key = await secretInput("Broker API Key", cfg?.broker?.apiKey || ""), secret = await secretInput("Broker API Secret", cfg?.broker?.apiSecret || "");
      cfg = { ...cfg, broker: { ...(cfg?.broker || {}), apiKey: key || cfg?.broker?.apiKey, apiSecret: secret || cfg?.broker?.apiSecret } };
      wl(green("  ✓ Updated (not saved yet)")); await anyKey("Press any key to continue...");
    }
    else if (label === "Edit Bot Defaults") {
      clr(); drawBox("Settings — Bot Defaults");
      wl(`\n  ${dim("Pre-filled in the Start New Session form.")}\n`);
      const symbol = (await textInput("Default symbol", cfg?.orderDefaults?.symbol || "BTCUSDT")).toUpperCase();
      const totalUsdt = await textInput("Default total USDT", cfg?.orderDefaults?.totalUsdt || "2000");
      const volPct = await textInput("Default vol/TP %", cfg?.orderDefaults?.volPct || "12.5");
      const step   = await textInput("Default spacing %", cfg?.orderDefaults?.step || "1");
      cfg = { ...cfg, orderDefaults: { ...(cfg?.orderDefaults || {}), symbol, totalUsdt, volPct, step } };
      wl(green("  ✓ Updated (not saved yet)")); await anyKey("Press any key to continue...");
    }
    else if (label === "Edit Proxy URL") {
      clr(); drawBox("Settings — Proxy URL");
      wl(`\n  ${dim("Optional — only needed for the frontend dashboard.")}\n`);
      const proxyUrl = await textInput("Proxy URL", cfg?.proxyUrl || "http://localhost:3001");
      cfg = { ...cfg, proxyUrl }; wl(green("  ✓ Updated (not saved yet)")); await anyKey("Press any key to continue...");
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Fund transfers sub-menu
// ═══════════════════════════════════════════════════════════════════════════════
async function transferMenu(bKey, bSecret, bBase, cfg) {
  const MENU = ["List Sub-accounts & Balances", "Transfer Funds", "─", "Run Auto Transfer Rules", "Watch Mode (loop auto rules)", "─", "Back to Main Menu"];
  while (true) {
    const { label } = await fullMenu(MENU, 0, () => { drawBox("Fund Transfers — Broker Account"); wl(); });
    if (label === "Back to Main Menu")                   break;
    if (label === "List Sub-accounts & Balances")        await screenSubAccounts(bKey, bSecret, bBase, cfg);
    else if (label === "Transfer Funds")                 await screenTransfer(bKey, bSecret, bBase);
    else if (label === "Run Auto Transfer Rules")        await screenAutoRules(bKey, bSecret, bBase, cfg);
    else if (label === "Watch Mode (loop auto rules)")   { await screenWatchMode(bKey, bSecret, bBase, cfg); return; }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Entry point
// ═══════════════════════════════════════════════════════════════════════════════
async function main() {
  if (!process.stdin.isTTY) { console.error("Requires an interactive terminal. Run: node scripts/bot.mjs"); process.exit(1); }

  let cfg = loadConfig(CFG_PATH);

  if (!existsSync(CFG_PATH)) {
    console.log("\n  No config.json found. Quick setup:\n");
    const { createInterface } = await import("node:readline");
    const rl  = createInterface({ input: process.stdin, output: process.stdout });
    const ask = q => new Promise(r => rl.question(q, r));
    const key = (await ask("  Trading API Key:    ")).trim();
    const sec = (await ask("  Trading API Secret: ")).trim();
    rl.close();
    if (key && sec) {
      cfg = { ...cfg, trading: { apiKey: key, apiSecret: sec }, orderDefaults: { symbol: "BTCUSDT", totalUsdt: "2000", volPct: "12.5", step: "1" } };
      saveConfig(cfg, CFG_PATH);
      console.log(`\n  Saved to ${CFG_PATH}\n`);
    }
  }

  process.stdout.write("\n  Checking server IP...");
  const publicIp = await getPublicIp();
  process.stdout.write(`\r${CL}`);

  enterRaw();

  const getCtx = () => ({
    apiKey:    cfg?.trading?.apiKey    || "",
    apiSecret: cfg?.trading?.apiSecret || "",
    testnet:   false,
    defaults: {
      symbol:    cfg?.orderDefaults?.symbol    || "BTCUSDT",
      totalUsdt: cfg?.orderDefaults?.totalUsdt || "2000",
      volPct:    cfg?.orderDefaults?.volPct    || "12.5",
      step:      cfg?.orderDefaults?.step      || "1",
      anchor:    "",
    },
  });

  let lastIdx = 0;
  try {
    while (true) {
      const ctx      = getCtx();
      const cycleRunning = CYCLE && CYCLE.phase !== "stopped";
      const MAIN = [
        cycleRunning ? `View Active Session  ${green("● " + (CYCLE.symbol || ""))}` : "Start Bot Session",
        "─",
        "View Open Orders",
        "View Positions",
        "View Balance",
        "─",
        "Fund Transfers",
        "─",
        "Settings",
        "─",
        "Exit",
      ];

      const { index, label } = await fullMenu(MAIN, lastIdx, () => {
        drawBox("Binance Futures Bot");
        wl(`\n  Server IP: ${bold(publicIp)}  ${dim("(this IP is seen by Binance)")}`);
        if (!ctx.apiKey || !ctx.apiSecret) wl(`  ${yellow("⚠  Trading API keys not set — open Settings")}`);
        if (cycleRunning) wl(`  ${green("● Active:")} ${CYCLE.symbol} ${CYCLE.direction}  cycle#${CYCLE.cycleCount}  ${CYCLE.phase}`);
        wl();
      });
      lastIdx = index;

      if (label === "Exit") {
        if (cycleRunning) {
          const ok = await yesNo("A session is running. Stop it and cancel all orders before exit?");
          if (ok) await stopCycleWorker(true);
          else { wl(dim("  Exit cancelled — session still running.")); await anyKey(); continue; }
        }
        clr(); exitRaw(); break;
      }

      const lBase = label.startsWith("View Active Session") ? "View Active Session" : label;

      if      (lBase === "View Active Session")  await screenMonitor();
      else if (lBase === "Start Bot Session")    await screenNewSession(ctx);
      else if (label === "View Open Orders")     await screenOrders(ctx);
      else if (label === "View Positions")       await screenPositions(ctx);
      else if (label === "View Balance")         await screenBalance(ctx);
      else if (label === "Fund Transfers") {
        const bKey = cfg?.broker?.apiKey || "", bSecret = cfg?.broker?.apiSecret || "", bBase = cfg?.broker?.baseUrl || "https://api.binance.com";
        if (!bKey || !bSecret) { clr(); drawBox("Fund Transfers — Setup Required"); wl(yellow("\n  Broker API keys not set — open Settings.\n")); await anyKey(); }
        else await transferMenu(bKey, bSecret, bBase, cfg);
      }
      else if (label === "Settings") { cfg = await screenSettings(cfg, CFG_PATH); }
    }
  } finally { exitRaw(); }
}

main().catch(err => { exitRaw(); console.error(`\n  Fatal: ${err.message}\n`); process.exit(1); });
