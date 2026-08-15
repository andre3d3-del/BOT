import { Activity, RefreshCw, RotateCcw, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { FieldHint } from "@/components/FieldHint";
import { useCredentials } from "@/context/CredentialsContext";
import {
  cancelAllOpenOrders,
  cancelOrderById,
  closePositionAtMarket,
  exchangeInfo,
  fetchMarkPrice,
  fetchPositions,
  getBackendCycleStatus,
  fetchUserTrades,
  getOpenOrders,
  newOrder,
  startBackendCycleWorker,
  stopBackendCycleWorker,
  type FuturesPosition,
} from "@/lib/binanceFutures";
import { symbolToPairLabel } from "@/lib/futuresPairFormat";
import { lotPriceForSymbol, roundToStep, type SymbolRow } from "@/lib/symbolFilters";
import { loadFormPrefsForSymbol, persistFormPrefsForSymbol } from "@/lib/tradingPrefsStorage";

/* ─────────────────────────────────────────────
   Constants & pure helpers
───────────────────────────────────────────── */
const HEDGE_KEY = "futures_hedge_mode_v1";
const ORDERS_REFRESH_MS = 10_000;

type TradeDirection = "LONG" | "SHORT";
type AccountDirectionMap = { A: TradeDirection; B: TradeDirection };

const oppositeDirection = (d: TradeDirection): TradeDirection =>
  d === "LONG" ? "SHORT" : "LONG";

function sidesForDirection(d: TradeDirection) {
  return d === "LONG"
    ? { entrySide: "BUY" as const, tpSide: "SELL" as const }
    : { entrySide: "SELL" as const, tpSide: "BUY" as const };
}

function tpPriceFactor(direction: TradeDirection, stepPct: number, level: number) {
  const move = (stepPct / 100) * level;
  return direction === "LONG" ? 1 + move : 1 - move;
}

function pnlFromCycle(direction: TradeDirection, entryPrice: number, tpQuote: number, qty: number) {
  const entryQuote = qty * entryPrice;
  return direction === "LONG" ? tpQuote - entryQuote : entryQuote - tpQuote;
}

type CycleConfig = {
  anchorPrice: string;
  rows: Array<{ price: string; percent: number }>;
  stepSize: number;
  tickSize: number;
  direction: TradeDirection;
  positionSide?: "LONG" | "SHORT";
  entryQty: number;
};

type TradeSession = {
  id: string;
  slot: "A" | "B";
  side: TradeDirection;
  entryOrderId: number | null;
  tpOrderIds: number[];
  createdAt: number;
  backendActive?: boolean;
  backendLastError?: string | null;
  streamConnected?: boolean;
  streamError?: string | null;
  knownOrderIds?: number[];
  /** TP rows that could not be placed (nor recovered by reconciliation) after entry fill */
  placementGaps?: number;
  /** Cycle replacement orders (re-entry / recycled TP) that failed after retries */
  cycleGaps?: number;
  /** Stored config so a proxy-restarted session can be resumed via the Restart button */
  cycleConfig?: CycleConfig;
};

function entryOrderIdsStorageKey(sym: string) { return `futures_entry_order_ids_v1_${sym.trim().toUpperCase()}`; }
function exchangeSnapshotStorageKey(sym: string) { return `futures_exchange_snapshot_v1_${sym.trim().toUpperCase()}`; }
function tradingAccountSlotKey(sym: string) { return `futures_trading_account_slot_v1_${sym.trim().toUpperCase()}`; }
function tradingDirectionPairKey(sym: string) { return `futures_trading_direction_pair_v1_${sym.trim().toUpperCase()}`; }
function tradeSessionStorageKey(sym: string, slot: "A" | "B") { return `futures_trade_session_v1_${sym.trim().toUpperCase()}_${slot}`; }

function loadHedge(): boolean {
  try { return localStorage.getItem(HEDGE_KEY) === "1"; } catch { return false; }
}

/* ─────────────────────────────────────────────
   Component
───────────────────────────────────────────── */
export function StrategyPanel({ symbol }: { symbol: string }) {
  const { apiKey, apiSecret, accounts, activeSlot, setActiveSlot } = useCredentials();

  const credentialsReady = useMemo(
    () => Boolean(apiKey?.trim() && apiSecret?.trim()),
    [apiKey, apiSecret]
  );

  /* ── Form state ── */
  const [anchor, setAnchor] = useState("");
  const [accountDirections, setAccountDirections] = useState<AccountDirectionMap>({ A: "LONG", B: "SHORT" });
  const [markRaw, setMarkRaw] = useState<string | null>(null);
  const [markLoading, setMarkLoading] = useState(false);
  const [markErr, setMarkErr] = useState<string | null>(null);
  const [entryQuoteTotal, setEntryQuoteTotal] = useState(100);
  const [entryMode, setEntryMode] = useState<"QUOTE" | "BASE">("QUOTE");
  const [entryBaseQty, setEntryBaseQty] = useState(1000);
  const [tpVolumePct, setTpVolumePct] = useState(12.5);
  const [splitTpStepPct, setSplitTpStepPct] = useState(1);
  const [removedTpLevels, setRemovedTpLevels] = useState<number[]>([]);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [hedgeMode, setHedgeMode] = useState(loadHedge);

  /* ── Exchange/session state ── */
  const [acctMsg, setAcctMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [tradeSessions, setTradeSessions] = useState<TradeSession[]>([]);
  const [symbolRows, setSymbolRows] = useState<SymbolRow[]>([]);
  const [openOrders, setOpenOrders] = useState<
    Array<{ orderId: number; side: "BUY" | "SELL"; price: string; origQty: string; executedQty: string }>
  >([]);
  const [recentFills, setRecentFills] = useState<
    Array<{ id: number; orderId: number; side: "BUY" | "SELL"; price: string; qty: string }>
  >([]);
  const [openPositions, setOpenPositions] = useState<FuturesPosition[]>([]);

  const trackedEntryOrderIdsRef = useRef<Set<number>>(new Set());
  const anchorSourcePriceByOrderIdRef = useRef<Map<number, string>>(new Map());
  const markCacheRef = useRef<Record<string, string>>({});
  // Ref mirror of tradeSessions — lets the status-polling effect read the latest
  // sessions without listing tradeSessions as a dependency (which would restart the
  // interval on every status update, causing a polling storm).
  const tradeSessionsRef = useRef<TradeSession[]>([]);
  const tickRunningRef = useRef(false);
  const anchorSyncedForSymbolRef = useRef<string | null>(null);

  const direction = accountDirections[activeSlot];
  const numberOrEmpty = useCallback((n: number) => (Number.isFinite(n) ? n : ""), []);

  /* ── Filters & pair ── */
  useEffect(() => {
    let c = false;
    void (async () => {
      try {
        const info = await exchangeInfo();
        if (!c) setSymbolRows(info.symbols as unknown as SymbolRow[]);
      } catch { /* ignore */ }
    })();
    return () => { c = true; };
  }, []);

  const filters = useMemo(
    () => lotPriceForSymbol(symbolRows, symbol) ?? { tickSize: 0.0001, stepSize: 0.001 },
    [symbolRows, symbol]
  );

  const pairAssets = useMemo(() => {
    const u = symbol.toUpperCase();
    if (u.endsWith("USDC")) return { base: u.slice(0, -4), quote: "USDC" };
    if (u.endsWith("USDT")) return { base: u.slice(0, -4), quote: "USDT" };
    return { base: u, quote: "USDT" };
  }, [symbol]);

  /* ── Persist hedge mode ── */
  useEffect(() => {
    try { localStorage.setItem(HEDGE_KEY, hedgeMode ? "1" : "0"); } catch { /* ignore */ }
  }, [hedgeMode]);

  /* ── Load symbol prefs ── */
  useLayoutEffect(() => {
    let loadedSlot: "A" | "B" = activeSlot;
    try {
      const s = localStorage.getItem(tradingAccountSlotKey(symbol));
      if (s === "A" || s === "B") { loadedSlot = s; setActiveSlot(s); }
    } catch { /* ignore */ }
    try {
      const raw = localStorage.getItem(tradingDirectionPairKey(symbol));
      if (raw) {
        const j = JSON.parse(raw) as Partial<AccountDirectionMap>;
        if ((j.A === "LONG" || j.A === "SHORT") && (j.B === "LONG" || j.B === "SHORT")) {
          setAccountDirections({ A: j.A, B: j.B });
        }
      }
    } catch { /* ignore */ }
    try {
      const rawSnap = localStorage.getItem(exchangeSnapshotStorageKey(symbol));
      if (rawSnap) {
        const parsed = JSON.parse(rawSnap) as { open?: typeof openOrders; fills?: typeof recentFills };
        setOpenOrders(Array.isArray(parsed.open) ? parsed.open : []);
        setRecentFills(Array.isArray(parsed.fills) ? parsed.fills : []);
      } else { setOpenOrders([]); setRecentFills([]); }
    } catch { setOpenOrders([]); setRecentFills([]); }
    const parseSlotSessions = (raw: string | null, slot: "A" | "B"): TradeSession[] => {
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw) as Partial<TradeSession> | Partial<TradeSession>[];
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        return arr.map((s): TradeSession | null => {
          if (typeof s.id === "string" && (s.side === "LONG" || s.side === "SHORT") && Number.isFinite(Number(s.createdAt))) {
            const tpIds = Array.isArray(s.tpOrderIds) ? s.tpOrderIds.map(Number).filter(x => Number.isFinite(x) && x > 0) : [];
            // knownOrderIds is the authoritative set — it includes entry + all placed TP IDs
            // as last updated by the backend status poll. Read it directly from storage;
            // fall back to tpOrderIds only if absent (old localStorage format).
            const rawKnown = Array.isArray(s.knownOrderIds)
              ? (s.knownOrderIds as unknown[]).map(Number).filter(x => Number.isFinite(x) && x > 0)
              : tpIds;
            const knownOrderIds = rawKnown.length > 0 ? rawKnown : tpIds;
            let cycleConfig: CycleConfig | undefined;
            if (s.cycleConfig && typeof s.cycleConfig === "object") {
              const cc = s.cycleConfig as Partial<CycleConfig>;
              if (typeof cc.anchorPrice === "string" && Array.isArray(cc.rows) && typeof cc.stepSize === "number" && typeof cc.tickSize === "number" && (cc.direction === "LONG" || cc.direction === "SHORT")) {
                cycleConfig = { anchorPrice: cc.anchorPrice, rows: cc.rows as CycleConfig["rows"], stepSize: cc.stepSize, tickSize: cc.tickSize, direction: cc.direction, positionSide: cc.positionSide, entryQty: Number(cc.entryQty ?? 0) };
              }
            }
            return { id: s.id, slot, side: s.side, entryOrderId: Number.isFinite(Number(s.entryOrderId)) ? Number(s.entryOrderId) : null, tpOrderIds: tpIds, createdAt: Number(s.createdAt), backendActive: true, backendLastError: null, streamConnected: undefined, streamError: null, knownOrderIds, cycleConfig };
          }
          return null;
        }).filter((x): x is TradeSession => x !== null);
      } catch { return []; }
    };
    try {
      const rawA = localStorage.getItem(tradeSessionStorageKey(symbol, "A"));
      const rawB = localStorage.getItem(tradeSessionStorageKey(symbol, "B"));
      setTradeSessions([...parseSlotSessions(rawA, "A"), ...parseSlotSessions(rawB, "B")]);
    } catch { setTradeSessions([]); }
    trackedEntryOrderIdsRef.current = new Set();
    anchorSourcePriceByOrderIdRef.current = new Map();
    try { localStorage.removeItem(entryOrderIdsStorageKey(symbol)); } catch { /* ignore */ }
    const p = loadFormPrefsForSymbol(symbol);
    if (p.gridSide === "LONG" || p.gridSide === "SHORT") {
      setAccountDirections(loadedSlot === "A" ? { A: p.gridSide, B: oppositeDirection(p.gridSide) } : { A: oppositeDirection(p.gridSide), B: p.gridSide });
    }
    const an = p.anchor?.trim();
    if (an) { const n = Number(an); if (Number.isFinite(n) && n > 0) setAnchor(an); }
  }, [symbol]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    try { localStorage.setItem(tradingAccountSlotKey(symbol), activeSlot); } catch { /* ignore */ }
  }, [activeSlot, symbol]);
  useEffect(() => {
    try { localStorage.setItem(tradingDirectionPairKey(symbol), JSON.stringify(accountDirections)); } catch { /* ignore */ }
  }, [accountDirections, symbol]);
  useEffect(() => {
    for (const slot of ["A", "B"] as const) {
      const ss = tradeSessions.filter(s => s.slot === slot);
      try {
        if (ss.length > 0) localStorage.setItem(tradeSessionStorageKey(symbol, slot), JSON.stringify(ss));
        else localStorage.removeItem(tradeSessionStorageKey(symbol, slot));
      } catch { /* ignore */ }
    }
  }, [symbol, tradeSessions]);
  useEffect(() => {
    persistFormPrefsForSymbol(symbol, { anchor, gridSide: direction });
  }, [anchor, direction, symbol]);

  /* ── Mark price ── */
  const anchorVsMarkPct = useMemo(() => {
    const a = Number(anchor), m = markRaw !== null ? Number(markRaw) : NaN;
    if (!Number.isFinite(a) || a <= 0 || !Number.isFinite(m) || m <= 0) return null;
    return Math.abs(a - m) / m;
  }, [anchor, markRaw]);

  useEffect(() => {
    const symChanged = anchorSyncedForSymbolRef.current !== symbol;
    const cached = markCacheRef.current[symbol];
    let cancelled = false;
    if (cached) setMarkRaw(cached);
    if (symChanged && !cached) { setMarkLoading(true); setMarkErr(null); }
    void (async () => {
      try {
        const raw = await fetchMarkPrice(symbol);
        if (cancelled) return;
        markCacheRef.current[symbol] = raw;
        setMarkRaw(raw);
        if (symChanged) { setAnchor(roundToStep(Number(raw), filters.tickSize, "round")); anchorSyncedForSymbolRef.current = symbol; setMarkErr(null); }
      } catch (e) {
        if (!cancelled && symChanged) { setMarkErr(e instanceof Error ? e.message : "Mark price failed"); setMarkRaw(null); }
      } finally {
        if (!cancelled && symChanged && !cached) setMarkLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [filters.tickSize, symbol]);

  const snapAnchorToMark = useCallback(() => {
    if (markRaw) setAnchor(roundToStep(Number(markRaw), filters.tickSize, "round"));
  }, [filters.tickSize, markRaw]);

  /* ── TP preview ── */
  const splitTpPreview = useMemo(() => {
    const entry = Number(anchor), totalQuote = Number(entryQuoteTotal), baseQtyRaw = Number(entryBaseQty);
    const volPct = Number(tpVolumePct), gap = Number(splitTpStepPct);
    if (!Number.isFinite(entry) || entry <= 0) return null;
    if (entryMode === "QUOTE" && (!Number.isFinite(totalQuote) || totalQuote <= 0)) return null;
    if (entryMode === "BASE" && (!Number.isFinite(baseQtyRaw) || baseQtyRaw <= 0)) return null;
    if (!Number.isFinite(volPct) || volPct <= 0 || volPct > 100) return null;
    if (!Number.isFinite(gap) || gap <= 0) return null;
    const entryQty = entryMode === "QUOTE"
      ? Number(roundToStep(totalQuote / entry, filters.stepSize, "floor"))
      : Number(roundToStep(baseQtyRaw, filters.stepSize, "floor"));
    if (!(entryQty > 0)) return null;
    const lv = Math.min(200, Math.max(1, Math.floor(100 / volPct)));
    const unitQty = Number(roundToStep(entryQty * (volPct / 100), filters.stepSize, "floor"));
    if (!(unitQty > 0)) return null;
    const rows: Array<{ level: number; percent: number; qty: number; price: string }> = [];
    for (let i = 1; i <= lv; i++) {
      const price = roundToStep(entry * tpPriceFactor(direction, gap, i), filters.tickSize, "round");
      if (!(Number(price) > 0)) continue;
      rows.push({ level: i, percent: volPct, qty: unitQty, price });
    }
    const usedPercent = Math.min(100, rows.length * volPct);
    const palette = ["#4f46e5","#7c3aed","#2563eb","#0891b2","#059669","#d97706","#dc2626","#db2777"];
    let from = 0;
    const segs: string[] = [];
    for (let i = 0; i < rows.length; i++) {
      const to = Math.min(100, from + rows[i].percent);
      segs.push(`${palette[i % palette.length]} ${from}% ${to}%`);
      from = to; if (from >= 100) break;
    }
    if (from < 100) segs.push(`#e2e8f0 ${from}% 100%`);
    return { entryPrice: roundToStep(entry, filters.tickSize, "round"), entryQty, entryQuote: entryMode === "QUOTE" ? totalQuote : entryQty * entry, usedPercent, availablePercent: Math.max(0, 100 - usedPercent), arcGradient: `conic-gradient(${segs.join(", ")})`, rows };
  }, [anchor, entryBaseQty, entryMode, entryQuoteTotal, filters.stepSize, filters.tickSize, splitTpStepPct, tpVolumePct, direction]);

  useEffect(() => {
    if (!splitTpPreview) { setRemovedTpLevels([]); return; }
    setRemovedTpLevels(prev => prev.filter(lv => splitTpPreview.rows.some(r => r.level === lv)));
  }, [splitTpPreview]);

  const activeSplitTpRows = useMemo(() => {
    if (!splitTpPreview) return [];
    const removed = new Set(removedTpLevels);
    return splitTpPreview.rows.filter(r => !removed.has(r.level));
  }, [removedTpLevels, splitTpPreview]);

  const splitApprox = useMemo(() => {
    if (!splitTpPreview) return null;
    const entryPriceNum = Number(splitTpPreview.entryPrice);
    if (!(entryPriceNum > 0)) return null;
    let quoteOut = 0, usedQty = 0;
    for (const r of activeSplitTpRows) { quoteOut += Number(r.price) * r.qty; usedQty += r.qty; }
    const profit = pnlFromCycle(direction, entryPriceNum, quoteOut, usedQty);
    return { profit, roi: splitTpPreview.entryQuote > 0 ? (profit / splitTpPreview.entryQuote) * 100 : 0, usedQty };
  }, [activeSplitTpRows, direction, splitTpPreview]);

  const confirmRows = useMemo(() =>
    activeSplitTpRows.map((r, idx) => ({
      idx: idx + 1,
      percent: Number((((Number(r.price) / Number(splitTpPreview?.entryPrice || r.price)) - 1) * 100).toFixed(2)),
      qty: r.qty,
      price: r.price,
    })),
    [activeSplitTpRows, splitTpPreview]
  );

  /* ── Actions ── */
  const refreshExchangeSnapshot = useCallback(async () => {
    if (!apiKey || !apiSecret) return;
    setSyncBusy(true);
    try {
      const [oo, tr] = await Promise.all([
        getOpenOrders(apiKey, apiSecret, symbol),
        fetchUserTrades(apiKey, apiSecret, symbol, { limit: 40 }),
      ]);
      const open = (Array.isArray(oo) ? oo : []).map(o => ({ orderId: o.orderId, side: o.side, price: o.price, origQty: o.origQty, executedQty: o.executedQty }));
      const fills = (Array.isArray(tr) ? tr : []).slice().sort((a, b) => b.id - a.id).slice(0, 25).map(t => ({ id: t.id, orderId: t.orderId, side: t.side, price: t.price, qty: t.qty }));
      setOpenOrders(open); setRecentFills(fills);
      try { localStorage.setItem(exchangeSnapshotStorageKey(symbol), JSON.stringify({ open, fills })); } catch { /* ignore */ }
    } catch (e) {
      setAcctMsg(e instanceof Error ? `Snapshot: ${e.message}` : "Snapshot failed");
    } finally { setSyncBusy(false); }
  }, [apiKey, apiSecret, symbol]);

  const cancelAnyOrder = useCallback(async (orderId: number) => {
    if (!apiKey || !apiSecret) return;
    setBusy(true);
    try { await cancelOrderById(apiKey, apiSecret, symbol, orderId); setAcctMsg(`Canceled order #${orderId}.`); }
    catch (e) { setAcctMsg(e instanceof Error ? e.message : "Cancel order failed"); }
    finally { setBusy(false); }
  }, [apiKey, apiSecret, symbol]);

  const cancelTradeSession = useCallback(async (sessionId: string) => {
    const target = tradeSessions.find(s => s.id === sessionId) || null;
    const targetSlot = target?.slot ?? activeSlot;
    const { apiKey: k, apiSecret: sk } = accounts[targetSlot];
    if (!k || !sk) return;
    setBusy(true);
    try { await stopBackendCycleWorker(sessionId, { cancelOrders: true, apiKey: k, apiSecret: sk, symbol, knownOrderIds: target?.knownOrderIds || [] }); }
    catch { /* ignore */ }
    finally { setTradeSessions(prev => prev.filter(s => s.id !== sessionId)); setBusy(false); }
  }, [accounts, activeSlot, symbol, tradeSessions]);

  const cancelAllForHedgeMode = useCallback(async () => {
    if (!apiKey || !apiSecret) return;
    setBusy(true); setAcctMsg(null); setOpenPositions([]);
    try {
      const ss = tradeSessions.filter(s => s.slot === activeSlot);
      await Promise.all(ss.map(s => stopBackendCycleWorker(s.id, { cancelOrders: false, apiKey, apiSecret, symbol, knownOrderIds: s.knownOrderIds || [] }).catch(() => {})));
      setTradeSessions(prev => prev.filter(s => s.slot !== activeSlot));
      await cancelAllOpenOrders(apiKey, apiSecret, symbol);
      await refreshExchangeSnapshot();
      const positions = await fetchPositions(apiKey, apiSecret, symbol);
      setOpenPositions(positions);
      setAcctMsg(positions.length > 0
        ? `Orders cancelled. ${positions.length} position(s) still open — close them below.`
        : `All ${symbol} orders cleared on Account ${activeSlot}. Now switch Position Mode on Binance to Hedge Mode.`
      );
    } catch (e) { setAcctMsg(e instanceof Error ? `Failed: ${e.message}` : "Cancel all failed"); }
    finally { setBusy(false); }
  }, [activeSlot, apiKey, apiSecret, refreshExchangeSnapshot, symbol, tradeSessions]);

  const closePosition = useCallback(async (pos: FuturesPosition) => {
    if (!apiKey || !apiSecret) return;
    setBusy(true);
    try {
      await closePositionAtMarket(apiKey, apiSecret, symbol, pos.positionAmt, pos.positionSide);
      const remaining = await fetchPositions(apiKey, apiSecret, symbol);
      setOpenPositions(remaining);
      setAcctMsg(remaining.length === 0 ? "All positions closed." : `Closed. ${remaining.length} position(s) remaining.`);
    } catch (e) { setAcctMsg(e instanceof Error ? `Close failed: ${e.message}` : "Close failed"); }
    finally { setBusy(false); }
  }, [apiKey, apiSecret, symbol]);

  const restartSession = useCallback(async (s: TradeSession) => {
    if (!s.cycleConfig || !s.entryOrderId) return;
    const { apiKey: k, apiSecret: sk } = accounts[s.slot];
    if (!k || !sk) return;
    setBusy(true);
    try {
      // Pass all previously-known order IDs so the backend can skip bootstrap and
      // avoid placing duplicate TP orders on top of still-open ones.
      const existingOrderIds = (s.knownOrderIds ?? []).filter(id => Number.isFinite(id) && id > 0);
      const started = await startBackendCycleWorker({ sessionId: s.id, apiKey: k, apiSecret: sk, symbol, direction: s.cycleConfig.direction, anchorPrice: s.cycleConfig.anchorPrice, stepSize: String(s.cycleConfig.stepSize), tickSize: String(s.cycleConfig.tickSize), entryOrderId: s.entryOrderId, rows: s.cycleConfig.rows, positionSide: s.cycleConfig.positionSide, existingOrderIds });
      if (started?.ok) setTradeSessions(prev => prev.map(x => x.id === s.id ? { ...x, backendActive: true, backendLastError: null } : x));
    } catch (e) {
      setTradeSessions(prev => prev.map(x => x.id === s.id ? { ...x, backendActive: false, backendLastError: e instanceof Error ? e.message : "restart failed" } : x));
    } finally { setBusy(false); }
  }, [accounts, symbol]);

  const clearAllSessions = useCallback(async () => {
    const targets = tradeSessions.filter(s => s.slot === activeSlot);
    if (targets.length === 0) return;
    if (!window.confirm(`Remove all ${targets.length} session(s) for Account ${activeSlot}? This clears the UI only — open orders on Binance are NOT canceled.`)) return;
    setBusy(true);
    try {
      await Promise.allSettled(targets.map(s =>
        stopBackendCycleWorker(s.id, { cancelOrders: false, apiKey: accounts[s.slot].apiKey, apiSecret: accounts[s.slot].apiSecret, symbol, knownOrderIds: s.knownOrderIds || [] }).catch(() => {})
      ));
    } finally {
      setTradeSessions(prev => prev.filter(s => s.slot !== activeSlot));
      setBusy(false);
    }
  }, [accounts, activeSlot, symbol, tradeSessions]);

  const restartAllOffline = useCallback(async () => {
    const targets = tradeSessions.filter(s => s.slot === activeSlot && !s.backendActive && s.cycleConfig && s.entryOrderId);
    if (targets.length === 0) return;
    setBusy(true);
    try {
      // Stagger requests 100ms apart so that 17 simultaneous restarts don't all fire their
      // backend restart polls at the same instant and overload Binance's rate limit.
      const results = await Promise.allSettled(targets.map(async (s, idx) => {
        if (idx > 0) await new Promise<void>(r => setTimeout(r, idx * 100));
        const { apiKey: k, apiSecret: sk } = accounts[s.slot];
        if (!k || !sk) return;
        const existingOrderIds = (s.knownOrderIds ?? []).filter(id => Number.isFinite(id) && id > 0);
        const started = await startBackendCycleWorker({ sessionId: s.id, apiKey: k, apiSecret: sk, symbol, direction: s.cycleConfig!.direction, anchorPrice: s.cycleConfig!.anchorPrice, stepSize: String(s.cycleConfig!.stepSize), tickSize: String(s.cycleConfig!.tickSize), entryOrderId: s.entryOrderId!, rows: s.cycleConfig!.rows, positionSide: s.cycleConfig!.positionSide, existingOrderIds });
        if (started?.ok) setTradeSessions(prev => prev.map(x => x.id === s.id ? { ...x, backendActive: true, backendLastError: null } : x));
      }));
      const failed = results.filter(r => r.status === "rejected").length;
      if (failed > 0) setAcctMsg(`${targets.length - failed} restarted, ${failed} failed.`);
    } finally { setBusy(false); }
  }, [accounts, activeSlot, symbol, tradeSessions]);

  const placeEntryAndSplitTp = useCallback(async () => {
    setAcctMsg(null);
    if (!apiKey || !apiSecret) { setAcctMsg("Add API key and secret in Settings."); return; }
    if (!splitTpPreview || activeSplitTpRows.length === 0) { setAcctMsg("Preview not valid — check all fields."); return; }
    if (!hedgeMode) {
      const opp = tradeSessions.filter(s => s.slot === activeSlot && s.side !== direction);
      if (opp.length > 0) { setAcctMsg(`Blocked: Account ${activeSlot} already has a ${opp[0].side} session. Switch to Hedge Mode or use a separate account.`); return; }
      const other: "A" | "B" = activeSlot === "A" ? "B" : "A";
      if (accounts[other].apiKey && accounts[other].apiKey === apiKey) {
        const otherOpp = tradeSessions.filter(s => s.slot === other && s.side !== direction);
        if (otherOpp.length > 0) { setAcctMsg(`Blocked: Account ${other} has a ${otherOpp[0].side} session on the same key.`); return; }
      }
    }
    setBusy(true);
    try {
      const { entrySide, tpSide } = sidesForDirection(direction);
      const placed = await newOrder({ apiKey, apiSecret, symbol, side: entrySide, type: "LIMIT", quantity: String(splitTpPreview.entryQty), price: splitTpPreview.entryPrice, timeInForce: "GTC", positionSide: hedgeMode ? direction : undefined, reduceOnly: false }) as { orderId?: number } | unknown;
      let placedId: number | null = null;
      if (placed && typeof placed === "object" && "orderId" in placed && Number.isFinite(Number((placed as { orderId?: unknown }).orderId))) placedId = Number((placed as { orderId?: unknown }).orderId);
      const nextSession: TradeSession = { id: `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, slot: activeSlot, side: direction, entryOrderId: placedId, tpOrderIds: [], createdAt: Date.now(), backendActive: false, backendLastError: null, streamConnected: undefined, streamError: null, knownOrderIds: placedId ? [placedId] : [], cycleConfig: { anchorPrice: splitTpPreview.entryPrice, rows: activeSplitTpRows.map(r => ({ price: r.price, percent: r.percent })), stepSize: filters.stepSize, tickSize: filters.tickSize, direction, positionSide: hedgeMode ? direction : undefined, entryQty: splitTpPreview.entryQty } };
      setTradeSessions(prev => [nextSession, ...prev]);
      setAcctMsg(`Entry ${entrySide} ${splitTpPreview.entryQty} @ ${splitTpPreview.entryPrice} placed. TP ${tpSide} orders will auto-send after fill.`);
      if (placedId) {
        try {
          const started = await startBackendCycleWorker({ sessionId: nextSession.id, apiKey, apiSecret, symbol, direction, anchorPrice: splitTpPreview.entryPrice, stepSize: String(filters.stepSize), tickSize: String(filters.tickSize), entryOrderId: placedId, rows: activeSplitTpRows.map(r => ({ price: r.price, percent: r.percent })), positionSide: hedgeMode ? direction : undefined });
          if (started?.ok) setTradeSessions(prev => prev.map(s => s.id === nextSession.id ? { ...s, backendActive: true } : s));
        } catch (e) {
          setTradeSessions(prev => prev.map(s => s.id === nextSession.id ? { ...s, backendActive: false, backendLastError: e instanceof Error ? e.message : "backend start failed" } : s));
        }
      }
    } catch (e) { setAcctMsg(e instanceof Error ? e.message : "Entry order failed"); }
    finally { setBusy(false); }
  }, [apiKey, apiSecret, hedgeMode, activeSplitTpRows, splitTpPreview, symbol, filters, direction, activeSlot, accounts, tradeSessions]);

  /* ── SSE feed ── */
  useEffect(() => {
    if (!credentialsReady || !apiKey || !apiSecret) return;
    const params = new URLSearchParams({ symbol, apiKey, apiSecret });
    const es = new EventSource(`/api/binance/events?${params}`);
    es.addEventListener("markPrice", (e: MessageEvent) => {
      try { const d = JSON.parse(e.data) as { price?: string }; if (d.price) { setMarkRaw(d.price); markCacheRef.current[symbol] = d.price; } } catch { /* ignore */ }
    });
    es.addEventListener("orderUpdate", (e: MessageEvent) => {
      try {
        const d = JSON.parse(e.data) as { orderId: number; symbol?: string; side: "BUY"|"SELL"; orderStatus: string; executionType: string; price: string; origQty: string; executedQty: string; lastFillQty: number; lastFillPrice: number; tradeId: number };
        // The backend already filters by symbol in broadcastOrderUpdate, but defense in depth:
        // ignore fills for a different symbol in case a stale SSE connection delivers stale data.
        if (d.symbol && d.symbol.toUpperCase() !== symbol.toUpperCase()) return;
        if (d.orderStatus === "FILLED" || d.orderStatus === "CANCELED" || d.orderStatus === "EXPIRED") setOpenOrders(p => p.filter(o => o.orderId !== d.orderId));
        else if (d.orderStatus === "NEW") setOpenOrders(p => p.some(o => o.orderId === d.orderId) ? p : [{ orderId: d.orderId, side: d.side, price: d.price, origQty: d.origQty, executedQty: "0" }, ...p]);
        else if (d.orderStatus === "PARTIALLY_FILLED") setOpenOrders(p => p.map(o => o.orderId === d.orderId ? { ...o, executedQty: d.executedQty } : o));
        if (d.executionType === "TRADE" && d.tradeId > 0) setRecentFills(p => [{ id: d.tradeId, orderId: d.orderId, side: d.side, price: String(d.lastFillPrice), qty: String(d.lastFillQty) }, ...p.filter(f => f.id !== d.tradeId)].slice(0, 25));
      } catch { /* ignore */ }
    });
    return () => es.close();
  }, [apiKey, apiSecret, credentialsReady, symbol]);

  /* ── Keep ref in sync with state (before polling effect reads it) ── */
  useEffect(() => { tradeSessionsRef.current = tradeSessions; }, [tradeSessions]);

  /* ── Session status polling ──
     IMPORTANT: tradeSessions is intentionally NOT in the dep array.
     The ref above keeps it current without restarting the interval on every
     status update (which would cause a polling storm).
     tickRunningRef prevents overlapping ticks when a poll round takes >2s. */
  useEffect(() => {
    if (!credentialsReady) return;
    let cancelled = false;
    const tick = async () => {
      if (tickRunningRef.current) return;
      tickRunningRef.current = true;
      const sessions = tradeSessionsRef.current;
      if (sessions.length === 0) { tickRunningRef.current = false; return; }
      const updates = await Promise.all(sessions.map(async s => {
        try {
          const st = await getBackendCycleStatus(s.id);
          return { id: s.id, backendActive: true, backendLastError: st.lastError, streamConnected: st.streamConnected, streamError: st.streamError || null, knownOrderIds: (st.knownOrderIds || []).map(Number).filter(x => Number.isFinite(x) && x > 0), placementGaps: Number(st.placementGaps || 0), cycleGaps: Number(st.cycleGaps || 0) };
        } catch (e) {
          return { id: s.id, backendActive: false, backendLastError: e instanceof Error ? e.message : "status failed", streamConnected: undefined, streamError: null, knownOrderIds: s.knownOrderIds || [], placementGaps: s.placementGaps ?? 0, cycleGaps: s.cycleGaps ?? 0 };
        }
      }));
      if (!cancelled) setTradeSessions(prev => prev.map(s => { const u = updates.find(x => x.id === s.id); return u ? { ...s, ...u } : s; }));
      tickRunningRef.current = false;
    };
    const id = window.setInterval(() => void tick(), 2000);
    void tick();
    return () => { cancelled = true; window.clearInterval(id); tickRunningRef.current = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credentialsReady]);

  useEffect(() => {
    if (!credentialsReady) return;
    void refreshExchangeSnapshot();
  }, [credentialsReady, refreshExchangeSnapshot, symbol]);

  useEffect(() => {
    if (!credentialsReady) return;
    const id = window.setInterval(() => { if (!busy && !syncBusy) void refreshExchangeSnapshot(); }, ORDERS_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [busy, credentialsReady, refreshExchangeSnapshot, syncBusy]);

  const visibleSessions = useMemo(() => tradeSessions.filter(s => s.slot === activeSlot), [activeSlot, tradeSessions]);

  const openOrdersByGroup = useMemo(() => {
    const mapped = visibleSessions.map(s => {
      const known = new Set((s.knownOrderIds || []).map(Number));
      return { session: s, orders: openOrders.filter(o => known.has(Number(o.orderId))) };
    });
    const allKnown = new Set(mapped.flatMap(m => m.orders.map(o => Number(o.orderId))).filter(Number.isFinite));
    return { mapped, unassigned: openOrders.filter(o => !allKnown.has(Number(o.orderId))) };
  }, [openOrders, visibleSessions]);

  /* ─────────────────────────────────────────────
     Render — 2-column horizontal split
     Left: config form   Right: live orders
  ───────────────────────────────────────────── */
  return (
    <div className="flex h-full w-full flex-col overflow-y-auto pb-16 md:flex-row md:overflow-hidden md:pb-0">

      {/* ═══════════════════════════════════════
          LEFT PANEL — Strategy configuration
      ═══════════════════════════════════════ */}
      <div className="flex w-full flex-col border-b border-slate-200 bg-white md:w-[420px] md:shrink-0 md:overflow-y-auto md:border-b md:border-r">
        {/* Panel header */}
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-indigo-500" strokeWidth={2} />
            <span className="text-sm font-semibold text-slate-800">Configure</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className={`text-[10px] font-bold uppercase tracking-wider ${direction === "LONG" ? "text-emerald-600" : "text-red-600"}`}>
              {direction}
            </span>
            <span className="text-slate-300">·</span>
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              {symbolToPairLabel(symbol)}
            </span>
          </div>
        </div>

        {/* Form body */}
        <div className="flex flex-col gap-5 p-5">

          {/* Account selector */}
          <div>
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-400">Account</label>
            <div className="flex overflow-hidden rounded-lg border border-slate-200 bg-slate-50 p-0.5">
              {(["A", "B"] as const).map(slot => {
                const slotSessions = tradeSessions.filter(s => s.slot === slot);
                const offlineCount = slotSessions.filter(s => !s.backendActive).length;
                return (
                  <button key={slot} type="button" onClick={() => setActiveSlot(slot)}
                    className={`relative flex-1 rounded-md py-1.5 text-xs font-semibold transition ${activeSlot === slot ? "bg-white text-indigo-700 shadow-sm ring-1 ring-slate-200" : "text-slate-500 hover:text-slate-700"}`}>
                    Account {slot}
                    {slotSessions.length > 0 && (
                      <span className={`ml-1 inline-flex items-center rounded-full px-1.5 text-[9px] font-bold ${offlineCount > 0 ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"}`}>
                        {slotSessions.length}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Position side */}
          <div>
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-400">Direction</label>
            <div className="flex overflow-hidden rounded-lg border border-slate-200 bg-slate-50 p-0.5">
              <button type="button"
                onClick={() => setAccountDirections(activeSlot === "A" ? { A: "LONG", B: "SHORT" } : { A: "SHORT", B: "LONG" })}
                className={`flex-1 rounded-md py-1.5 text-xs font-bold transition ${direction === "LONG" ? "bg-emerald-600 text-white shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
                LONG
              </button>
              <button type="button"
                onClick={() => setAccountDirections(activeSlot === "A" ? { A: "SHORT", B: "LONG" } : { A: "LONG", B: "SHORT" })}
                className={`flex-1 rounded-md py-1.5 text-xs font-bold transition ${direction === "SHORT" ? "bg-red-600 text-white shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
                SHORT
              </button>
            </div>
            <FieldHint>Opposite accounts auto-lock: Account {activeSlot === "A" ? "B" : "A"} is set to {oppositeDirection(direction)}.</FieldHint>
          </div>

          {/* Position mode */}
          <div>
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-400">Position mode</label>
            <div className="flex overflow-hidden rounded-lg border border-slate-200 bg-slate-50 p-0.5">
              <button type="button" onClick={() => setHedgeMode(false)}
                className={`flex-1 rounded-md py-1.5 text-xs font-semibold transition ${!hedgeMode ? "bg-white text-indigo-700 shadow-sm ring-1 ring-slate-200" : "text-slate-500 hover:text-slate-700"}`}>
                One-Way
              </button>
              <button type="button" onClick={() => setHedgeMode(true)}
                className={`flex-1 rounded-md py-1.5 text-xs font-semibold transition ${hedgeMode ? "bg-amber-500 text-white shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
                Hedge Mode
              </button>
            </div>
            {!hedgeMode && credentialsReady && (
              <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
                <p className="text-[11px] font-semibold text-amber-800">Need LONG + SHORT on same account?</p>
                <p className="mt-0.5 text-[11px] text-amber-700">Clear all orders and positions first, then enable Hedge Mode on Binance.</p>
                <button type="button" disabled={busy || !apiKey} onClick={() => void cancelAllForHedgeMode()}
                  className="mt-2 rounded-md border border-amber-300 bg-amber-100 px-2.5 py-1 text-[11px] font-semibold text-amber-800 hover:bg-amber-200 disabled:opacity-40">
                  Cancel all {symbol} orders →
                </button>
                {openPositions.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {openPositions.map(pos => {
                      const amt = Number(pos.positionAmt), side = amt > 0 ? "LONG" : "SHORT";
                      return (
                        <div key={pos.positionSide + pos.symbol} className="flex items-center justify-between rounded border border-red-200 bg-red-50 px-2 py-1">
                          <span className="font-mono text-[11px] text-slate-700">{side} {Math.abs(amt)} @ {Number(pos.entryPrice).toFixed(4)}</span>
                          <button type="button" disabled={busy} onClick={() => void closePosition(pos)} className="rounded border border-red-300 bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-700 hover:bg-red-200 disabled:opacity-40">Close Market</button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Entry price */}
          <div>
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              Entry price <span className="normal-case text-slate-300">(take-profit line)</span>
            </label>
            <div className="flex gap-2">
              <input value={anchor} onChange={e => setAnchor(e.target.value)} inputMode="decimal"
                className="ui-input min-w-0 flex-1 font-mono text-[13px]" />
              <button type="button" disabled={!markRaw} onClick={snapAnchorToMark}
                className="shrink-0 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-semibold text-indigo-600 hover:bg-indigo-100 disabled:opacity-40">
                Use mark
              </button>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-400">
              {markLoading && <span>Loading mark…</span>}
              {!markLoading && markErr && <span className="text-red-500">{markErr}</span>}
              {!markLoading && !markErr && markRaw && (
                <>
                  <span>Mark: <span className="font-mono text-slate-700">{markRaw}</span></span>
                  <button type="button" onClick={() => { setMarkLoading(true); void (async () => { try { const r = await fetchMarkPrice(symbol); setMarkRaw(r); setMarkErr(null); } catch (e) { setMarkErr(e instanceof Error ? e.message : "Failed"); } finally { setMarkLoading(false); } })(); }} className="font-medium text-indigo-500 underline decoration-indigo-300 underline-offset-2 hover:text-indigo-700">Refresh</button>
                </>
              )}
            </div>
            {anchorVsMarkPct !== null && anchorVsMarkPct > 0.02 && (
              <p className="mt-1 text-[11px] text-amber-600">
                {(anchorVsMarkPct * 100).toFixed(1)}% from mark —{" "}
                <button type="button" onClick={snapAnchorToMark} className="font-medium text-amber-700 underline hover:text-amber-900">snap to mark</button>
              </p>
            )}
          </div>

          {/* TP configuration box */}
          <div className="rounded-xl border border-indigo-100 bg-indigo-50/60 p-4">
            <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-indigo-600">
              Split TP settings
            </p>

            {/* Total buy */}
            <div className="mb-3">
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-slate-500">Total buy</label>
              <div className="flex overflow-hidden rounded-lg border border-slate-200 bg-white">
                <input type="number" min={0}
                  value={numberOrEmpty(entryMode === "QUOTE" ? entryQuoteTotal : entryBaseQty)}
                  onChange={e => entryMode === "QUOTE" ? setEntryQuoteTotal(e.target.value === "" ? NaN : Number(e.target.value)) : setEntryBaseQty(e.target.value === "" ? NaN : Number(e.target.value))}
                  className="min-w-0 flex-1 bg-transparent px-3 py-2 font-mono text-[13px] text-slate-800 outline-none placeholder:text-slate-400" />
                <div className="flex items-center gap-0.5 p-1">
                  {(["BASE", "QUOTE"] as const).map(mode => (
                    <button key={mode} type="button" onClick={() => setEntryMode(mode)}
                      className={`rounded px-2 py-1 text-[11px] font-bold transition ${entryMode === mode ? "bg-indigo-600 text-white" : "text-slate-400 hover:text-slate-700"}`}>
                      {mode === "BASE" ? pairAssets.base : pairAssets.quote}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Vol & spacing */}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-slate-500">Vol / TP (%)</label>
                <input type="number" step="0.1" min={0.1} max={100} value={numberOrEmpty(tpVolumePct)} onChange={e => setTpVolumePct(e.target.value === "" ? NaN : Number(e.target.value))} className="ui-input w-full tabular-nums text-sm" />
              </div>
              <div>
                <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-slate-500">Spacing (%)</label>
                <input type="number" step="0.01" min={0.01} value={numberOrEmpty(splitTpStepPct)} onChange={e => setSplitTpStepPct(e.target.value === "" ? NaN : Number(e.target.value))} className="ui-input w-full tabular-nums text-sm" />
              </div>
            </div>
            <FieldHint>12.5% vol → 8 TP rows auto-generated. Adjust spacing between each level.</FieldHint>

            {/* Preview */}
            {splitTpPreview ? (
              <div className="mt-3">
                <div className="mb-2 flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-2.5">
                  <div className="relative h-14 w-14 shrink-0 rounded-full" style={{ background: splitTpPreview.arcGradient }}>
                    <div className="absolute inset-[5px] flex items-center justify-center rounded-full bg-white text-center text-[9px] leading-tight text-slate-600">
                      <span><span className="font-bold text-indigo-600">{splitTpPreview.availablePercent.toFixed(0)}%</span><br />avail</span>
                    </div>
                  </div>
                  <div className="min-w-0 text-[11px] text-slate-500">
                    <p><span className="font-semibold text-slate-800">{splitTpPreview.rows.length}</span> TP orders</p>
                    <p>Entry: <span className="font-mono font-semibold text-slate-800">{splitTpPreview.entryQty.toFixed(4)}</span> @ <span className="font-mono font-semibold text-slate-800">{splitTpPreview.entryPrice}</span></p>
                    {splitApprox && (
                      <p className={`font-semibold ${splitApprox.profit >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                        {splitApprox.profit >= 0 ? "+" : ""}${splitApprox.profit.toFixed(4)} ({splitApprox.roi >= 0 ? "+" : ""}{splitApprox.roi.toFixed(2)}%)
                      </p>
                    )}
                  </div>
                </div>

                {/* TP table */}
                <div className="max-h-44 overflow-auto rounded-lg border border-slate-200 bg-white">
                  <table className="w-full text-left text-[11px]">
                    <thead className="bg-slate-50 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                      <tr>
                        <th className="px-2 py-1.5">Pct</th>
                        <th className="px-2 py-1.5">Qty</th>
                        <th className="px-2 py-1.5">Price</th>
                        <th className="px-2 py-1.5 text-right">×</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 font-mono text-slate-700">
                      {splitTpPreview.rows.map(r => (
                        <tr key={`${r.level}-${r.price}`} className={removedTpLevels.includes(r.level) ? "opacity-35 line-through" : ""}>
                          <td className="px-2 py-1">{r.percent.toFixed(1)}%</td>
                          <td className="px-2 py-1">{r.qty.toFixed(4)}</td>
                          <td className="px-2 py-1">{r.price}</td>
                          <td className="px-2 py-1 text-right">
                            <button type="button" onClick={() => setRemovedTpLevels(prev => prev.includes(r.level) ? prev.filter(x => x !== r.level) : [...prev, r.level])}
                              className="inline-flex items-center rounded border border-slate-200 px-1 py-0.5 text-slate-400 hover:border-red-200 hover:bg-red-50 hover:text-red-600">
                              <X className="h-2.5 w-2.5" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <FieldHint>Click × to exclude a row. Remaining rows are sent on entry fill.</FieldHint>
              </div>
            ) : (
              <FieldHint>Fill in all fields above to generate the TP preview table.</FieldHint>
            )}
          </div>

          {/* Send button */}
          <div className="flex flex-col gap-3">
            <button type="button" disabled={busy || !apiKey || !splitTpPreview || activeSplitTpRows.length === 0}
              onClick={() => setShowConfirmModal(true)}
              className="flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-40">
              Send {direction === "LONG" ? "BUY" : "SELL"} entry → auto TP on fill
            </button>
            <button type="button" onClick={() => { try { localStorage.removeItem(entryOrderIdsStorageKey(symbol)); } catch { /* ignore */ } trackedEntryOrderIdsRef.current.clear(); }}
              className="ui-btn-secondary justify-center gap-1.5 py-1.5 text-xs">
              <RotateCcw className="h-3 w-3" strokeWidth={2} />
              Clear tracked entries
            </button>
            {acctMsg && (
              <div className="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2.5 text-xs leading-relaxed text-indigo-800">
                {acctMsg}
              </div>
            )}
          </div>

          {/* Step sizes */}
          <div className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Exchange filters</p>
            <p className="mt-0.5 font-mono text-[11px] text-slate-500">
              Tick {filters.tickSize} · Step {filters.stepSize}
            </p>
          </div>

        </div>
      </div>

      {/* ═══════════════════════════════════════
          RIGHT PANEL — Live orders & sessions
      ═══════════════════════════════════════ */}
      <div className="flex w-full flex-col bg-slate-50 md:min-w-0 md:flex-1 md:overflow-hidden">

        {/* Panel header */}
        <div className="flex shrink-0 items-center justify-between border-b border-slate-200 bg-white px-5 py-3.5">
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold text-slate-800">Live Orders</span>
            {openOrders.length > 0 && (
              <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-bold text-indigo-700">
                {openOrders.length}
              </span>
            )}
          </div>
          <button type="button" disabled={syncBusy || !apiKey} onClick={() => void refreshExchangeSnapshot()}
            className="flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40">
            <RefreshCw className={`h-3 w-3 ${syncBusy ? "animate-spin" : ""}`} strokeWidth={2} />
            {syncBusy ? "Refreshing…" : "Refresh"}
          </button>
        </div>

        {/* Sessions */}
        {visibleSessions.length > 0 && (
          <div className="shrink-0 border-b border-slate-200 bg-white">
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                Sessions ({visibleSessions.length})
                {visibleSessions.filter(s => !s.backendActive).length > 0 && (
                  <span className="ml-2 text-amber-600">
                    · {visibleSessions.filter(s => !s.backendActive).length} offline
                  </span>
                )}
              </p>
              <div className="flex items-center gap-1.5">
                {visibleSessions.some(s => !s.backendActive && s.cycleConfig && s.entryOrderId) && (
                  <button type="button" disabled={busy} onClick={() => void restartAllOffline()}
                    className="rounded border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold text-indigo-700 hover:bg-indigo-100 disabled:opacity-40">
                    Restart all offline
                  </button>
                )}
                <button type="button" disabled={busy} onClick={() => void clearAllSessions()}
                  className="rounded border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-semibold text-slate-500 hover:bg-red-50 hover:border-red-200 hover:text-red-600 disabled:opacity-40">
                  Clear all
                </button>
              </div>
            </div>
            <div className="max-h-48 overflow-y-auto divide-y divide-slate-100">
              {visibleSessions.map(s => (
                <div key={s.id} className="flex items-center justify-between gap-3 px-5 py-2.5">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${s.backendActive ? "bg-emerald-500" : "bg-slate-300"}`} />
                      <span className="truncate font-mono text-[11px] text-slate-600">
                        {s.side} · #{s.entryOrderId ?? "—"} · <span className={s.backendActive ? "font-semibold text-emerald-700" : "text-slate-400"}>{s.backendActive ? "running" : "offline"}</span>
                      </span>
                      {((s.placementGaps ?? 0) + (s.cycleGaps ?? 0)) > 0 && (
                        <span
                          title={[
                            s.placementGaps ? `${s.placementGaps} TP row(s) not placed after entry fill` : "",
                            s.cycleGaps ? `${s.cycleGaps} cycle replacement(s) failed` : "",
                          ].filter(Boolean).join(" · ")}
                          className="shrink-0 rounded bg-red-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-red-700"
                        >
                          {(s.placementGaps ?? 0) + (s.cycleGaps ?? 0)} gap{((s.placementGaps ?? 0) + (s.cycleGaps ?? 0)) > 1 ? "s" : ""}
                        </span>
                      )}
                    </div>
                    {(s.streamError || s.backendLastError) && (
                      <p className="ml-3.5 truncate text-[10px] text-red-500">{s.streamError || s.backendLastError}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {!s.backendActive && s.cycleConfig && s.entryOrderId && (
                      <button type="button" disabled={busy} onClick={() => void restartSession(s)}
                        className="rounded-md border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-[11px] font-semibold text-indigo-700 hover:bg-indigo-100 disabled:opacity-40">
                        Restart
                      </button>
                    )}
                    <button type="button" disabled={busy || !apiKey} onClick={() => void cancelTradeSession(s.id)}
                      className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-700 hover:bg-amber-100 disabled:opacity-40">
                      Stop
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Open orders + Recent fills share the remaining vertical space */}
        <div className="flex flex-col md:min-h-0 md:flex-1 md:overflow-hidden">

          {/* Open orders — 60 % of the shared area */}
          <div className="min-h-0 flex-[3] overflow-y-auto">
            <p className="sticky top-0 z-10 border-b border-slate-200 bg-white px-5 py-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              Open orders ({openOrders.length})
            </p>
            {openOrders.length === 0 ? (
              <p className="px-5 py-6 text-center text-sm text-slate-400">No open orders.</p>
            ) : (
              <div className="divide-y divide-slate-100">
                {openOrdersByGroup.mapped.flatMap(({ session, orders }) =>
                  orders.map(o => (
                    <div key={o.orderId} className="flex items-center justify-between gap-3 px-5 py-2.5">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${o.side === "BUY" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>{o.side}</span>
                          <span className="font-mono text-xs text-slate-700">{o.origQty} @ {o.price}</span>
                        </div>
                        <p className="mt-0.5 text-[10px] text-slate-400">Group …{session.id.slice(-6)} · #{o.orderId}</p>
                      </div>
                      <button type="button" disabled={busy} onClick={() => void cancelAnyOrder(o.orderId)}
                        className="shrink-0 rounded border border-red-200 bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-700 hover:bg-red-100 disabled:opacity-40">
                        Cancel
                      </button>
                    </div>
                  ))
                )}
                {openOrdersByGroup.unassigned.map(o => (
                  <div key={o.orderId} className="flex items-center justify-between gap-3 px-5 py-2.5">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${o.side === "BUY" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>{o.side}</span>
                        <span className="font-mono text-xs text-slate-700">{o.origQty} @ {o.price}</span>
                      </div>
                      <p className="mt-0.5 text-[10px] text-slate-400">#{o.orderId}</p>
                    </div>
                    <button type="button" disabled={busy} onClick={() => void cancelAnyOrder(o.orderId)}
                      className="shrink-0 rounded border border-red-200 bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-700 hover:bg-red-100 disabled:opacity-40">
                      Cancel
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Recent fills — 40 % of the shared area, independently scrollable */}
          <div className="min-h-[10rem] flex-[2] overflow-y-auto border-t border-slate-200 bg-white">
            <p className="sticky top-0 z-10 border-b border-slate-200 bg-white px-5 py-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              Recent fills ({recentFills.length})
            </p>
            {recentFills.length === 0 ? (
              <p className="px-5 py-4 text-center text-sm text-slate-400">No recent fills.</p>
            ) : (
              <div className="divide-y divide-slate-100">
                {recentFills.map(t => (
                  <div key={t.id} className="flex items-center gap-3 px-5 py-2">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${t.side === "BUY" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>{t.side}</span>
                    <span className="font-mono text-xs text-slate-600">{t.qty} @ {t.price}</span>
                    <span className="ml-auto text-[10px] text-slate-400">#{t.orderId}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

        </div>
      </div>

      {/* ─── Confirm modal ─── */}
      {showConfirmModal && splitTpPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-5 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900">Confirm order</h3>
              <button type="button" onClick={() => setShowConfirmModal(false)} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-1.5 text-sm">
              {[
                ["Pair", symbolToPairLabel(symbol)],
                ["Side", direction],
                ["Units", `${splitTpPreview.entryQty.toFixed(6)} ${pairAssets.base}`],
                ["Entry", splitTpPreview.entryPrice],
                ["Total", `${splitTpPreview.entryQuote.toFixed(2)} ${pairAssets.quote}`],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between rounded-md bg-slate-50 px-3 py-1.5">
                  <span className="text-slate-500">{k}</span>
                  <span className={`font-mono font-semibold ${k === "Side" ? (direction === "LONG" ? "text-emerald-700" : "text-red-700") : "text-slate-900"}`}>{v}</span>
                </div>
              ))}
              <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Take-profit rows</p>
                <div className="max-h-32 overflow-auto space-y-0.5">
                  {confirmRows.map(r => (
                    <p key={`${r.idx}-${r.price}`} className="font-mono text-xs text-slate-600">
                      {r.percent >= 0 ? "+" : ""}{r.percent.toFixed(2)}% · {r.price} · {r.qty.toFixed(6)}
                    </p>
                  ))}
                </div>
              </div>
            </div>
            <div className="mt-4 flex gap-2">
              <button type="button" onClick={() => setShowConfirmModal(false)} className="ui-btn-secondary flex-1 text-sm">Cancel</button>
              <button type="button" disabled={busy} onClick={() => { setShowConfirmModal(false); void placeEntryAndSplitTp(); }}
                className="flex-1 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-40">
                Confirm &amp; Send
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
