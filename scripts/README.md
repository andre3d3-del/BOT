# Trading Scripts — v2

Two standalone Node.js scripts that talk **directly to Binance** — no proxy hop, no browser.

**Requirements:** Node.js 18+. No `npm install` needed.

---

## Setup

Copy the example config and fill in your API keys:

```
copy scripts\config.example.json scripts\config.json
```

Edit `scripts/config.json`:

```json
{
  "trading": {
    "apiKey":    "YOUR_FUTURES_API_KEY",
    "apiSecret": "YOUR_FUTURES_API_SECRET"
  },
  "broker": {
    "apiKey":    "YOUR_BROKER_API_KEY",
    "apiSecret": "YOUR_BROKER_API_SECRET"
  },
  "proxyUrl": "http://localhost:3001"
}
```

> `config.json` is git-ignored — your keys will never be committed.

---

## Script 1 — Start Bot Session (`place-order.mjs`)

Starts a full **DCA grid / cycle bot session**:

1. Places the entry LIMIT order **directly to Binance** (no proxy hop = fastest possible path)
2. Registers the TP cycle with the **running proxy backend**

The proxy then handles everything automatically:
- Entry fills → places all TP rows
- Each TP fills → places re-entry at anchor
- Re-entry fills → recycles the TP at that level
- Repeats indefinitely until you stop it

### Bot cycle flow

```
LONG example — anchor: 104,000  |  12.5% vol/TP  |  1% spacing

  Entry:  BUY  0.019 BTC @ 104,000   ← placed directly to Binance

  After entry fills, proxy auto-places:
  TP 1:  SELL 0.002 BTC @ 105,040   (+1%)  ─┐
  TP 2:  SELL 0.002 BTC @ 106,080   (+2%)   │
  TP 3:  SELL 0.002 BTC @ 107,120   (+3%)   │ placed automatically
  ...                                        │
  TP 8:  SELL 0.002 BTC @ 112,320   (+8%)  ─┘

  TP 1 fills @ 105,040
    └→ proxy places BUY re-entry @ 104,000
         └→ re-entry fills → SELL TP placed back @ 105,040 → repeats forever
```

**SHORT works the same way** — entry is SELL, TPs are BUY orders placed *below* anchor.

---

### Interactive mode (recommended)

```
node scripts/place-order.mjs
```

Full terminal UI with keyboard navigation:

```
  ╔══════════════════════════════════════════════════╗
  ║      Binance Futures Bot — Session Manager       ║
  ╚══════════════════════════════════════════════════╝

  Trading: BTCUSDT   Proxy: http://localhost:3001

    ▶ Start New Session
      ──────────────────────────────────────────────
      View Open Orders
      View Positions
      View Balance
      ──────────────────────────────────────────────
      Exit

  ↑↓ navigate   Enter select   Ctrl+C quit
```

**Start New Session** walks you through 6 steps:

| Step | Input | Example |
|------|-------|---------|
| 1 | Symbol | `BTCUSDT` |
| 2 | Direction | `LONG` or `SHORT` (arrow keys) |
| 3 | Anchor price | `104000`  *(mark price shown as hint)* |
| 4 | Position size | `2000` USDT  *(or base qty)* |
| 5 | TP grid config | `12.5%` vol / TP,  `1%` spacing |
| 6 | Position mode | One-Way or Hedge (arrow keys) |

Then shows a full TP table preview with estimated profit, asks for confirmation, and starts the session.

**Keyboard controls:**

| Key | Action |
|-----|--------|
| `↑` / `↓` | Navigate menu |
| `Enter` | Select / confirm |
| `Backspace` | Delete typed character |
| `Ctrl+C` | Quit cleanly |

---

### CLI one-shot mode

Pass all parameters as flags — ideal for hotkeys or automation:

```bash
# LONG session — $2000 position, 12.5% vol, 1% spacing
node scripts/place-order.mjs \
  --symbol BTCUSDT \
  --direction LONG \
  --anchor 104000 \
  --total 2000 \
  --vol-pct 12.5 \
  --step 1

# SHORT session with hedge mode
node scripts/place-order.mjs \
  --symbol BTCUSDT \
  --direction SHORT \
  --anchor 104000 \
  --total 2000 \
  --vol-pct 12.5 \
  --step 1 \
  --hedge

# Entry qty in base asset instead of USDT
node scripts/place-order.mjs \
  --symbol ETHUSDT \
  --direction LONG \
  --anchor 3800 \
  --base-qty 1.5 \
  --vol-pct 10 \
  --step 0.5

# Preview without submitting
node scripts/place-order.mjs \
  --symbol BTCUSDT --direction LONG --anchor 104000 --total 2000 \
  --vol-pct 12.5 --step 1 --dry-run

# Skip confirmation prompt
node scripts/place-order.mjs \
  --symbol BTCUSDT --direction LONG --anchor 104000 --total 2000 \
  --vol-pct 12.5 --step 1 --yes
```

### All flags

| Flag | Default | Description |
|------|---------|-------------|
| `--key` | config.json | Trading API key |
| `--secret` | config.json | Trading API secret |
| `--symbol` | — | Trading pair, e.g. `BTCUSDT` |
| `--direction` | — | `LONG` or `SHORT` |
| `--anchor` | — | Entry price AND re-entry target every cycle |
| `--total` | — | Total USDT to buy (entry position size) |
| `--base-qty` | — | Entry qty in base asset (use instead of `--total`) |
| `--vol-pct` | `12.5` | % of entry qty per TP level (12.5% → 8 levels) |
| `--step` | `1` | % price gap between consecutive TP levels |
| `--hedge` | off | Hedge mode: sends `positionSide LONG/SHORT` |
| `--yes` | off | Skip y/n confirmation |
| `--dry-run` | off | Preview only — nothing submitted |
| `--proxy` | `http://localhost:3001` | Proxy URL for cycle registration |
| `--testnet` | off | Use Binance USD-M testnet |
| `--config` | `scripts/config.json` | Path to config file |

### Passing credentials inline

```bash
node scripts/place-order.mjs --symbol BTCUSDT --direction LONG --anchor 104000 --total 2000 \
  --vol-pct 12.5 --step 1 --key YOUR_KEY --secret YOUR_SECRET
```

Or via environment variables:

```bash
set BINANCE_API_KEY=YOUR_KEY
set BINANCE_API_SECRET=YOUR_SECRET
node scripts/place-order.mjs --symbol BTCUSDT --direction LONG --anchor 104000 --total 2000 --vol-pct 12.5 --step 1
```

### What happens if the proxy is offline?

The entry order is still placed directly to Binance. You'll see a warning:

```
→ Registering cycle on proxy... ⚠ connect ECONNREFUSED
  Entry order was placed (#12345678), but the cycle worker could not be registered.
  Restart this session from the frontend dashboard (Restart button).
```

The session will appear in the frontend with an "offline" badge — click **Restart** to register the cycle.

---

## Script 2 — Transfer Funds (`transfer-funds.mjs`)

Transfers USDT-M (or COIN-M) futures assets between sub-accounts using the
**Binance Exchange Link / Broker API** (`POST /sapi/v1/broker/futures/transfer`).

Requires the **broker/master account** API key (not the sub-account trading key).

### Interactive mode

```
node scripts/transfer-funds.mjs
```

```
  ╔══════════════════════════════════════════╗
  ║  Binance Exchange Link — Funds Manager   ║
  ╚══════════════════════════════════════════╝

    ▶ List Sub-accounts & Balances
      Transfer Funds
      ─────────────────────────────
      Run Auto Transfer Rules
      Watch Mode (loop auto rules)
      ─────────────────────────────
      Exit
```

**List Sub-accounts** — shows all sub-accounts with USDT-M futures balances (total + available).

**Transfer Funds** — guided prompts: From → To → Asset → Amount → Futures Type → confirm.

**Run Auto Transfer Rules** — reads `transferRules` from `config.json` and runs them once.

**Watch Mode** — runs the auto rules in a loop at an interval you set (e.g. every 60 s).

---

### CLI one-shot mode

```bash
# List all sub-accounts with balances
node scripts/transfer-funds.mjs --list

# Transfer between two sub-accounts
node scripts/transfer-funds.mjs --from sub1@example.com --to sub2@example.com --amount 100

# Pull funds from sub-account to master
node scripts/transfer-funds.mjs --from sub1@example.com --to master --amount 500

# Push funds from master to sub-account
node scripts/transfer-funds.mjs --from master --to sub1@example.com --amount 200

# COIN-M futures transfer
node scripts/transfer-funds.mjs --from sub1@example.com --to sub2@example.com --asset BTC --amount 0.5 --futures-type 2

# Skip confirmation
node scripts/transfer-funds.mjs --from sub1@example.com --to master --amount 100 --yes

# Preview without submitting
node scripts/transfer-funds.mjs --from sub1@example.com --to master --amount 100 --dry-run

# Run config rules once
node scripts/transfer-funds.mjs --auto

# Watch mode — run rules every 120 seconds
node scripts/transfer-funds.mjs --watch --interval 120
```

### All flags

| Flag | Default | Description |
|------|---------|-------------|
| `--key` | config.json | Broker API key |
| `--secret` | config.json | Broker API secret |
| `--from` | — | Source: sub-account email/ID or `master` |
| `--to` | — | Destination: sub-account email/ID or `master` |
| `--asset` | `USDT` | Asset to transfer |
| `--amount` | — | Amount to transfer |
| `--futures-type` | `1` | `1` = USDT-M, `2` = COIN-M |
| `--list` | off | List all sub-accounts with balances |
| `--auto` | off | Run `transferRules` from config once |
| `--watch` | off | Loop `--auto` every `--interval` seconds |
| `--interval` | `60` | Seconds between watch cycles |
| `--dry-run` | off | Preview only — nothing submitted |
| `--yes` | off | Skip confirmation |
| `--config` | `scripts/config.json` | Path to config file |

---

## Auto Transfer Rules (config.json)

Add `transferRules` to `scripts/config.json`. Rules run when you use `--auto` or Watch Mode.

```json
{
  "transferRules": [
    {
      "label": "Pull excess from sub1 to master",
      "enabled": true,
      "from": "sub1@example.com",
      "to": "master",
      "asset": "USDT",
      "futuresType": 1,
      "keepBalance": 500,
      "pullAbove": 1000
    },
    {
      "label": "Top-up sub2 if low",
      "enabled": true,
      "from": "master",
      "to": "sub2@example.com",
      "asset": "USDT",
      "futuresType": 1,
      "topUpTo": 500,
      "topUpBelow": 200
    }
  ]
}
```

### Rule fields

| Field | Description |
|-------|-------------|
| `label` | Display name for the rule |
| `enabled` | `true` / `false` |
| `from` | Source email/ID or `"master"` |
| `to` | Destination email/ID or `"master"` |
| `asset` | `"USDT"` (default) or other |
| `futuresType` | `1` = USDT-M (default), `2` = COIN-M |
| `pullAbove` | Transfer if source available > this |
| `keepBalance` | Keep this much in source after pulling |
| `topUpBelow` | Transfer if destination available < this |
| `topUpTo` | Top-up destination to this amount |
| `amount` | Fixed amount (use instead of pull/push logic) |

**Pull logic:** if `available > pullAbove`, transfer `available − keepBalance`.  
**Push logic:** if `dest_available < topUpBelow`, transfer `topUpTo − dest_available`.

---

## Tips

**Position size minimum:** At $104,000 BTC with 12.5% vol/TP and stepSize=0.001, each TP gets `floor(entryQty × 12.5%) ≥ 0.001 BTC`. You need at least ~$830 USDT. The script will tell you if the size is too small.

**Speed:** The script calls Binance directly for the entry order — no proxy hop, no React render cycle. Entry order latency = your server-to-Binance RTT only. Deploy on a VPS near Tokyo or Singapore for best results.

**One-Way vs Hedge mode:**
- One-Way (default) — no `positionSide` sent; TP orders use `reduceOnly: true` inside the proxy
- Hedge mode (`--hedge`) — sends `positionSide: LONG` or `SHORT` on every order

The script auto-retries without `positionSide` if Binance returns error `-4061` (account is in one-way mode but hedge was requested).

**Proxy must be running** for the cycle to auto-operate after the entry fills. If the proxy is down when you start a session, the entry order is still placed — restart the cycle from the frontend dashboard.

**Binance API key permissions needed:**
- `place-order.mjs` → Enable Futures Trading
- `transfer-funds.mjs` → Enable Futures Trading + Transfer (broker key)

**Test with `--dry-run` first** — always preview the TP table before a real submission.
