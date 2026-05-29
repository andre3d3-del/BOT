const DEFAULT_PROXY_BASE = "/api/binance";

function baseUrl(): string {
  const b = import.meta.env.VITE_BINANCE_PROXY_BASE as string | undefined;
  return (b && b.length > 0 ? b : DEFAULT_PROXY_BASE).replace(/\/$/, "");
}

/** Binance USD-M: 1–36 chars, ^[\.A-Z\:/a-z0-9_-]{1,36}$ — unique per order avoids edge-case dedupe. */
function futuresClientOrderId(): string {
  const id = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  return id.replace(/[^A-Za-z0-9._:\/-]/g, "").slice(0, 36) || `b${Date.now()}`;
}

async function signedFetch(
  method: "GET" | "POST" | "DELETE",
  path: string,
  apiKey: string,
  apiSecret: string,
  params: Record<string, string | number | boolean | undefined> = {}
): Promise<unknown> {
  const url = `${baseUrl()}/signed`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      method,
      path,
      apiKey,
      apiSecret,
      params,
    }),
  });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* keep text */
  }
  if (!res.ok) {
    const msg =
      typeof data === "object" && data !== null && "msg" in data
        ? String((data as { msg: unknown }).msg)
        : text || res.statusText;
    throw new Error(msg);
  }
  return data;
}

export type AccountBalance = { asset: string; balance: string; availableBalance: string };

export async function futuresAccount(
  apiKey: string,
  apiSecret: string
): Promise<{ assets?: AccountBalance[] }> {
  return signedFetch("GET", "/fapi/v2/account", apiKey, apiSecret) as Promise<{
    assets?: AccountBalance[];
  }>;
}

export type ExchangeSymbol = {
  symbol: string;
  status: string;
  quoteAsset: string;
  contractType?: string;
};

export async function exchangeInfo(): Promise<{ symbols: ExchangeSymbol[] }> {
  const url = `${baseUrl()}/public?path=${encodeURIComponent("/fapi/v1/exchangeInfo")}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ symbols: ExchangeSymbol[] }>;
}

/** USD-M mark price (public). */
export async function fetchMarkPrice(symbol: string): Promise<string> {
  const url = `${baseUrl()}/public?path=${encodeURIComponent("/fapi/v1/premiumIndex")}&symbol=${encodeURIComponent(symbol)}`;
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(text || res.statusText);
  const j = JSON.parse(text) as { markPrice?: string };
  if (!j.markPrice) throw new Error("No mark price");
  return j.markPrice;
}

export async function newOrder(params: {
  apiKey: string;
  apiSecret: string;
  symbol: string;
  side: "BUY" | "SELL";
  positionSide?: "LONG" | "SHORT" | "BOTH";
  type: "LIMIT" | "MARKET";
  timeInForce?: "GTC" | "IOC" | "FOK";
  quantity?: string;
  price?: string;
  reduceOnly?: boolean | string;
  /** Omit to auto-generate a unique id so each submission is a distinct order. */
  newClientOrderId?: string;
}): Promise<unknown> {
  const {
    apiKey,
    apiSecret,
    symbol,
    side,
    positionSide,
    type,
    timeInForce = "GTC",
    quantity,
    price,
    reduceOnly,
    newClientOrderId,
  } = params;
  const normalizedReduceOnly =
    reduceOnly === true || reduceOnly === "true" || reduceOnly === "TRUE";
  const canSendReduceOnly = positionSide === undefined || positionSide === "BOTH";
  const oid =
    newClientOrderId && newClientOrderId.length > 0
      ? newClientOrderId.slice(0, 36)
      : futuresClientOrderId();
  return signedFetch("POST", "/fapi/v1/order", apiKey, apiSecret, {
    symbol,
    side,
    positionSide,
    type,
    timeInForce: type === "LIMIT" ? timeInForce : undefined,
    quantity,
    price,
    newClientOrderId: oid,
    // Binance rejects `reduceOnly` in many cases (especially Hedge Mode LONG/SHORT).
    // Only send when explicitly true and position side is one-way/BOTH.
    reduceOnly: normalizedReduceOnly && canSendReduceOnly ? "true" : undefined,
  });
}

export async function cancelAllOpenOrders(
  apiKey: string,
  apiSecret: string,
  symbol: string
): Promise<unknown> {
  return signedFetch("DELETE", "/fapi/v1/allOpenOrders", apiKey, apiSecret, { symbol });
}

export type FuturesPosition = {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  unRealizedProfit: string;
  positionSide: "BOTH" | "LONG" | "SHORT";
};

export async function fetchPositions(
  apiKey: string,
  apiSecret: string,
  symbol: string
): Promise<FuturesPosition[]> {
  const data = (await signedFetch("GET", "/fapi/v2/positionRisk", apiKey, apiSecret, {
    symbol,
  })) as FuturesPosition[];
  return Array.isArray(data)
    ? data.filter((p) => Math.abs(Number(p.positionAmt)) > 0)
    : [];
}

export async function closePositionAtMarket(
  apiKey: string,
  apiSecret: string,
  symbol: string,
  positionAmt: string,
  positionSide: "BOTH" | "LONG" | "SHORT"
): Promise<unknown> {
  const amt = Number(positionAmt);
  if (amt === 0) return null;
  // Positive amt = LONG (close with SELL), negative amt = SHORT (close with BUY).
  const side = amt > 0 ? "SELL" : "BUY";
  const quantity = String(Math.abs(amt));
  const isHedge = positionSide === "LONG" || positionSide === "SHORT";
  return signedFetch("POST", "/fapi/v1/order", apiKey, apiSecret, {
    symbol,
    side,
    type: "MARKET",
    quantity,
    positionSide: isHedge ? positionSide : undefined,
    reduceOnly: isHedge ? undefined : "true",
  });
}

export type FuturesOpenOrder = {
  orderId: number;
  symbol: string;
  price: string;
  origQty: string;
  executedQty: string;
  side: "BUY" | "SELL";
  type: string;
  status: string;
};

export type FuturesOrder = {
  orderId: number;
  symbol: string;
  status: string;
  side: "BUY" | "SELL";
  price: string;
  origQty: string;
  executedQty: string;
  type: string;
  timeInForce: string;
};

export async function getOpenOrders(
  apiKey: string,
  apiSecret: string,
  symbol: string
): Promise<FuturesOpenOrder[]> {
  const data = (await signedFetch("GET", "/fapi/v1/openOrders", apiKey, apiSecret, {
    symbol,
  })) as FuturesOpenOrder[];
  return Array.isArray(data) ? data : [];
}

export async function getOrder(
  apiKey: string,
  apiSecret: string,
  symbol: string,
  orderId: number
): Promise<FuturesOrder> {
  return (await signedFetch("GET", "/fapi/v1/order", apiKey, apiSecret, {
    symbol,
    orderId,
  })) as FuturesOrder;
}

export async function cancelOrderById(
  apiKey: string,
  apiSecret: string,
  symbol: string,
  orderId: number
): Promise<unknown> {
  return signedFetch("DELETE", "/fapi/v1/order", apiKey, apiSecret, { symbol, orderId });
}

/** USD-M futures account trade (fill). */
export type FuturesUserTrade = {
  id: number;
  orderId: number;
  symbol: string;
  side: "BUY" | "SELL";
  price: string;
  qty: string;
  quoteQty?: string;
  time?: number;
};

export async function fetchUserTrades(
  apiKey: string,
  apiSecret: string,
  symbol: string,
  opts?: { fromId?: number; limit?: number }
): Promise<FuturesUserTrade[]> {
  const params: Record<string, string | number> = { symbol };
  if (opts?.fromId !== undefined) params.fromId = opts.fromId;
  if (opts?.limit !== undefined) params.limit = opts.limit;
  const data = (await signedFetch("GET", "/fapi/v1/userTrades", apiKey, apiSecret, params)) as
    | FuturesUserTrade[]
    | unknown;
  return Array.isArray(data) ? data : [];
}

export function filterUsdMarginSymbols(symbols: ExchangeSymbol[]): string[] {
  return symbols
    .filter(
      (s) =>
        s.status === "TRADING" &&
        (s.quoteAsset === "USDT" || s.quoteAsset === "USDC") &&
        (s.contractType === "PERPETUAL" || s.contractType === undefined)
    )
    .map((s) => s.symbol)
    .sort();
}

export async function startBackendCycleWorker(params: {
  sessionId?: string;
  apiKey: string;
  apiSecret: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  anchorPrice: string;
  stepSize: string;
  tickSize: string;
  entryOrderId: number;
  rows: Array<{ price: string; percent: number }>;
  positionSide?: "LONG" | "SHORT" | "BOTH";
  /** When restarting after a proxy crash, pass all previously-known order IDs so the
   *  backend can skip bootstrap (avoids placing duplicate TP orders). */
  existingOrderIds?: number[];
}): Promise<{ ok: boolean; sessionId: string }> {
  const url = `${baseUrl()}/cycle/start`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* keep text */
  }
  if (!res.ok) {
    const msg =
      typeof data === "object" && data !== null && "error" in data
        ? String((data as { error: unknown }).error)
        : text || res.statusText;
    throw new Error(msg);
  }
  return data as { ok: boolean; sessionId: string };
}

export async function stopBackendCycleWorker(
  sessionId: string,
  opts?: {
    cancelOrders?: boolean;
    apiKey?: string;
    apiSecret?: string;
    symbol?: string;
    knownOrderIds?: number[];
  }
): Promise<{ ok: boolean; stopped: boolean; cancelRequested?: number; cancelDone?: number }> {
  const url = `${baseUrl()}/cycle/stop`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId,
      cancelOrders: opts?.cancelOrders === true,
      apiKey: opts?.apiKey,
      apiSecret: opts?.apiSecret,
      symbol: opts?.symbol,
      knownOrderIds: opts?.knownOrderIds || [],
    }),
  });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* keep text */
  }
  if (!res.ok) {
    const msg =
      typeof data === "object" && data !== null && "error" in data
        ? String((data as { error: unknown }).error)
        : text || res.statusText;
    throw new Error(msg);
  }
  return data as { ok: boolean; stopped: boolean; cancelRequested?: number; cancelDone?: number };
}

export async function getBackendCycleStatus(sessionId: string): Promise<{
  ok: boolean;
  sessionId: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  trackedEntryCount: number;
  trackedCycleCount: number;
  knownOrderIds: number[];
  lastTradeId: number;
  streamConnected?: boolean;
  streamError?: string | null;
  lastError: string | null;
  placementGaps: number;
  cycleGaps: number;
}> {
  const url = `${baseUrl()}/cycle/status?sessionId=${encodeURIComponent(sessionId)}`;
  const res = await fetch(url);
  const text = await res.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* keep text */
  }
  if (!res.ok) {
    const msg =
      typeof data === "object" && data !== null && "error" in data
        ? String((data as { error: unknown }).error)
        : text || res.statusText;
    throw new Error(msg);
  }
  return data as {
    ok: boolean;
    sessionId: string;
    symbol: string;
    direction: "LONG" | "SHORT";
    trackedEntryCount: number;
    trackedCycleCount: number;
    knownOrderIds: number[];
    lastTradeId: number;
    streamConnected?: boolean;
    streamError?: string | null;
    lastError: string | null;
    placementGaps: number;
    cycleGaps: number;
  };
}
