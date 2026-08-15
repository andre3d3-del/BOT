#!/usr/bin/env node
/**
 * Binance Futures Bot — Start Session
 *
 * Places the entry LIMIT order directly to Binance (no proxy hop = fastest path),
 * then registers the TP cycle with the running proxy backend.
 *
 * The proxy handles everything after:
 *   entry fill → places all TP rows → each TP fill → re-entry @ anchor → repeat forever
 *
 * Interactive:   node scripts/place-order.mjs
 * CLI one-shot:  node scripts/place-order.mjs --symbol BTCUSDT --direction LONG \
 *                  --anchor 104000 --total 500 --vol-pct 12.5 --step 1
 *
 * Flags:
 *   --key / --secret    API credentials (or BINANCE_API_KEY/BINANCE_API_SECRET env)
 *   --symbol BTCUSDT    Trading pair
 *   --direction         LONG or SHORT
 *   --anchor 104000     Entry price AND the anchor every re-entry targets
 *   --total 500         Total USDT to buy (mutually exclusive with --base-qty)
 *   --base-qty 0.005    Entry qty in base asset (use instead of --total)
 *   --vol-pct 12.5      % of entry qty per TP level  →  12.5% = 8 levels
 *   --step 1            % price gap between consecutive TP levels
 *   --hedge             Hedge mode: sends positionSide LONG/SHORT on all orders
 *   --yes               Skip y/n confirmation
 *   --dry-run           Preview only — no orders submitted
 *   --proxy URL         Proxy URL (default: http://localhost:3001)
 *   --testnet           Use Binance USD-M testnet
 *   --config PATH       Config file (default: scripts/config.json)
 */

import { createHmac } from "node:crypto";
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));

// ═══════════════════════════════════════════════════════════════════════════════
// ANSI helpers
// ═══════════════════════════════════════════════════════════════════════════════

const R = "\x1b[0m";
const w = s => process.stdout.write(s);
const wl = (s = "") => process.stdout.write(s + "\n");
const clr = () => w("\x1b[2J\x1b[H");
const clearLine = "\x1b[2K\r";

const bold   = s => `\x1b[1m${s}${R}`;
const dim    = s => `\x1b[2m${s}${R}`;
const green  = s => `\x1b[32m${s}${R}`;
const red    = s => `\x1b[31m${s}${R}`;
const yellow = s => `\x1b[33m${s}${R}`;
const cyan   = s => `\x1b[36m${s}${R}`;
const white  = s => `\x1b[37m${s}${R}`;

// ═══════════════════════════════════════════════════════════════════════════════
// Strategy math — exact mirror of StrategyPanel.tsx + symbolFilters.ts
// ═══════════════════════════════════════════════════════════════════════════════

function roundToStep(value, step, mode = "floor") {
  const v = Number(value), s = Number(step);
  if (!(v > 0) || !(s > 0)) return "0";
  const decimals = Math.max(0, Math.ceil(-Math.log10(s)));
  const n = mode === "floor" ? Math.floor(v / s) * s : Math.round(v / s) * s;
  return n.toFixed(decimals);
}

function tpPriceFactor(direction, stepPct, level) {
  const move = (stepPct / 100) * level;
  return direction === "LONG" ? 1 + move : 1 - move;
}

function sidesForDirection(direction) {
  return direction === "LONG"
    ? { entrySide: "BUY", tpSide: "SELL" }
    : { entrySide: "SELL", tpSide: "BUY" };
}

/**
 * Computes the full session config: entry qty, TP rows, estimated P&L.
 * Uses the identical formula as StrategyPanel.tsx → splitTpPreview.
 */
function computeSession({ direction, anchor, totalUsdt, baseQty, volPct, step, tickSize, stepSize, hedgeMode }) {
  const anchorNum  = Number(anchor);
  const volPctNum  = Number(volPct);
  const stepNum    = Number(step);

  if (!(anchorNum > 0) || !(volPctNum > 0) || volPctNum > 100 || !(stepNum > 0)) return null;

  // Entry quantity
  let entryQty;
  if (Number(baseQty) > 0) {
    entryQty = Number(roundToStep(Number(baseQty), stepSize, "floor"));
  } else if (Number(totalUsdt) > 0) {
    entryQty = Number(roundToStep(Number(totalUsdt) / anchorNum, stepSize, "floor"));
  } else {
    return null;
  }
  if (!(entryQty > 0)) return null;

  // TP rows
  const levels  = Math.min(200, Math.max(1, Math.floor(100 / volPctNum)));
  const unitQty = Number(roundToStep(entryQty * (volPctNum / 100), stepSize, "floor"));
  if (!(unitQty > 0)) return null;

  const rows = [];
  for (let i = 1; i <= levels; i++) {
    const price = roundToStep(anchorNum * tpPriceFactor(direction, stepNum, i), tickSize, "round");
    if (!(Number(price) > 0)) continue;
    rows.push({ level: i, price, qty: unitQty, percent: volPctNum });
  }
  if (rows.length === 0) return null;

  const entryPrice = roundToStep(anchorNum, tickSize, "round");
  const entryQuote = Number(totalUsdt) > 0 ? Number(totalUsdt) : entryQty * anchorNum;

  // Estimated P&L across all TP levels
  let quoteOut = 0, usedQty = 0;
  for (const r of rows) { quoteOut += Number(r.price) * r.qty; usedQty += r.qty; }
  const profit = direction === "LONG"
    ? quoteOut - usedQty * anchorNum
    : usedQty * anchorNum - quoteOut;

  return {
    entryPrice,
    entryQty,
    entryQuote,
    rows,
    unitQty,
    positionSide: hedgeMode ? direction : undefined,
    profit,
    roi: entryQuote > 0 ? (profit / entryQuote) * 100 : 0,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Binance API
// ═══════════════════════════════════════════════════════════════════════════════

const FAPI      = "https://fapi.binance.com";
const FAPI_TEST = "https://testnet.binancefuture.com";

function binanceBase(testnet) { return testnet ? FAPI_TEST : FAPI; }

function clientOrderId() {
  return `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`.slice(0, 36);
}

async function callBinance(method, path, key, secret, params = {}, testnet = false) {
  const qs = Object.entries({ ...params, timestamp: Date.now() })
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
  const sig    = createHmac("sha256", secret).update(qs).digest("hex");
  const signed = `${qs}&signature=${sig}`;
  const base   = binanceBase(testnet);

  const url  = (method === "GET" || method === "DELETE") ? `${base}${path}?${signed}` : `${base}${path}`;
  const res  = await fetch(url, {
    method,
    headers: {
      "X-MBX-APIKEY": key,
      ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: method === "POST" ? signed : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    const err = new Error(data?.msg || text || res.statusText);
    err.code = data?.code;
    throw err;
  }
  return data;
}

async function fetchPublic(path, params = {}, testnet = false) {
  const qs  = Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => `${k}=${v}`).join("&");
  const url = `${binanceBase(testnet)}${path}${qs ? "?" + qs : ""}`;
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(text || res.statusText);
  return JSON.parse(text);
}

async function getFilters(symbol, testnet = false) {
  const info = await fetchPublic("/fapi/v1/exchangeInfo", {}, testnet);
  const sym  = (info.symbols || []).find(s => s.symbol === symbol);
  if (!sym) throw new Error(`Symbol ${symbol} not found on exchange`);
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

async function getPublicIp() {
  const sources = [
    () => fetch("https://api.ipify.org?format=json").then(r => r.json()).then(d => String(d.ip)),
    () => fetch("https://checkip.amazonaws.com/").then(r => r.text()).then(t => t.trim()),
    () => fetch("https://ifconfig.me/ip").then(r => r.text()).then(t => t.trim()),
  ];
  for (const fn of sources) {
    try { const ip = await fn(); if (ip && ip.includes(".")) return ip; } catch {}
  }
  return "unavailable";
}

// ═══════════════════════════════════════════════════════════════════════════════
// Proxy — cycle registration
// ═══════════════════════════════════════════════════════════════════════════════

async function registerCycle(proxyUrl, body) {
  const url = `${proxyUrl.replace(/\/$/, "")}/api/binance/cycle/start`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(data?.error || text || res.statusText);
  return data;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Config & args
// ═══════════════════════════════════════════════════════════════════════════════

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key  = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) { a[key] = next; i++; } else { a[key] = true; }
  }
  return a;
}

function loadConfig(p) {
  try { return JSON.parse(readFileSync(resolve(p), "utf8")); } catch { return {}; }
}

async function resolveCredentials(args, config) {
  let key    = args.key    || process.env.BINANCE_API_KEY    || config?.trading?.apiKey    || "";
  let secret = args.secret || process.env.BINANCE_API_SECRET || config?.trading?.apiSecret || "";
  if (!key || !secret) {
    if (!process.stdin.isTTY) { console.error("API credentials required (--key/--secret, env, or config.json)"); process.exit(1); }
    const rl  = createInterface({ input: process.stdin, output: process.stdout });
    const ask = q => new Promise(r => rl.question(q, r));
    if (!key)    key    = await ask("API Key: ");
    if (!secret) secret = await ask("API Secret: ");
    rl.close();
  }
  return { apiKey: key.trim(), apiSecret: secret.trim() };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Raw mode TUI helpers
// ═══════════════════════════════════════════════════════════════════════════════

let rawModeActive = false;

function enterRawMode() {
  if (!process.stdin.isTTY) throw new Error("Not a TTY");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  w("\x1b[?25l"); // hide cursor
  rawModeActive = true;
}

function exitRawMode() {
  if (!rawModeActive) return;
  try { process.stdin.setRawMode(false); } catch {}
  process.stdin.pause();
  w("\x1b[?25h"); // show cursor
  rawModeActive = false;
}

// Full-screen arrow-key menu (clears screen on each navigation)
async function fullMenu(items, initial = 0, headerFn = null) {
  const selectable = items.filter(x => x !== "─");
  let idx = Math.max(0, Math.min(initial, selectable.length - 1));

  const draw = () => {
    clr();
    if (headerFn) headerFn();
    for (const item of items) {
      if (item === "─") {
        wl(dim("  ────────────────────────────────────────────"));
      } else {
        const active = selectable[idx] === item;
        wl(active ? `  ${cyan("▶")} ${bold(item)}` : `  ${dim("  " + item)}`);
      }
    }
    wl();
    w(dim("  ↑↓ navigate   Enter select   Ctrl+C quit"));
  };

  return new Promise(res => {
    draw();
    const onData = k => {
      if (k === "\x03") { exitRawMode(); process.exit(0); }
      if (k === "\x1b[A") {
        idx = (idx - 1 + selectable.length) % selectable.length;
        draw();
      } else if (k === "\x1b[B") {
        idx = (idx + 1) % selectable.length;
        draw();
      } else if (k === "\r") {
        process.stdin.removeListener("data", onData);
        res({ index: idx, label: selectable[idx] });
      }
    };
    process.stdin.on("data", onData);
  });
}

// Inline 2-option menu — draws in place, redraws only the menu lines on navigation
async function inlineMenu(items, initial = 0) {
  const selectable = items.filter(x => x !== "─");
  let idx = Math.max(0, Math.min(initial, selectable.length - 1));

  const lines = items.length;

  const draw = (first) => {
    if (!first) w(`\x1b[${lines}A`); // move cursor up
    for (const item of items) {
      w(clearLine);
      if (item === "─") {
        wl(dim("  ────────────────────────────────────────────"));
      } else {
        const active = selectable[idx] === item;
        wl(active ? `  ${cyan("▶")} ${bold(item)}` : `  ${dim("  " + item)}`);
      }
    }
  };

  return new Promise(res => {
    draw(true);
    const onData = k => {
      if (k === "\x03") { exitRawMode(); process.exit(0); }
      if (k === "\x1b[A") { idx = (idx - 1 + selectable.length) % selectable.length; draw(false); }
      else if (k === "\x1b[B") { idx = (idx + 1) % selectable.length; draw(false); }
      else if (k === "\r") {
        process.stdin.removeListener("data", onData);
        wl();
        res({ index: idx, label: selectable[idx] });
      }
    };
    process.stdin.on("data", onData);
  });
}

// Single-line text input (raw mode) with optional default shown in dim
async function textInput(prompt, def = "") {
  let buf = "";
  let defShowing = !!def;
  w(`  ${bold(prompt)}: `);
  if (def) w(dim(def));

  return new Promise(res => {
    const onData = k => {
      if (k === "\x03") { exitRawMode(); process.exit(0); }
      if (k === "\r") {
        process.stdin.removeListener("data", onData);
        wl();
        res(buf || def);
        return;
      }
      if (k === "\x7f") { // backspace
        if (buf.length > 0) { buf = buf.slice(0, -1); w("\b \b"); }
        return;
      }
      // Printable ASCII
      if (k.charCodeAt(0) >= 32 && k.charCodeAt(0) < 127) {
        if (defShowing) { w("\b \b".repeat(def.length)); defShowing = false; }
        buf += k;
        w(k);
      }
    };
    process.stdin.on("data", onData);
  });
}

// Single y/n keypress
async function yesNo(prompt) {
  wl();
  w(`  ${bold(prompt)} ${dim("(y/n)")}: `);
  return new Promise(res => {
    const onData = k => {
      if (k === "\x03") { exitRawMode(); process.exit(0); }
      process.stdin.removeListener("data", onData);
      wl(k);
      res(k === "y" || k === "Y");
    };
    process.stdin.once("data", onData);
  });
}

// Wait for any key
async function anyKey(msg = "Press any key to return...") {
  wl();
  w(dim(`  ${msg}`));
  return new Promise(res => {
    const onData = k => {
      if (k === "\x03") { exitRawMode(); process.exit(0); }
      process.stdin.removeListener("data", onData);
      wl();
      res();
    };
    process.stdin.once("data", onData);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Drawing helpers
// ═══════════════════════════════════════════════════════════════════════════════

function drawBox(title, width = 48) {
  const inner = width - 2;
  const pad   = inner - title.length;
  wl(`  ${cyan("╔" + "═".repeat(inner) + "╗")}`);
  wl(`  ${cyan("║")}${" ".repeat(Math.floor(pad / 2))}${bold(title)}${" ".repeat(Math.ceil(pad / 2))}${cyan("║")}`);
  wl(`  ${cyan("╚" + "═".repeat(inner) + "╝")}`);
}

function drawTable(headers, rows, colWidths) {
  const top = "  ┌" + colWidths.map(n => "─".repeat(n + 2)).join("┬") + "┐";
  const mid = "  ├" + colWidths.map(n => "─".repeat(n + 2)).join("┼") + "┤";
  const bot = "  └" + colWidths.map(n => "─".repeat(n + 2)).join("┴") + "┘";
  const row = cells => "  │" + cells.map((c, i) => ` ${String(c).padEnd(colWidths[i])} `).join("│") + "│";
  wl(top);
  wl(row(headers));
  wl(mid);
  for (const r of rows) wl(row(r));
  wl(bot);
}

function drawPreview(symbol, direction, sess, proxyUrl, dryRun, hedgeMode) {
  const { entrySide, tpSide } = sidesForDirection(direction);
  const dirColor   = direction === "LONG" ? green : red;
  const entryColor = entrySide === "BUY" ? green : red;
  const ps = sess.profit >= 0 ? "+" : "";

  wl();
  wl(`  ${bold("Symbol")}:     ${white(symbol)}`);
  wl(`  ${bold("Direction")}: ${dirColor(direction)}`);
  wl(`  ${bold("Entry")}:     ${entryColor(entrySide)} ${white(String(sess.entryQty))} @ ${yellow(sess.entryPrice)}  = $${sess.entryQuote.toFixed(2)}`);
  wl(`  ${bold("Mode")}:      ${hedgeMode ? yellow("Hedge  (positionSide: " + direction + ")") : "One-Way (no positionSide)"}`);
  wl(`  ${bold("Proxy")}:     ${dim(proxyUrl)}`);
  if (dryRun) wl(`  ${yellow("⚠  DRY RUN — no orders will be submitted")}`);

  wl();
  wl(`  ${bold(`TP rows → ${tpSide} after entry fills`)} (${sess.rows.length} levels, re-entered at anchor on each fill)`);
  wl();

  drawTable(
    ["#", "Price", "Qty", "% Move", "USDT out"],
    sess.rows.map(r => {
      const pct  = (Number(r.price) / Number(sess.entryPrice) - 1) * 100;
      const sign = pct >= 0 ? "+" : "";
      const out  = (Number(r.price) * r.qty).toFixed(2);
      return [r.level, r.price, r.qty.toFixed(6), `${sign}${pct.toFixed(2)}%`, `$${out}`];
    }),
    [4, 14, 12, 8, 9]
  );

  wl();
  wl(`  ${bold("Est. profit / full cycle")}:    ${(sess.profit >= 0 ? green : red)(ps + "$" + sess.profit.toFixed(4) + "  (" + ps + sess.roi.toFixed(3) + "%)")}`);
  wl(`  ${bold("Est. profit / TP level")}:      ${(sess.profit >= 0 ? green : red)(ps + "$" + (sess.profit / sess.rows.length).toFixed(4))}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Core: place entry order + register cycle with proxy
// ═══════════════════════════════════════════════════════════════════════════════

function makeSessionId() {
  return `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function startSession({ apiKey, apiSecret, symbol, direction, sess, tickSize, stepSize, proxyUrl, dryRun, testnet }) {
  const { entrySide } = sidesForDirection(direction);
  const sessionId     = makeSessionId();

  wl();

  // ── Step 1: Place entry order directly to Binance ──────────────────────────
  w(`  ${dim("→")} Placing ${cyan(entrySide)} ${sess.entryQty} ${symbol} @ ${yellow(sess.entryPrice)}...`);

  let entryOrderId       = null;
  let actualPositionSide = sess.positionSide;

  if (!dryRun) {
    const t0 = Date.now();
    const orderParams = {
      symbol,
      side: entrySide,
      type: "LIMIT",
      timeInForce: "GTC",
      quantity: String(sess.entryQty),
      price: sess.entryPrice,
      positionSide: sess.positionSide,
      newClientOrderId: clientOrderId(),
    };
    try {
      const placed = await callBinance("POST", "/fapi/v1/order", apiKey, apiSecret, orderParams, testnet);
      entryOrderId = Number(placed?.orderId || 0) || null;
      wl(` ${green("✓")} #${entryOrderId}  ${dim("(" + (Date.now() - t0) + " ms)")}`);
    } catch (err) {
      if (err.code === -4061 && sess.positionSide) {
        // Account is in one-way mode but we sent positionSide — auto-retry without it
        wl(` ${yellow("⚠  one-way account — retrying without positionSide")}`);
        w(`  ${dim("→")} Retry...`);
        const { positionSide: _ignored, ...noPos } = orderParams;
        const placed = await callBinance("POST", "/fapi/v1/order", apiKey, apiSecret, noPos, testnet);
        entryOrderId       = Number(placed?.orderId || 0) || null;
        actualPositionSide = undefined;
        wl(` ${green("✓")} #${entryOrderId}  ${dim("(" + (Date.now() - t0) + " ms)")}`);
      } else {
        wl(` ${red("✗")} ${err.message}`);
        throw err;
      }
    }
  } else {
    wl(` ${yellow("[dry-run]")}`);
  }

  // ── Step 2: Register cycle with proxy ──────────────────────────────────────
  w(`  ${dim("→")} Registering cycle on proxy...`);

  if (!dryRun && entryOrderId) {
    try {
      await registerCycle(proxyUrl, {
        sessionId,
        apiKey,
        apiSecret,
        symbol,
        direction,
        anchorPrice: sess.entryPrice,
        stepSize: String(stepSize),
        tickSize: String(tickSize),
        entryOrderId,
        rows: sess.rows.map(r => ({ price: r.price, percent: r.percent })),
        positionSide: actualPositionSide,
      });
      wl(` ${green("✓")} ${dim(sessionId)}`);
    } catch (err) {
      wl(` ${yellow("⚠  " + err.message)}`);
      wl();
      wl(`  ${yellow("Entry order was placed (#" + entryOrderId + "), but the cycle worker could not")}`);
      wl(`  ${yellow("be registered on the proxy. The bot will NOT auto-run until restarted.")}`);
      wl(`  ${dim("Restart this session from the frontend dashboard (Restart button).")}`);
    }
  } else if (dryRun) {
    wl(` ${yellow("[dry-run]")}`);
  } else {
    wl(` ${yellow("[skipped — no entry order ID]")}`);
  }

  wl();
  wl(`  ${green("✓  Session:")} ${bold(sessionId)}`);
  wl(`  ${dim("Entry fill → TPs placed automatically → each TP fill → re-entry @ anchor → repeats")}`);

  return sessionId;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Interactive screens
// ═══════════════════════════════════════════════════════════════════════════════

async function screenNewSession(ctx) {
  const { apiKey, apiSecret, proxyUrl, dryRun, testnet, defaults } = ctx;

  // ── Symbol ─────────────────────────────────────────────────────────────────
  clr();
  drawBox("New Session — Configure Bot Cycle");
  wl(`\n  ${dim("Step 1 / 6 — Symbol")}\n`);
  const symbol = (await textInput("Symbol", defaults.symbol)).toUpperCase();

  // ── Direction ──────────────────────────────────────────────────────────────
  clr();
  drawBox("New Session — Configure Bot Cycle");
  wl(`\n  ${dim("Step 2 / 6 — Direction")}`);
  wl(`  Symbol: ${bold(symbol)}\n`);
  const { label: dirLabel } = await inlineMenu([
    "LONG  —  BUY entry,  SELL TPs above anchor  (profit when price rises → returns)",
    "SHORT —  SELL entry, BUY TPs below anchor   (profit when price falls → returns)",
  ], 0);
  const direction = dirLabel.startsWith("LONG") ? "LONG" : "SHORT";

  // ── Anchor price ───────────────────────────────────────────────────────────
  clr();
  drawBox("New Session — Configure Bot Cycle");
  wl(`\n  ${dim("Step 3 / 6 — Anchor Price (entry + re-entry target)")}`);
  wl(`  Symbol:    ${bold(symbol)}`);
  wl(`  Direction: ${direction === "LONG" ? green("LONG") : red("SHORT")}\n`);

  // Fetch mark price
  w(`  ${dim("Fetching mark price...")}`);
  const markStr = await getMarkPrice(symbol, testnet).catch(() => null);
  const markNum = markStr ? Number(markStr) : null;
  w(clearLine);

  const markHint = markNum
    ? `  ${dim("(mark: " + markNum.toLocaleString("en-US", { maximumFractionDigits: 4 }) + ")")}`
    : "";
  if (markHint) wl(markHint);

  const defAnchor = markNum ? String(Math.round(markNum)) : (defaults.anchor || "");
  const anchorStr = await textInput("Anchor price", defAnchor);
  if (!(Number(anchorStr) > 0)) {
    wl(red("\n  Invalid price.")); await anyKey(); return;
  }

  // ── Total USDT ─────────────────────────────────────────────────────────────
  clr();
  drawBox("New Session — Configure Bot Cycle");
  wl(`\n  ${dim("Step 4 / 6 — Position Size")}`);
  wl(`  Symbol:    ${bold(symbol)}`);
  wl(`  Direction: ${direction === "LONG" ? green("LONG") : red("SHORT")}`);
  wl(`  Anchor:    ${yellow(anchorStr)}\n`);
  wl(`  ${dim("Enter total in USDT  —OR—  press Enter for 0 then enter base qty.")}\n`);

  const totalStr = await textInput("Total USDT", defaults.totalUsdt);
  let baseQtyStr = "";
  if (!(Number(totalStr) > 0)) {
    wl();
    baseQtyStr = await textInput("Base qty (BTC / ETH etc)", "");
    if (!(Number(baseQtyStr) > 0)) {
      wl(red("\n  Need USDT total or base qty.")); await anyKey(); return;
    }
  }

  // ── Vol/TP% and Spacing% ───────────────────────────────────────────────────
  clr();
  drawBox("New Session — Configure Bot Cycle");
  wl(`\n  ${dim("Step 5 / 6 — TP Grid")}`);
  wl(`  Symbol:    ${bold(symbol)}`);
  wl(`  Direction: ${direction === "LONG" ? green("LONG") : red("SHORT")}`);
  wl(`  Anchor:    ${yellow(anchorStr)}`);
  wl(`  Size:      ${Number(totalStr) > 0 ? "$" + totalStr : baseQtyStr + " (base)"}\n`);
  wl(`  ${dim("Vol / TP level: % of entry qty per TP row  (12.5% → 8 rows, 10% → 10 rows)")}`);
  wl(`  ${dim("Spacing:        % price gap between each row")}\n`);

  const volPctStr = await textInput("Vol per TP level (%)", defaults.volPct);
  wl();
  const stepStr   = await textInput("Spacing between TPs (%)", defaults.step);

  // ── Position mode ──────────────────────────────────────────────────────────
  clr();
  drawBox("New Session — Configure Bot Cycle");
  wl(`\n  ${dim("Step 6 / 6 — Position Mode")}`);
  wl(`  Symbol:    ${bold(symbol)}`);
  wl(`  Direction: ${direction === "LONG" ? green("LONG") : red("SHORT")}`);
  wl(`  Anchor:    ${yellow(anchorStr)}`);
  wl(`  Grid:      ${volPctStr}% / TP,  ${stepStr}% spacing\n`);

  const { index: modeIdx } = await inlineMenu([
    "One-Way mode  —  no positionSide sent  (most accounts)",
    "Hedge mode    —  sends positionSide LONG or SHORT  (advanced)",
  ], 0);
  const hedgeMode = modeIdx === 1;

  // ── Fetch exchange filters ─────────────────────────────────────────────────
  clr();
  drawBox("New Session — Fetching Filters");
  w(`\n  Fetching exchange filters for ${bold(symbol)}...`);
  let tickSize, stepSize;
  try {
    ({ tickSize, stepSize } = await getFilters(symbol, testnet));
    wl(` ${green("✓")}  tick=${tickSize}  step=${stepSize}`);
  } catch (err) {
    wl(` ${red("✗")} ${err.message}`);
    await anyKey();
    return;
  }

  // ── Compute session ────────────────────────────────────────────────────────
  const sess = computeSession({
    direction, anchor: anchorStr,
    totalUsdt: totalStr, baseQty: baseQtyStr,
    volPct: volPctStr, step: stepStr,
    tickSize, stepSize, hedgeMode,
  });
  if (!sess) {
    wl(red("\n  Could not compute session — check inputs (entry qty too small, vol% out of range, etc.)"));
    await anyKey();
    return;
  }

  // ── Preview ────────────────────────────────────────────────────────────────
  clr();
  drawBox("New Session — Preview & Confirm");
  drawPreview(symbol, direction, sess, proxyUrl, dryRun, hedgeMode);

  const ok = await yesNo("Start this session?");
  if (!ok) { wl(dim("\n  Cancelled.")); await anyKey(); return; }

  clr();
  drawBox("New Session — Starting");

  try {
    await startSession({ apiKey, apiSecret, symbol, direction, sess, tickSize, stepSize, proxyUrl, dryRun, testnet });
  } catch (err) {
    wl(`\n  ${red("✗")} ${err.message}`);
  }

  await anyKey("Done. Press any key to return to menu...");
}

async function screenOrders(ctx) {
  const { apiKey, apiSecret, symbol, testnet } = ctx;
  clr(); drawBox(`Open Orders — ${symbol}`);
  w("\n  Loading...");
  try {
    const orders = await callBinance("GET", "/fapi/v1/openOrders", apiKey, apiSecret, { symbol }, testnet);
    w(clearLine);
    if (!orders?.length) {
      wl(dim("\n  No open orders."));
    } else {
      wl();
      drawTable(
        ["Order ID", "Side", "Price", "Qty", "Filled/Total", "PosSide"],
        orders.map(o => [o.orderId, o.side, o.price, o.origQty, `${o.executedQty}/${o.origQty}`, o.positionSide || "BOTH"]),
        [13, 5, 12, 10, 13, 7]
      );
    }
  } catch (err) {
    w(clearLine); wl(red(`\n  Error: ${err.message}`));
  }
  await anyKey();
}

async function screenPositions(ctx) {
  const { apiKey, apiSecret, symbol, testnet } = ctx;
  clr(); drawBox(`Positions — ${symbol}`);
  w("\n  Loading...");
  try {
    const all    = await callBinance("GET", "/fapi/v2/positionRisk", apiKey, apiSecret, { symbol }, testnet);
    const active = (all || []).filter(p => Math.abs(Number(p.positionAmt)) > 0);
    w(clearLine);
    if (!active.length) {
      wl(dim("\n  No open positions."));
    } else {
      wl();
      drawTable(
        ["Symbol", "Side", "Amt", "Entry", "Mark", "PnL"],
        active.map(p => {
          const pnl = Number(p.unrealizedProfit);
          return [p.symbol, p.positionSide || (Number(p.positionAmt) > 0 ? "LONG" : "SHORT"),
            Math.abs(Number(p.positionAmt)), p.entryPrice, p.markPrice,
            (pnl >= 0 ? "+" : "") + pnl.toFixed(4)];
        }),
        [10, 6, 10, 12, 12, 12]
      );
    }
  } catch (err) {
    w(clearLine); wl(red(`\n  Error: ${err.message}`));
  }
  await anyKey();
}

async function screenBalance(ctx) {
  const { apiKey, apiSecret, testnet } = ctx;
  clr(); drawBox("Account Balance");
  w("\n  Loading...");
  try {
    const acct = await callBinance("GET", "/fapi/v2/account", apiKey, apiSecret, {}, testnet);
    w(clearLine); wl();
    const usdt = (acct.assets || []).find(a => a.asset === "USDT");
    if (!usdt) { wl(dim("  No USDT balance.")); }
    else {
      const pnl = Number(acct.totalUnrealizedProfit || 0);
      wl(`  ${bold("Wallet Balance")}:   ${white("$" + Number(usdt.walletBalance).toFixed(2))}`);
      wl(`  ${bold("Available")}:        ${green("$" + Number(usdt.availableBalance).toFixed(2))}`);
      wl(`  ${bold("Margin Balance")}:   ${white("$" + Number(acct.totalMarginBalance || 0).toFixed(2))}`);
      wl(`  ${bold("Unrealized PnL")}:   ${(pnl >= 0 ? green : red)((pnl >= 0 ? "+" : "") + "$" + pnl.toFixed(4))}`);
    }
  } catch (err) {
    w(clearLine); wl(red(`\n  Error: ${err.message}`));
  }
  await anyKey();
}

// ═══════════════════════════════════════════════════════════════════════════════
// Interactive main loop
// ═══════════════════════════════════════════════════════════════════════════════

async function runInteractive(opts) {
  const { apiKey, apiSecret, proxyUrl, dryRun, testnet, defaults } = opts;
  const symbol = defaults.symbol.toUpperCase();

  // Fetch public IP before entering raw mode so fetch can complete normally
  w(`\n  Checking server IP...`);
  const publicIp = await getPublicIp();
  w(clearLine);

  enterRawMode();
  process.on("SIGINT", () => { exitRawMode(); process.exit(0); });

  const MENU = [
    "Start New Session",
    "─",
    "View Open Orders",
    "View Positions",
    "View Balance",
    "─",
    "Exit",
  ];

  let lastIdx = 0;
  try {
    while (true) {
      const { index, label } = await fullMenu(MENU, lastIdx, () => {
        drawBox("Binance Futures Bot — Session Manager");
        wl(`\n  Trading: ${bold(symbol)}   Proxy: ${dim(proxyUrl)}`);
        wl(`  Server IP: ${bold(publicIp)}  ${dim("(this IP is seen by Binance)")}`);
        if (dryRun) wl(`  ${yellow("DRY RUN mode active")}`);
        wl();
      });
      lastIdx = index;

      if (label === "Exit")                { clr(); exitRawMode(); break; }
      if (label === "Start New Session")   await screenNewSession({ apiKey, apiSecret, proxyUrl, dryRun, testnet, defaults });
      else if (label === "View Open Orders") await screenOrders({ apiKey, apiSecret, symbol, testnet });
      else if (label === "View Positions")   await screenPositions({ apiKey, apiSecret, symbol, testnet });
      else if (label === "View Balance")     await screenBalance({ apiKey, apiSecret, testnet });
    }
  } finally {
    exitRawMode();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLI one-shot mode
// ═══════════════════════════════════════════════════════════════════════════════

async function runCli(args, opts) {
  const { apiKey, apiSecret, proxyUrl, dryRun, testnet } = opts;

  const symbol    = (args.symbol || "").toUpperCase();
  const direction = (args.direction || "").toUpperCase();
  const anchor    = args.anchor;
  const totalUsdt = args.total;
  const baseQty   = args["base-qty"];
  const volPct    = args["vol-pct"] || "12.5";
  const step      = args.step      || "1";
  const hedgeMode = !!args.hedge;

  if (!symbol)                               { console.error("Error: --symbol required");                       process.exit(1); }
  if (direction !== "LONG" && direction !== "SHORT") { console.error("Error: --direction must be LONG or SHORT"); process.exit(1); }
  if (!(Number(anchor) > 0))                { console.error("Error: --anchor must be a positive number");       process.exit(1); }
  if (!(Number(totalUsdt) > 0) && !(Number(baseQty) > 0)) { console.error("Error: --total or --base-qty required"); process.exit(1); }

  // Show server IP before any Binance calls so the user can identify geo-block issues
  process.stdout.write("Checking server IP...");
  const publicIp = await getPublicIp();
  console.log(`\r  Server IP: ${publicIp}  (this IP is used for all Binance requests)`);
  if (publicIp === "unavailable") console.log(`  Warning: could not determine public IP`);

  console.log(`\nFetching filters for ${symbol}...`);
  const { tickSize, stepSize } = await getFilters(symbol, testnet);
  console.log(`  tick=${tickSize}  step=${stepSize}`);

  const sess = computeSession({ direction, anchor, totalUsdt, baseQty, volPct, step, tickSize, stepSize, hedgeMode });
  if (!sess) { console.error("Error: Could not compute session — check inputs."); process.exit(1); }

  const { entrySide, tpSide } = sidesForDirection(direction);
  const ps = sess.profit >= 0 ? "+" : "";

  console.log(`\n── Session Preview ────────────────────────────────────────`);
  console.log(`  Symbol:    ${symbol}  (${direction})`);
  console.log(`  Entry:     ${entrySide} ${sess.entryQty} @ ${sess.entryPrice}  = $${sess.entryQuote.toFixed(2)}`);
  console.log(`  Mode:      ${hedgeMode ? "Hedge (positionSide: " + direction + ")" : "One-Way (no positionSide)"}`);
  console.log(`  Proxy:     ${proxyUrl}`);
  console.log(`\n  TP rows → ${tpSide} after entry fills (${sess.rows.length} levels, cycle re-enters @ anchor):`);
  console.log(`  ${"#".padEnd(4)} ${"Price".padEnd(14)} ${"Qty".padEnd(12)} ${"Move".padEnd(9)} USDT out`);
  console.log(`  ${"─".repeat(52)}`);
  for (const r of sess.rows) {
    const pct  = (Number(r.price) / Number(sess.entryPrice) - 1) * 100;
    const sign = pct >= 0 ? "+" : "";
    const out  = (Number(r.price) * r.qty).toFixed(2);
    console.log(`  ${String(r.level).padEnd(4)} ${r.price.padEnd(14)} ${r.qty.toFixed(6).padEnd(12)} ${(sign + pct.toFixed(2) + "%").padEnd(9)} $${out}`);
  }
  console.log(`  ${"─".repeat(52)}`);
  console.log(`  Est. profit / cycle:    ${ps}$${sess.profit.toFixed(4)}  (${ps}${sess.roi.toFixed(3)}%)`);
  console.log(`  Est. profit / TP level: ${ps}$${(sess.profit / sess.rows.length).toFixed(4)}`);

  if (dryRun) { console.log(`\n  DRY RUN — nothing submitted.\n`); return; }

  if (!args.yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ok = await new Promise(res => rl.question("\nStart this session? (y/n): ", a => { rl.close(); res(a.toLowerCase().trim() === "y"); }));
    if (!ok) { console.log("Cancelled."); return; }
  }

  console.log();
  try {
    await startSession({ apiKey, apiSecret, symbol, direction, sess, tickSize, stepSize, proxyUrl, dryRun, testnet });
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Entry point
// ═══════════════════════════════════════════════════════════════════════════════

const args     = parseArgs(process.argv.slice(2));
const cfgPath  = args.config || resolve(__dir, "config.json");
const cfg      = loadConfig(cfgPath);

const { apiKey, apiSecret } = await resolveCredentials(args, cfg);
const proxyUrl  = args.proxy   || cfg.proxyUrl   || "http://localhost:3001";
const dryRun    = !!args["dry-run"];
const testnet   = !!args.testnet;
const isCli     = !!(args.symbol || args.direction || args.anchor);

if (isCli) {
  await runCli(args, { apiKey, apiSecret, proxyUrl, dryRun, testnet }).catch(err => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
} else if (process.stdin.isTTY) {
  const defaults = {
    symbol:    cfg?.orderDefaults?.symbol    || "BTCUSDT",
    totalUsdt: cfg?.orderDefaults?.totalUsdt || "500",
    volPct:    cfg?.orderDefaults?.volPct    || "12.5",
    step:      cfg?.orderDefaults?.step      || "1",
    anchor:    "",
  };
  await runInteractive({ apiKey, apiSecret, proxyUrl, dryRun, testnet, defaults });
} else {
  console.error("No flags provided and not a TTY. Pass --symbol --direction --anchor --total flags, or run interactively.");
  process.exit(1);
}
