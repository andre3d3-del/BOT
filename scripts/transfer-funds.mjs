#!/usr/bin/env node
/**
 * Binance Exchange Link — Sub-account Funds Transfer
 *
 * Interactive mode (no args):   node scripts/transfer-funds.mjs
 * CLI one-shot mode examples:
 *   node scripts/transfer-funds.mjs --list
 *   node scripts/transfer-funds.mjs --from sub1@ex.com --to sub2@ex.com --amount 100
 *   node scripts/transfer-funds.mjs --from sub1@ex.com --to master --amount 500
 *   node scripts/transfer-funds.mjs --auto
 *   node scripts/transfer-funds.mjs --watch --interval 60
 *
 * Flags:
 *   --key / --secret    Broker API credentials  (or BINANCE_BROKER_API_KEY / SECRET env)
 *   --from              Source sub-account email/ID, or "master"
 *   --to                Destination sub-account email/ID, or "master"
 *   --asset USDT        Asset to transfer (default: USDT)
 *   --amount N          Amount
 *   --futures-type 1    1 = USDT-M (default), 2 = COIN-M
 *   --list              List sub-accounts with balances
 *   --auto              Run transferRules from config.json once
 *   --watch             Loop --auto every --interval seconds
 *   --interval 60       Seconds between watch cycles (default: 60)
 *   --dry-run           Preview only, no submission
 *   --yes               Skip confirmation
 *   --config PATH       Config file path (default: scripts/config.json)
 */

import crypto from "node:crypto";
import readline from "node:readline";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));

// ── ANSI ──────────────────────────────────────────────────────────────────────
const R   = "\x1b[0m";
const esc = (n) => `\x1b[${n}m`;
const bold   = (s) => `${esc(1)}${s}${R}`;
const dim    = (s) => `${esc(2)}${s}${R}`;
const green  = (s) => `${esc(32)}${s}${R}`;
const red    = (s) => `${esc(31)}${s}${R}`;
const yellow = (s) => `${esc(33)}${s}${R}`;
const cyan   = (s) => `${esc(36)}${s}${R}`;
const stripA = (s) => String(s).replace(/\x1b\[[^m]*m/g, "");

const CLS        = "\x1b[2J\x1b[H";
const UP         = (n) => `\x1b[${n}A`;
const CLEAR_LINE = "\x1b[2K\r";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

// ── CLI args ──────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const k = argv[i].slice(2);
    const v = argv[i + 1];
    if (!v || v.startsWith("--")) { a[k] = true; }
    else { a[k] = v; i++; }
  }
  return a;
}

// ── Config ────────────────────────────────────────────────────────────────────
function loadConfig(path) {
  const p = resolve(path || join(__dir, "config.json"));
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, "utf-8")); }
  catch { return {}; }
}

// ── Binance SAPI signed request ───────────────────────────────────────────────
async function callBinance({ method, path, apiKey, apiSecret, params = {}, baseUrl }) {
  const p = { ...params, recvWindow: "10000", timestamp: String(Date.now()) };
  for (const k of Object.keys(p)) { if (p[k] == null) delete p[k]; }
  const qs  = new URLSearchParams(p).toString();
  const sig = crypto.createHmac("sha256", apiSecret).update(qs).digest("hex");

  let url, body, headers = { "X-MBX-APIKEY": apiKey };
  if (method === "POST") {
    url  = `${baseUrl}${path}`;
    body = `${qs}&signature=${sig}`;
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  } else {
    url  = `${baseUrl}${path}?${qs}&signature=${sig}`;
  }
  const res  = await fetch(url, { method, headers, body });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { msg: text }; }
  if (!res.ok) {
    const msg = data?.msg || text;
    const err = new Error(msg);
    err.binanceCode = data?.code ? Number(data.code) : undefined;
    throw err;
  }
  return data;
}

// ── Number formatting ─────────────────────────────────────────────────────────
const fmt = (n, d = 4) => {
  const num = Number(n);
  if (!Number.isFinite(num)) return dim("—");
  return num.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
};

// ── Box table ─────────────────────────────────────────────────────────────────
function drawKV(rows, title) {
  if (!rows.length) return "";
  const w0 = Math.max(...rows.map(([k]) => stripA(k).length)) + 2;
  const w1 = Math.max(...rows.map(([, v]) => stripA(v).length)) + 2;
  const hor = (l, m, r) => `${l}${"─".repeat(w0)}${m}${"─".repeat(w1)}${r}`;
  const lines = [];
  if (title) {
    const total = w0 + w1 + 1;
    const t = ` ${title} `;
    const pad = Math.max(0, total - stripA(t).length);
    lines.push(`┌${"─".repeat(Math.floor(pad/2))}${t}${"─".repeat(Math.ceil(pad/2))}┐`);
  } else { lines.push(hor("┌", "┬", "┐")); }
  rows.forEach(([k, v], i) => {
    const kp = " ".repeat(w0 - stripA(k).length - 1);
    const vp = " ".repeat(w1 - stripA(v).length - 1);
    lines.push(`│ ${k}${kp}│ ${v}${vp}│`);
    if (i < rows.length - 1) lines.push(hor("├", "┼", "┤"));
  });
  lines.push(hor("└", "┴", "┘"));
  return lines.map((l) => `  ${l}`).join("\n");
}

function drawGrid(cols, rows, title) {
  const widths = cols.map((c, ci) =>
    Math.max(stripA(c).length, ...rows.map((r) => stripA(String(r[ci] ?? "")).length)) + 2
  );
  const hline = (lc, mc, rc) =>
    `  ${lc}${widths.map((w) => "─".repeat(w)).join(mc)}${rc}`;
  const row2str = (cells) =>
    `  │${cells.map((v, ci) => {
      const s = String(v ?? ""); const p = widths[ci] - stripA(s).length - 1;
      return ` ${s}${" ".repeat(Math.max(0, p))}│`;
    }).join("")}`;

  const total = widths.reduce((a, b) => a + b, 0) + widths.length - 1;
  const lines = [];
  if (title) {
    const t = ` ${title} `;
    const pad = Math.max(0, total - stripA(t).length);
    lines.push(`  ┌${"─".repeat(Math.floor(pad/2))}${t}${"─".repeat(Math.ceil(pad/2))}${"─".repeat(widths.length - 1)}┐`);
  } else { lines.push(hline("┌", "┬", "┐")); }
  lines.push(row2str(cols.map((c) => bold(c))));
  lines.push(hline("├", "┼", "┤"));
  if (!rows.length) {
    lines.push(`  │${" ".repeat(total)}│`);
  } else {
    rows.forEach((r, i) => {
      lines.push(row2str(r));
      if (i < rows.length - 1) lines.push(hline("├", "┼", "┤"));
    });
  }
  lines.push(hline("└", "┴", "┘"));
  return lines.join("\n");
}

// ── Terminal / TUI helpers ────────────────────────────────────────────────────
let rawModeActive = false;
function enterRaw() {
  if (!process.stdin.isTTY) return;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdout.write(HIDE_CURSOR);
  rawModeActive = true;
}
function exitRaw() {
  if (!rawModeActive) return;
  try { process.stdin.setRawMode(false); } catch {}
  process.stdout.write(SHOW_CURSOR);
  rawModeActive = false;
}
function cleanExit(code = 0) { exitRaw(); process.stdout.write(SHOW_CURSOR + "\n"); process.exit(code); }
process.on("SIGINT", () => cleanExit(0));
process.on("exit", exitRaw);

function selectMenu(items, opts = {}) {
  return new Promise((resolve) => {
    let sel = opts.initial ?? 0;
    const label = opts.label ?? "";
    const hint  = dim("  ↑↓ navigate   Enter select   Ctrl+C quit");
    function render(first) {
      if (!first) process.stdout.write(UP(items.length + (label ? 2 : 1)));
      if (label) process.stdout.write(`${CLEAR_LINE}${label}\n`);
      items.forEach((item, i) => {
        const isDiv = typeof item === "string" && item.startsWith("─");
        if (isDiv) {
          process.stdout.write(`${CLEAR_LINE}  ${dim(item)}\n`);
        } else {
          const marker = i === sel ? cyan("▶") : " ";
          const text   = i === sel ? bold(String(item)) : String(item);
          process.stdout.write(`${CLEAR_LINE}  ${marker} ${text}\n`);
        }
      });
      process.stdout.write(`${CLEAR_LINE}${hint}\n`);
    }
    render(true);
    const onKey = (key) => {
      if (key === "\x03") { process.stdin.off("data", onKey); cleanExit(0); }
      if (key === "\x1B[A") {
        let next = sel - 1;
        while (next >= 0 && typeof items[next] === "string" && items[next].startsWith("─")) next--;
        if (next >= 0) { sel = next; render(false); }
      } else if (key === "\x1B[B") {
        let next = sel + 1;
        while (next < items.length && typeof items[next] === "string" && items[next].startsWith("─")) next++;
        if (next < items.length) { sel = next; render(false); }
      } else if (key === "\r") {
        process.stdin.off("data", onKey); resolve(sel);
      }
    };
    process.stdin.on("data", onKey);
  });
}

function rawInput(promptStr, opts = {}) {
  return new Promise((resolve) => {
    let value = String(opts.default ?? "");
    const def  = opts.default != null ? dim(` [${opts.default}]`) : "";
    process.stdout.write(`${promptStr}${def}: ${value}`);
    const onKey = (key) => {
      if (key === "\x03") { process.stdin.off("data", onKey); cleanExit(0); }
      if (key === "\r") {
        process.stdout.write("\n"); process.stdin.off("data", onKey);
        resolve(value || String(opts.default ?? ""));
      } else if (key === "\x7f" || key === "\b") {
        if (value.length > 0) { value = value.slice(0, -1); process.stdout.write("\b \b"); }
      } else if (key >= " ") { value += key; process.stdout.write(key); }
    };
    process.stdin.on("data", onKey);
  });
}

function rawConfirm(promptStr) {
  return new Promise((resolve) => {
    process.stdout.write(`${promptStr} (y/n): `);
    const onKey = (key) => {
      if (key === "\x03") { process.stdin.off("data", onKey); cleanExit(0); }
      if (key === "y" || key === "Y") {
        process.stdout.write("y\n"); process.stdin.off("data", onKey); resolve(true);
      } else if (key === "n" || key === "N" || key === "\x1B") {
        process.stdout.write("n\n"); process.stdin.off("data", onKey); resolve(false);
      }
    };
    process.stdin.on("data", onKey);
  });
}

function anyKey(msg = dim("  Press any key to go back…")) {
  return new Promise((resolve) => {
    process.stdout.write(`\n${msg}`);
    const onKey = (key) => {
      if (key === "\x03") { process.stdin.off("data", onKey); cleanExit(0); }
      process.stdout.write("\n"); process.stdin.off("data", onKey); resolve();
    };
    process.stdin.on("data", onKey);
  });
}

// ── Header ────────────────────────────────────────────────────────────────────
function printHeader(title) {
  const w = Math.max(40, stripA(title).length + 4);
  console.log();
  console.log(bold(`  ╔${"═".repeat(w)}╗`));
  console.log(bold(`  ║  ${title}${" ".repeat(w - stripA(title).length - 2)}║`));
  console.log(bold(`  ╚${"═".repeat(w)}╝`));
  console.log();
}

// ── Sleep ─────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── API: list sub-accounts ────────────────────────────────────────────────────
async function listSubAccounts(creds) {
  const data = await callBinance({
    method: "GET", path: "/sapi/v1/broker/subAccount", ...creds, params: { page: 1, size: 200 },
  });
  return Array.isArray(data) ? data : (data?.subAccounts ?? []);
}

// ── API: sub-account futures balance ─────────────────────────────────────────
async function getSubBalance(creds, subAccountId, futuresType = 1) {
  try {
    const data = await callBinance({
      method: "GET", path: "/sapi/v1/broker/subAccount/futuresSummary",
      ...creds, params: { subAccountId, futuresType },
    });
    const s = data?.futuresSummary?.[0] ?? data?.summary?.[0] ?? data ?? {};
    return {
      total:     s.totalWalletBalance ?? s.walletBalance ?? "0",
      available: s.availableBalance   ?? s.maxWithdrawAmount ?? "0",
      asset:     s.asset ?? (futuresType === 1 ? "USDT" : "BTC"),
    };
  } catch {
    return { total: "—", available: "—", asset: futuresType === 1 ? "USDT" : "BTC" };
  }
}

// ── API: transfer ─────────────────────────────────────────────────────────────
/**
 * Exchange Link endpoint: POST /sapi/v1/broker/futures/transfer
 * - fromSubAccountId  (omit = broker master is source)
 * - toSubAccountId    (omit = broker master is destination)
 * - asset, amount, futuresType, clientTranId
 *
 * Update TRANSFER_PATH below if your account uses a different endpoint.
 */
const TRANSFER_PATH = "/sapi/v1/broker/futures/transfer";

async function doTransfer(creds, { from, to, asset, amount, futuresType, clientTranId }) {
  const isMaster = (id) => !id || String(id).toLowerCase() === "master";
  const params = {
    asset,
    amount:      String(amount),
    futuresType: String(futuresType || 1),
    ...(clientTranId ? { clientTranId } : {}),
    ...(!isMaster(from) ? { fromSubAccountId: from } : {}),
    ...(!isMaster(to)   ? { toSubAccountId:   to   } : {}),
  };
  return callBinance({ method: "POST", path: TRANSFER_PATH, ...creds, params });
}

// ── Screen: Sub-account List ──────────────────────────────────────────────────
async function screenList(creds, cfg, futuresType) {
  while (true) {
    process.stdout.write(CLS);
    printHeader("Sub-account Balances");
    process.stdout.write("  Fetching sub-accounts…");

    try {
      const accounts = await listSubAccounts(creds);
      process.stdout.write(`\r${CLEAR_LINE}`);

      if (!accounts.length) {
        console.log(dim("  No sub-accounts found.\n"));
      } else {
        const labelMap = Object.fromEntries(
          (cfg.subAccounts ?? []).map((s) => [String(s.id ?? s.email ?? ""), s.label ?? ""])
        );

        process.stdout.write(`  Fetching balances (${accounts.length} accounts)…`);
        const rows = [];
        for (let i = 0; i < accounts.length; i++) {
          const acc   = accounts[i];
          const id    = String(acc.subAccountId ?? acc.email ?? "");
          const email = String(acc.email ?? "—");
          const label = labelMap[id] || labelMap[email] || "";
          const bal   = await getSubBalance(creds, id, futuresType);
          rows.push([
            label ? cyan(label) : dim(id.slice(0, 20)),
            dim(email),
            `${fmt(bal.total, 2)} ${bal.asset}`,
            `${fmt(bal.available, 2)} ${bal.asset}`,
            dim(id),
          ]);
          process.stdout.write(`\r  Fetching balances… ${i + 1}/${accounts.length}`);
        }
        process.stdout.write(`\r${CLEAR_LINE}`);
        console.log(drawGrid(
          ["Label", "Email", "Total Balance", "Available", "Sub-account ID"],
          rows,
          `USDT-M Futures Balances (${accounts.length} accounts)`
        ));
      }
    } catch (err) {
      process.stdout.write(`\r${CLEAR_LINE}`);
      console.error(red(`  ✗ ${err.message}\n`));
    }

    console.log();
    console.log(dim("  r = refresh   b = back to menu   Ctrl+C = quit"));
    const key = await new Promise((res) => {
      const onKey = (k) => {
        if (k === "\x03") { process.stdin.off("data", onKey); cleanExit(0); }
        process.stdin.off("data", onKey); res(k);
      };
      process.stdin.on("data", onKey);
    });
    if (key !== "r" && key !== "R") break;
  }
}

// ── Transfer helper (shared by interactive + auto modes) ─────────────────────
async function execTransfer(creds, { from, to, asset, amount, futuresType, skipConfirm, dryRun }) {
  const isMaster = (id) => !id || String(id).toLowerCase() === "master";
  const ftLabel  = futuresType === 2 ? "COIN-M" : "USDT-M";

  console.log();
  console.log(drawKV([
    [dim("From"),         isMaster(from) ? bold("master") : from],
    [dim("To"),           isMaster(to)   ? bold("master") : to],
    [dim("Asset"),        bold(asset)],
    [dim("Amount"),       bold(`${fmt(amount, 4)} ${asset}`)],
    [dim("Futures Type"), ftLabel],
  ], dryRun ? "Transfer Preview [DRY RUN]" : "Transfer Preview"));
  console.log();

  if (dryRun) { console.log(cyan("  Dry run — not submitted.\n")); return { dryRun: true }; }

  let confirmed = skipConfirm;
  if (!skipConfirm) {
    confirmed = await rawConfirm("  Confirm transfer?");
    if (!confirmed) { console.log(yellow("  Cancelled.\n")); return { cancelled: true }; }
  }

  process.stdout.write("  Submitting…");
  const t0 = Date.now();
  const clientTranId = `tf${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const result = await doTransfer(creds, { from, to, asset, amount, futuresType, clientTranId });
  const ms = Date.now() - t0;

  process.stdout.write(`\r  ${green("✓")} Transfer submitted! ${dim(`(${ms} ms)`)}\n\n`);
  console.log(drawKV([
    [dim("TxID"),    bold(String(result.txnId ?? result.tranId ?? result.id ?? "—"))],
    [dim("Asset"),   asset],
    [dim("Amount"),  fmt(amount, 4)],
  ], "Transfer Result"));
  return result;
}

// ── Screen: Transfer (interactive) ───────────────────────────────────────────
async function screenTransfer(creds) {
  process.stdout.write(CLS);
  printHeader("Transfer Funds");
  console.log(dim("  Fill in transfer details (Enter = keep default)\n"));
  console.log(dim("  Use 'master' for the broker/master account.\n"));

  const from        = (await rawInput("  From (email or 'master')", { default: "" })).trim();
  const to          = (await rawInput("  To   (email or 'master')", { default: "" })).trim();
  const asset       = (await rawInput("  Asset", { default: "USDT" })).trim().toUpperCase() || "USDT";
  const amountStr   = (await rawInput("  Amount", { default: "" })).trim();
  const ftStr       = (await rawInput("  Futures Type (1=USDT-M, 2=COIN-M)", { default: "1" })).trim();
  const futuresType = Number(ftStr) === 2 ? 2 : 1;
  const amount      = Number(amountStr);

  if (!from && !to) { console.error(red("\n  ✗ At least one of From/To must be specified.\n")); await anyKey(); return; }
  if (amount <= 0)  { console.error(red("\n  ✗ Amount must be > 0.\n")); await anyKey(); return; }
  if (from.toLowerCase() === to.toLowerCase()) {
    console.error(red("\n  ✗ From and To cannot be the same.\n")); await anyKey(); return;
  }

  try {
    await execTransfer(creds, { from, to, asset, amount, futuresType, skipConfirm: false, dryRun: false });
  } catch (err) {
    console.error(red(`\n  ✗ Transfer failed: ${err.message}`));
    if (err.binanceCode) console.error(dim(`    Code: ${err.binanceCode}`));
    console.log();
  }
  await anyKey();
}

// ── Auto mode (runs configured rules) ────────────────────────────────────────
async function runAutoRules(creds, cfg, futuresType, { dryRun, skipConfirm }) {
  const rules = (cfg.transferRules ?? []).filter((r) => r.enabled !== false);
  if (!rules.length) {
    console.log(yellow("  No enabled transferRules in config.json\n")); return;
  }
  console.log(dim(`\n  Processing ${rules.length} rule(s)…\n`));

  for (const rule of rules) {
    const label = rule.label || `${rule.from} → ${rule.to}`;
    const ft    = Number(rule.futuresType ?? futuresType ?? 1);
    const asset = String(rule.asset ?? "USDT");
    console.log(bold(`  ● ${label}`));

    const isMasterFrom = !rule.from || String(rule.from).toLowerCase() === "master";
    let transferAmount = null;

    if (!isMasterFrom) {
      process.stdout.write("  Checking balance…");
      const bal = await getSubBalance(creds, rule.from, ft);
      process.stdout.write(`\r${CLEAR_LINE}`);
      const avail = Number(bal.available);
      console.log(dim(`  Balance: ${fmt(avail, 2)} ${asset}`));

      if (rule.pullAbove != null && rule.keepBalance != null) {
        if (avail > Number(rule.pullAbove)) {
          transferAmount = avail - Number(rule.keepBalance);
          console.log(dim(`  Pull ${fmt(transferAmount, 2)} (keep ${fmt(rule.keepBalance, 2)})`));
        } else {
          console.log(dim(`  ${fmt(avail, 2)} ≤ threshold ${fmt(rule.pullAbove, 2)} — skipped.\n`)); continue;
        }
      } else if (rule.amount != null) {
        transferAmount = Number(rule.amount);
      }
    } else {
      // From master → sub
      if (rule.topUpTo != null && rule.topUpBelow != null && rule.to && rule.to.toLowerCase() !== "master") {
        process.stdout.write("  Checking destination balance…");
        const bal = await getSubBalance(creds, rule.to, ft);
        process.stdout.write(`\r${CLEAR_LINE}`);
        const avail = Number(bal.available);
        console.log(dim(`  Dest balance: ${fmt(avail, 2)} ${asset}`));
        if (avail < Number(rule.topUpBelow)) {
          transferAmount = Number(rule.topUpTo) - avail;
          console.log(dim(`  Top-up by ${fmt(transferAmount, 2)} (to ${fmt(rule.topUpTo, 2)})`));
        } else {
          console.log(dim(`  ${fmt(avail, 2)} ≥ threshold ${fmt(rule.topUpBelow, 2)} — skipped.\n`)); continue;
        }
      } else if (rule.amount != null) {
        transferAmount = Number(rule.amount);
      }
    }

    if (!transferAmount || transferAmount <= 0) {
      console.log(dim("  Nothing to transfer — skipped.\n")); continue;
    }

    try {
      await execTransfer(creds, {
        from: rule.from, to: rule.to, asset,
        amount: transferAmount, futuresType: ft, skipConfirm, dryRun,
      });
    } catch (err) {
      console.error(red(`  ✗ ${err.message}\n`));
    }
  }
}

// ── Screen: Auto (interactive) ────────────────────────────────────────────────
async function screenAuto(creds, cfg, futuresType) {
  process.stdout.write(CLS);
  printHeader("Auto Transfer — Config Rules");

  const rules = (cfg.transferRules ?? []).filter((r) => r.enabled !== false);
  if (!rules.length) {
    console.log(yellow("  No enabled transferRules found in config.json.\n"));
    console.log(dim("  Add transferRules to scripts/config.json (see config.example.json).\n"));
    await anyKey(); return;
  }

  console.log(dim(`  ${rules.length} rule(s) configured:\n`));
  rules.forEach((r) => console.log(dim(`    • ${r.label || `${r.from} → ${r.to}`}`)));
  console.log();

  const ok = await rawConfirm("  Run all rules now?");
  if (!ok) { console.log(yellow("  Cancelled.\n")); await anyKey(); return; }

  console.log();
  try {
    await runAutoRules(creds, cfg, futuresType, { dryRun: false, skipConfirm: true });
  } catch (err) {
    console.error(red(`  ✗ ${err.message}\n`));
  }
  await anyKey();
}

// ── Screen: Watch mode ────────────────────────────────────────────────────────
async function screenWatch(creds, cfg, futuresType) {
  process.stdout.write(CLS);
  printHeader("Watch Mode — Auto Transfer Loop");

  const intervalStr = await rawInput("  Check interval (seconds)", { default: "60" });
  const intervalSec = Math.max(5, Number(intervalStr) || 60);

  console.log();
  console.log(dim(`  Running every ${intervalSec}s. Press Ctrl+C to stop.\n`));

  exitRaw();
  let cycle = 0;
  while (true) {
    cycle++;
    const ts = new Date().toLocaleTimeString();
    console.log(dim(`  ── Cycle ${cycle} @ ${ts} ──`));
    try {
      await runAutoRules(creds, cfg, futuresType, { dryRun: false, skipConfirm: true });
    } catch (err) {
      console.error(red(`  ✗ ${err.message}\n`));
    }
    console.log(dim(`  Next run in ${intervalSec}s…\n`));
    await sleep(intervalSec * 1000);
  }
}

// ── Interactive main menu ─────────────────────────────────────────────────────
async function interactiveMode(creds, cfg) {
  const menuItems = [
    "List Sub-accounts & Balances",
    "Transfer Funds",
    "─────────────────────────────",
    "Run Auto Transfer Rules",
    "Watch Mode (loop auto rules)",
    "─────────────────────────────",
    red("Exit"),
  ];
  const actions = { 0: "list", 1: "transfer", 3: "auto", 4: "watch", 6: "exit" };
  const futuresType = 1; // USDT-M; extend with a menu item if COIN-M support needed

  while (true) {
    process.stdout.write(CLS);
    printHeader("Binance Exchange Link — Funds Manager");
    const sel    = await selectMenu(menuItems, { label: dim("  Select action:") });
    const action = actions[sel];
    if (!action) continue;

    exitRaw();
    if (action === "exit") { console.log(dim("\n  Goodbye.\n")); break; }
    else if (action === "list")     { await screenList(creds, cfg, futuresType); }
    else if (action === "transfer") { await screenTransfer(creds); }
    else if (action === "auto")     { await screenAuto(creds, cfg, futuresType); }
    else if (action === "watch")    { await screenWatch(creds, cfg, futuresType); return; }
    enterRaw();
  }
}

// ── CLI mode ──────────────────────────────────────────────────────────────────
async function cliMode(args, creds, cfg) {
  const futuresType = Number(args["futures-type"] ?? 1);
  const dryRun      = args["dry-run"] === true;
  const skipConfirm = args.yes === true || args.auto === true || args.watch === true;

  if (args.list) {
    process.stdout.write("\n  Fetching sub-accounts…");
    const accounts = await listSubAccounts(creds);
    process.stdout.write(`\r${CLEAR_LINE}`);
    const labelMap = Object.fromEntries((cfg.subAccounts ?? []).map((s) => [String(s.id ?? s.email ?? ""), s.label ?? ""]));
    process.stdout.write(`  Fetching balances (${accounts.length} accounts)…`);
    const rows = [];
    for (let i = 0; i < accounts.length; i++) {
      const acc   = accounts[i];
      const id    = String(acc.subAccountId ?? acc.email ?? "");
      const email = String(acc.email ?? "—");
      const label = labelMap[id] || labelMap[email] || dim(id.slice(0, 20));
      const bal   = await getSubBalance(creds, id, futuresType);
      rows.push([label, email, `${fmt(bal.total, 2)} ${bal.asset}`, `${fmt(bal.available, 2)} ${bal.asset}`, id]);
      process.stdout.write(`\r  Fetching balances… ${i + 1}/${accounts.length}`);
    }
    process.stdout.write(`\r${CLEAR_LINE}\n`);
    console.log(drawGrid(["Label", "Email", "Total", "Available", "Sub-account ID"], rows,
      `USDT-M Futures (${accounts.length} accounts)`));
    console.log();
    return;
  }

  if (args.from || args.to) {
    const from   = String(args.from || "master");
    const to     = String(args.to   || "master");
    const asset  = String(args.asset || "USDT").toUpperCase();
    const amount = Number(args.amount || 0);
    if (amount <= 0) { console.error(red("\n  ✗ --amount must be > 0\n")); process.exit(1); }
    if (from.toLowerCase() === to.toLowerCase()) {
      console.error(red("\n  ✗ --from and --to cannot be the same\n")); process.exit(1);
    }
    let confirmed = skipConfirm;
    if (!skipConfirm && !dryRun) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const ans = await new Promise((r) => {
        const isMaster = (id) => !id || id.toLowerCase() === "master";
        const ft = futuresType === 2 ? "COIN-M" : "USDT-M";
        console.log();
        console.log(drawKV([
          [dim("From"),         isMaster(from) ? bold("master") : from],
          [dim("To"),           isMaster(to)   ? bold("master") : to],
          [dim("Asset"),        bold(asset)],
          [dim("Amount"),       bold(`${fmt(amount, 4)} ${asset}`)],
          [dim("Futures Type"), ft],
        ], "Transfer Preview"));
        console.log();
        rl.question("  Confirm? (y/n): ", (a) => { rl.close(); r(a.trim()); });
      });
      confirmed = ans.toLowerCase() === "y";
    }
    if (!confirmed && !dryRun) { console.log(yellow("  Cancelled.\n")); return; }
    try {
      await execTransfer(creds, { from, to, asset, amount, futuresType, skipConfirm: true, dryRun });
    } catch (err) {
      console.error(red(`\n  ✗ ${err.message}`));
      if (err.binanceCode) console.error(dim(`    Code: ${err.binanceCode}`));
      console.log();
      process.exit(1);
    }
    return;
  }

  if (args.auto || args.watch) {
    const intervalSec = Number(args.interval || 60);
    if (args.watch) console.log(bold(`\n  Watch mode — every ${intervalSec}s. Ctrl+C to stop.\n`));
    let cycle = 0;
    while (true) {
      cycle++;
      if (args.watch) console.log(dim(`  ── Cycle ${cycle} @ ${new Date().toLocaleTimeString()} ──`));
      try { await runAutoRules(creds, cfg, futuresType, { dryRun, skipConfirm: true }); }
      catch (err) { console.error(red(`  ✗ ${err.message}\n`)); }
      if (!args.watch) break;
      console.log(dim(`  Next in ${intervalSec}s…\n`));
      await sleep(intervalSec * 1000);
    }
    return;
  }

  // No mode selected
  console.log(`
  ${bold("Binance Funds Transfer Script")}

  ${bold("List sub-accounts:")}
    node scripts/transfer-funds.mjs --list

  ${bold("Transfer:")}
    node scripts/transfer-funds.mjs --from sub1@ex.com --to sub2@ex.com --amount 100
    node scripts/transfer-funds.mjs --from sub1@ex.com --to master --amount 500
    node scripts/transfer-funds.mjs --from master --to sub2@ex.com --amount 200

  ${bold("Auto rules / watch:")}
    node scripts/transfer-funds.mjs --auto
    node scripts/transfer-funds.mjs --watch --interval 120

  ${dim("Run without args for interactive mode.")}
`);
}

// ── Entry point ───────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);
  const cfg  = loadConfig(args.config);

  const apiKey    = args.key    || process.env.BINANCE_BROKER_API_KEY    || cfg.broker?.apiKey;
  const apiSecret = args.secret || process.env.BINANCE_BROKER_API_SECRET || cfg.broker?.apiSecret;
  const baseUrl   = process.env.BINANCE_API_BASE || cfg.broker?.baseUrl || "https://api.binance.com";
  const creds     = { apiKey, apiSecret, baseUrl };

  const hasCLIMode = args.list || args.from || args.to || args.auto || args.watch;
  const isInteractive = !hasCLIMode && process.stdin.isTTY;

  if (!apiKey || !apiSecret) {
    if (isInteractive) {
      process.stdout.write(CLS);
      printHeader("Binance Exchange Link — Setup");
      console.log(dim("  No broker API credentials found. Enter them now.\n"));
      console.log(dim(`  Tip: save to ${join(__dir, "config.json")} to skip this step.\n`));
      const key    = await new Promise((r) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question("  Broker API Key:    ", (a) => { rl.close(); r(a.trim()); });
      });
      const secret = await new Promise((r) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question("  Broker API Secret: ", (a) => { rl.close(); r(a.trim()); });
      });
      if (!key || !secret) { console.error(red("\n  Credentials required.\n")); process.exit(1); }
      creds.apiKey = key; creds.apiSecret = secret;
      enterRaw();
      await interactiveMode(creds, cfg);
    } else {
      console.error(red("\n  ✗ Broker API credentials missing.\n"));
      console.error(dim("    Set --key / --secret, BINANCE_BROKER_API_KEY / BINANCE_BROKER_API_SECRET,"));
      console.error(dim(`    or add a "broker" section to ${join(__dir, "config.json")}\n`));
      process.exit(1);
    }
    return;
  }

  if (isInteractive) {
    enterRaw();
    await interactiveMode(creds, cfg);
  } else {
    await cliMode(args, creds, cfg);
  }
}

main().catch((err) => {
  exitRaw();
  console.error(red(`\n  Fatal: ${err.message}\n`));
  process.exit(1);
});
