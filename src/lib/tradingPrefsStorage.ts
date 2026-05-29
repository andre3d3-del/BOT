import type { GridSide } from "@/lib/strategyEngine";

const ACTIVE_SYMBOL_KEY = "futures_active_symbol_v1";
const FORM_PREFS_KEY = "futures_strategy_form_prefs_v1";

export type SymbolFormPrefs = {
  anchor?: string;
  gridSide?: GridSide;
  levels?: number;
  stepPct?: number;
  quotePerLevel?: number;
  autoTpFromFills?: boolean;
  autoReentry?: boolean;
};

/** JSON.parse can yield strings/numbers for booleans depending on how data was written — normalize. */
function coerceBoolean(v: unknown): boolean | undefined {
  if (v === true || v === "true" || v === 1 || v === "1") return true;
  if (v === false || v === "false" || v === 0 || v === "0") return false;
  if (typeof v === "boolean") return v;
  return undefined;
}

export function loadActiveSymbol(): string {
  try {
    const s = localStorage.getItem(ACTIVE_SYMBOL_KEY)?.trim().toUpperCase();
    if (s && /^[A-Z0-9]+$/.test(s)) return s;
  } catch {
    /* ignore */
  }
  return "BTCUSDT";
}

export function persistActiveSymbol(symbol: string): void {
  try {
    localStorage.setItem(ACTIVE_SYMBOL_KEY, symbol.trim().toUpperCase());
  } catch {
    /* ignore */
  }
}

function loadAllFormPrefs(): Record<string, SymbolFormPrefs> {
  try {
    const raw = localStorage.getItem(FORM_PREFS_KEY);
    if (!raw) return {};
    const j = JSON.parse(raw) as unknown;
    return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, SymbolFormPrefs>) : {};
  } catch {
    return {};
  }
}

/** Merge duplicate keys such as btcusdt + BTCUSDT (persist always uses uppercase keys). */
function prefsByUpperSymbol(): Record<string, SymbolFormPrefs> {
  const raw = loadAllFormPrefs();
  const out: Record<string, SymbolFormPrefs> = {};
  for (const [k, v] of Object.entries(raw)) {
    const sym = k.trim().toUpperCase();
    out[sym] = { ...(out[sym] ?? {}), ...(v ?? {}) };
  }
  return out;
}

export function loadFormPrefsForSymbol(symbol: string): SymbolFormPrefs {
  const sym = symbol.trim().toUpperCase();
  const raw = prefsByUpperSymbol()[sym] ?? {};
  const autoTp = coerceBoolean(raw.autoTpFromFills);
  const autoRe = coerceBoolean(raw.autoReentry);
  return {
    ...raw,
    ...(autoTp !== undefined ? { autoTpFromFills: autoTp } : {}),
    ...(autoRe !== undefined ? { autoReentry: autoRe } : {}),
  };
}

export function persistFormPrefsForSymbol(symbol: string, prefs: SymbolFormPrefs): void {
  try {
    const sym = symbol.trim().toUpperCase();
    const all = prefsByUpperSymbol();
    all[sym] = { ...all[sym], ...prefs };
    localStorage.setItem(FORM_PREFS_KEY, JSON.stringify(all));
  } catch {
    /* ignore quota */
  }
}
