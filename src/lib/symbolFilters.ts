type FilterRow = { filterType: string; tickSize?: string; stepSize?: string };

export type SymbolRow = {
  symbol: string;
  filters: FilterRow[];
};

export type LotPriceFilter = { tickSize: number; stepSize: number };

export function lotPriceForSymbol(
  symbols: SymbolRow[],
  symbol: string
): LotPriceFilter | null {
  const row = symbols.find((s) => s.symbol === symbol);
  if (!row) return null;
  let tickSize = 0.01;
  let stepSize = 0.001;
  for (const f of row.filters) {
    if (f.filterType === "PRICE_FILTER" && f.tickSize) tickSize = Number(f.tickSize);
    if (f.filterType === "LOT_SIZE" && f.stepSize) stepSize = Number(f.stepSize);
  }
  return { tickSize, stepSize };
}

export function roundToStep(value: number, step: number, mode: "floor" | "round" = "floor"): string {
  if (step <= 0) return String(value);
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)));
  const n = mode === "floor" ? Math.floor(value / step) * step : Math.round(value / step) * step;
  return n.toFixed(decimals);
}
