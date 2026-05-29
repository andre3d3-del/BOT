import { ListPlus, Trash2, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FieldHint } from "@/components/FieldHint";
import { exchangeInfo, filterUsdMarginSymbols } from "@/lib/binanceFutures";
import { pairLabelToSymbol, symbolToPairLabel } from "@/lib/futuresPairFormat";

const WL_KEY = "futures_watchlist_v1";

function loadWl(): string[] {
  try {
    const raw = localStorage.getItem(WL_KEY);
    if (!raw) return ["BTCUSDT", "ETHUSDT"];
    const j = JSON.parse(raw) as unknown;
    return Array.isArray(j) ? j.filter((x) => typeof x === "string") : ["BTCUSDT"];
  } catch {
    return ["BTCUSDT"];
  }
}

function sortSymbols(a: string, b: string): number {
  return symbolToPairLabel(a).localeCompare(symbolToPairLabel(b), undefined, {
    sensitivity: "base",
  });
}

export function WatchlistPanel({
  activeSymbol,
  onSelect,
}: {
  activeSymbol: string;
  onSelect: (s: string) => void;
}) {
  const [list, setList] = useState<string[]>(() => loadWl().sort(sortSymbols));
  const [allSymbols, setAllSymbols] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [loadErr, setLoadErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const info = await exchangeInfo();
        if (cancelled) return;
        setAllSymbols(filterUsdMarginSymbols(info.symbols).sort(sortSymbols));
        setLoadErr(null);
      } catch (e) {
        if (!cancelled)
          setLoadErr(
            e instanceof Error
              ? e.message
              : "Could not load pairs — check internet or your /binance-fapi proxy."
          );
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const persist = useCallback((next: string[]) => {
    const sorted = [...next].sort(sortSymbols);
    setList(sorted);
    localStorage.setItem(WL_KEY, JSON.stringify(sorted));
  }, []);

  const addSymbol = useCallback(
    (sym: string) => {
      const s = sym.trim().toUpperCase();
      if (!s || list.includes(s)) return;
      persist([...list, s]);
      onSelect(s);
    },
    [list, onSelect, persist]
  );

  const addAllFromBinance = useCallback(() => {
    if (allSymbols.length === 0) return;
    const merged = [...new Set([...list, ...allSymbols])].sort(sortSymbols);
    persist(merged);
    if (!merged.includes(activeSymbol) && merged[0]) onSelect(merged[0]);
  }, [activeSymbol, allSymbols, list, onSelect, persist]);

  const remove = useCallback(
    (s: string) => {
      const next = list.filter((x) => x !== s);
      persist(next);
      if (activeSymbol === s && next[0]) onSelect(next[0]);
    },
    [activeSymbol, list, onSelect, persist]
  );

  const available = useMemo(() => {
    const set = new Set(list);
    return allSymbols
      .filter((sym) => !set.has(sym))
      .map((sym) => ({ symbol: sym, label: symbolToPairLabel(sym) }));
  }, [allSymbols, list]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return available;
    return available.filter(
      ({ symbol, label }) =>
        label.toLowerCase().includes(q) || symbol.toLowerCase().includes(q)
    );
  }, [available, search]);

  const tryAddFromSearch = useCallback(() => {
    const q = search.trim();
    if (!q) return;
    const parsed = pairLabelToSymbol(q);
    if (parsed && available.some((o) => o.symbol === parsed)) {
      addSymbol(parsed);
      setSearch("");
      return;
    }
    if (filtered.length === 1) {
      addSymbol(filtered[0].symbol);
      setSearch("");
    }
  }, [addSymbol, available, filtered, search]);

  return (
    <div className="flex flex-col">
      {/* ── Sticky header ─────────────────────────────────────────────── */}
      <div className="sticky top-0 z-10 border-b border-slate-200 bg-white px-3 py-3">
        <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
          Pairs
        </p>
        {loadErr && (
          <p className="mt-1.5 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[10px] text-amber-700">
            Can't load market list.
          </p>
        )}
      </div>

      {/* ── Saved watchlist ───────────────────────────────────────────── */}
      <div className="border-b border-slate-100">
        <p className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
          Watchlist
        </p>
        {list.length === 0 ? (
          <p className="px-3 pb-4 text-center text-[11px] text-slate-400">
            No pairs yet — search below.
          </p>
        ) : (
          <ul className="px-1.5 pb-1.5">
            {list.map((s) => (
              <li key={s} className="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => onSelect(s)}
                  className={`min-w-0 flex-1 truncate rounded-md px-2.5 py-2 text-left text-[13px] font-medium transition ${
                    s === activeSymbol
                      ? "bg-indigo-50 text-indigo-700"
                      : "text-slate-700 hover:bg-slate-50 hover:text-slate-900"
                  }`}
                >
                  {symbolToPairLabel(s)}
                  {s === activeSymbol && (
                    <span className="ml-1.5 text-[9px] font-normal text-indigo-400">●</span>
                  )}
                </button>
                <button
                  type="button"
                  title={`Remove ${symbolToPairLabel(s)}`}
                  onClick={() => remove(s)}
                  className="shrink-0 rounded p-1 text-slate-300 transition hover:bg-red-50 hover:text-red-500"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── Search / add pairs ────────────────────────────────────────── */}
      <div className="p-3">
        <div className="relative mb-1">
          <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-slate-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") tryAddFromSearch(); }}
            placeholder="Search pairs…"
            className="ui-input w-full py-1.5 pl-7 text-[13px]"
            aria-describedby="pair-search-hint"
          />
        </div>
        <FieldHint id="pair-search-hint">Enter to add when one result shows.</FieldHint>

        <div className="mt-2 max-h-52 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50">
          {filtered.length === 0 ? (
            <div className="px-3 py-4 text-center text-[11px] text-slate-400">
              {available.length === 0
                ? "All pairs already in list."
                : "No match — try 1000PEPE etc."}
            </div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {filtered.map(({ symbol: sym, label }) => (
                <li key={sym}>
                  <button
                    type="button"
                    onClick={() => addSymbol(sym)}
                    className="flex w-full items-center justify-between px-2.5 py-1.5 text-left text-[12px] text-slate-600 transition hover:bg-indigo-50 hover:text-indigo-700"
                  >
                    <span className="font-medium">{label}</span>
                    <span className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">
                      +Add
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <button
          type="button"
          onClick={addAllFromBinance}
          disabled={allSymbols.length === 0}
          className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2 py-2 text-[11px] font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 disabled:opacity-40"
        >
          <ListPlus className="h-3.5 w-3.5 shrink-0 text-slate-400" />
          Add all USDT &amp; USDC
          <span className="text-slate-400">({allSymbols.length})</span>
        </button>
      </div>
    </div>
  );
}
