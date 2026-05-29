/** Binance USD-M symbol e.g. ETHUSDT → display "ETH/USDT". */
export function symbolToPairLabel(symbol: string): string {
  const u = symbol.toUpperCase();
  if (u.endsWith("USDC")) return `${u.slice(0, -4)}/USDC`;
  if (u.endsWith("USDT")) return `${u.slice(0, -4)}/USDT`;
  return symbol;
}

/**
 * Accepts "ETH/USDT", "ETH-USDT", "ethusdt", "ETHUSDT" → Binance symbol or null.
 */
export function pairLabelToSymbol(input: string): string | null {
  const trimmed = input.trim().toUpperCase().replace(/\s+/g, "");
  if (!trimmed) return null;

  const slash = trimmed.replace(/-/g, "/");
  const parts = slash.split("/");
  if (parts.length === 2) {
    const [base, quote] = parts;
    if (!base || (quote !== "USDT" && quote !== "USDC")) return null;
    return `${base}${quote}`;
  }

  if (/^[A-Z0-9]+USDC$/.test(trimmed)) return trimmed;
  if (/^[A-Z0-9]+USDT$/.test(trimmed)) return trimmed;
  return null;
}
