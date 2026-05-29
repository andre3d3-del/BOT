/**
 * USD-M futures “3Commas-style” TP ladder (1–20 levels, spacing %).
 *
 * **Short (sold at anchor):** Limit **buys** on each step below the anchor ($/step sized). Each time a
 * step buy **fills**, we add another **sell** limit at the **same anchor price** (`consolidatedLimitSide`)
 * for that fill qty — Binance shows many lines at one price (**unlimited** separate orders).
 *
 * **Long:** Mirror — step **sells** above anchor, each fill adds a **buy** at the anchor.
 *
 * Optional: when a TP-side fill hits the anchor, **`reentrySide`** places one limit back at the anchor
 * to **re-open / accumulate** (same size as that fill — enable in UI).
 */

import { roundToStep } from "./symbolFilters";

/** Single anchor price used for all TP / re-entry / cancel-matching (must match `newOrder` limit price). */
export function anchorLimitPriceStr(anchorPrice: number, tickSize: number): string {
  return roundToStep(anchorPrice, tickSize, "round");
}

export function anchorLimitPriceNum(anchorPrice: number, tickSize: number): number {
  return Number(anchorLimitPriceStr(anchorPrice, tickSize));
}

export type GridSide = "LONG" | "SHORT";

export type LadderLeg = {
  levelIndex: number;
  price: number;
  quoteNotional: number;
  /** Base qty = quote / leg price */
  baseQty: number;
  filled: boolean;
  /** Base qty already merged into anchor TP from detected exchange fills at this step. */
  mergedFromFillsBase?: number;
};

export type ConsolidatedOrder = {
  price: number;
  baseQty: number;
  side: "BUY" | "SELL";
};

export type StrategyState = {
  symbol: string;
  gridSide: GridSide;
  anchorPrice: number;
  levelCount: number;
  /** % distance between ladder rungs (your “TP %” between levels). */
  stepPct: number;
  quotePerLevel: number;
  ladder: LadderLeg[];
  consolidated: ConsolidatedOrder | null;
  /** Sum of consolidated base qty that completed a full anchor cycle. */
  accumulatedBaseVolume: number;
  /** Sum of (anchor price × consolidated base) over completed cycles (quote notional). */
  accumulatedQuoteNotional: number;
  cycleCount: number;
};

export function dcaLimitSide(gridSide: GridSide): "BUY" | "SELL" {
  return gridSide === "SHORT" ? "BUY" : "SELL";
}

/** Limit at anchor that stacks size from each step fill. */
export function consolidatedLimitSide(gridSide: GridSide): "BUY" | "SELL" {
  return gridSide === "SHORT" ? "SELL" : "BUY";
}

/** After anchor TP fills, optional limit back at anchor (short: BUY; long: SELL). */
export function reentrySide(gridSide: GridSide): "BUY" | "SELL" {
  return gridSide === "SHORT" ? "BUY" : "SELL";
}

/** DCA legs always reduce an existing position on fill. */
export function dcaIsReduceOnly(_gridSide: GridSide): true {
  return true;
}

export function computeLadderPrices(
  anchor: number,
  gridSide: GridSide,
  levelCount: number,
  stepPct: number
): number[] {
  const mult = stepPct / 100;
  const prices: number[] = [];
  for (let i = 1; i <= levelCount; i += 1) {
    const delta = mult * i;
    if (gridSide === "SHORT") {
      prices.push(anchor * (1 - delta));
    } else {
      prices.push(anchor * (1 + delta));
    }
  }
  return prices;
}

export function buildInitialState(
  input: {
    symbol: string;
    gridSide: GridSide;
    anchorPrice: number;
    levelCount: number;
    stepPct: number;
    quotePerLevel: number;
  },
  opts?: { tickSize?: number }
): StrategyState {
  const ts = opts?.tickSize && opts.tickSize > 0 ? opts.tickSize : undefined;
  const anchor =
    ts !== undefined ? Number(roundToStep(input.anchorPrice, ts, "round")) : input.anchorPrice;
  const rawPrices = computeLadderPrices(anchor, input.gridSide, input.levelCount, input.stepPct);
  const prices =
    ts !== undefined
      ? rawPrices.map((p) => Number(roundToStep(p, ts, "round")))
      : rawPrices;
  const ladder: LadderLeg[] = prices.map((price, idx) => ({
    levelIndex: idx + 1,
    price,
    quoteNotional: input.quotePerLevel,
    baseQty: input.quotePerLevel / price,
    filled: false,
  }));
  return {
    symbol: input.symbol,
    gridSide: input.gridSide,
    anchorPrice: anchor,
    levelCount: input.levelCount,
    stepPct: input.stepPct,
    quotePerLevel: input.quotePerLevel,
    ladder,
    consolidated: null,
    accumulatedBaseVolume: 0,
    accumulatedQuoteNotional: 0,
    cycleCount: 0,
  };
}

/**
 * Mark a step as used (after you placed its paired TP on Binance or for manual tracking).
 */
export function applyDcaFill(state: StrategyState, levelIndex: number): StrategyState {
  const leg = state.ladder.find((l) => l.levelIndex === levelIndex);
  if (!leg || leg.filled) return state;

  const newLadder = state.ladder.map((l) =>
    l.levelIndex === levelIndex ? { ...l, filled: true, mergedFromFillsBase: l.baseQty } : l
  );

  return {
    ...state,
    ladder: newLadder,
    consolidated: null,
  };
}

/**
 * Reset the step table for a new wave (local). Pass optional closed base qty for stats.
 */
export function applyAnchorTpFill(
  state: StrategyState,
  closedBaseQty = 0,
  tickSize?: number
): StrategyState {
  const quote = closedBaseQty > 0 ? state.anchorPrice * closedBaseQty : 0;
  const next = buildInitialState(
    {
      symbol: state.symbol,
      gridSide: state.gridSide,
      anchorPrice: state.anchorPrice,
      levelCount: state.levelCount,
      stepPct: state.stepPct,
      quotePerLevel: state.quotePerLevel,
    },
    tickSize ? { tickSize } : undefined
  );
  return {
    ...next,
    accumulatedBaseVolume: state.accumulatedBaseVolume + closedBaseQty,
    accumulatedQuoteNotional: state.accumulatedQuoteNotional + quote,
    cycleCount: state.cycleCount + 1,
  };
}

export type FuturesUserTradeLite = {
  id: number;
  side: "BUY" | "SELL";
  price: string;
  qty: string;
};

/** Map a fill price to the closest step (prefer not Done, else same-price step for repeat fills). */
function findLadderLegForFillPrice(
  ladder: LadderLeg[],
  fillPrice: number,
  tickSize: number
): LadderLeg | null {
  const fp = Number(roundToStep(fillPrice, tickSize, "round"));
  let bestOpen: LadderLeg | null = null;
  let bestOpenDist = Infinity;
  let bestAny: LadderLeg | null = null;
  let bestAnyDist = Infinity;
  const tol = Math.max(tickSize * 6, fillPrice * 1e-7);
  for (const leg of ladder) {
    const lp = Number(roundToStep(leg.price, tickSize, "round"));
    const d = Math.abs(lp - fp);
    if (d > tol) continue;
    if (d < bestAnyDist) {
      bestAnyDist = d;
      bestAny = leg;
    }
    if (!leg.filled && d < bestOpenDist) {
      bestOpenDist = d;
      bestOpen = leg;
    }
  }
  return bestOpen ?? bestAny;
}

/**
 * If this trade is a step-side fill (short: BUY; long: SELL), update ladder tracking only.
 * Caller places a **separate** TP limit at the anchor for `trade.qty` (no merge on exchange).
 */
export function mergeExchangeFillIntoAnchorTp(
  state: StrategyState,
  trade: FuturesUserTradeLite,
  tickSize: number
): StrategyState | null {
  const qty = Number(trade.qty);
  const price = Number(trade.price);
  if (!(qty > 0) || !Number.isFinite(price)) return null;

  const expected = dcaLimitSide(state.gridSide);
  if (trade.side !== expected) return null;

  /** Re-entry / manual trades at the anchor must not attach to the nearest ladder rung by tick tolerance. */
  if (
    Number(roundToStep(price, tickSize, "round")) === anchorLimitPriceNum(state.anchorPrice, tickSize)
  ) {
    return null;
  }

  const leg = findLadderLegForFillPrice(state.ladder, price, tickSize);
  if (!leg) return null;

  /**
   * After **Place all orders** (or per-row **Place TP @ anchor**), the ladder row is marked `filled`
   * with `mergedFromFillsBase` ≈ planned size while the step limit can still execute later on Binance.
   * That execution must not schedule another TP — it would duplicate the anchor limit we already placed.
   */
  const plannedBase = leg.baseQty;
  const mergedBook = leg.mergedFromFillsBase ?? 0;
  if (leg.filled && mergedBook >= plannedBase * 0.94) {
    return null;
  }

  const prevMerged = leg.mergedFromFillsBase ?? 0;
  const nextMerged = prevMerged + qty;
  const markFilled = nextMerged >= leg.baseQty * 0.94;

  const newLadder = state.ladder.map((l) => {
    if (l.levelIndex !== leg.levelIndex) return l;
    return {
      ...l,
      mergedFromFillsBase: nextMerged,
      filled: markFilled || l.filled,
    };
  });

  return {
    ...state,
    ladder: newLadder,
    consolidated: null,
  };
}

/** True if this trade is a limit fill at the anchor on the TP side (short: SELL; long: BUY). */
export function isAnchorTpTrade(
  gridSide: GridSide,
  trade: FuturesUserTradeLite,
  anchorPrice: number,
  tickSize: number
): boolean {
  const tpSide = consolidatedLimitSide(gridSide);
  if (trade.side !== tpSide) return false;
  const ap = anchorLimitPriceNum(anchorPrice, tickSize);
  const tp = Number(roundToStep(Number(trade.price), tickSize, "round"));
  return ap === tp;
}

export type PlannedLimitOrder = {
  role: "dca" | "consolidated";
  levelIndex?: number;
  side: "BUY" | "SELL";
  price: number;
  baseQty: number;
  reduceOnly: boolean;
};

/**
 * Hypothetical ladder legs (for tests or external scripts). The UI does not post these to Binance.
 * `maxLevelIndex`: only include unfilled legs with levelIndex <= this (1 = nearest rung only).
 */
export function plannedDcaOrders(
  state: StrategyState,
  maxLevelIndex?: number
): PlannedLimitOrder[] {
  const out: PlannedLimitOrder[] = [];
  const dcaSide = dcaLimitSide(state.gridSide);
  for (const leg of state.ladder) {
    if (leg.filled) continue;
    if (maxLevelIndex !== undefined && leg.levelIndex > maxLevelIndex) continue;
    out.push({
      role: "dca",
      levelIndex: leg.levelIndex,
      side: dcaSide,
      price: leg.price,
      baseQty: leg.baseQty,
      reduceOnly: true,
    });
  }
  return out;
}

/** Full plan: hypothetical ladder legs + optional consolidated anchor (for tests / tooling). */
export function plannedLimitOrders(state: StrategyState): PlannedLimitOrder[] {
  const out = plannedDcaOrders(state);
  if (state.consolidated && state.consolidated.baseQty > 0) {
    out.push({
      role: "consolidated",
      side: state.consolidated.side,
      price: state.consolidated.price,
      baseQty: state.consolidated.baseQty,
      reduceOnly: false,
    });
  }
  return out;
}
