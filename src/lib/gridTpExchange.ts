import { cancelOrderById, getOpenOrders, newOrder } from "./binanceFutures";
import { roundToStep, type LotPriceFilter } from "./symbolFilters";
import type { GridSide, PlannedLimitOrder } from "./strategyEngine";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Cancel open LIMIT orders at this price (rounded to tick) and optional side. */
export async function cancelOpenLimitsAtPrice(
  apiKey: string,
  apiSecret: string,
  symbol: string,
  targetPrice: number,
  tickSize: number,
  side?: "BUY" | "SELL"
): Promise<number> {
  const orders = await getOpenOrders(apiKey, apiSecret, symbol);
  const want = roundToStep(targetPrice, tickSize, "round");
  let n = 0;
  for (const o of orders) {
    if (o.type !== "LIMIT") continue;
    if (side && o.side !== side) continue;
    const p = roundToStep(Number(o.price), tickSize, "round");
    if (p !== want) continue;
    await cancelOrderById(apiKey, apiSecret, symbol, o.orderId);
    n += 1;
    await sleep(100);
  }
  return n;
}

export async function placeSingleLimit(
  apiKey: string,
  apiSecret: string,
  symbol: string,
  hedgeMode: boolean,
  gridSide: GridSide,
  plan: PlannedLimitOrder,
  filters: LotPriceFilter
): Promise<unknown> {
  const qty = roundToStep(plan.baseQty, filters.stepSize, "floor");
  const price = roundToStep(plan.price, filters.tickSize, "round");
  if (Number(qty) <= 0) throw new Error("Quantity rounds to zero");
  return newOrder({
    apiKey,
    apiSecret,
    symbol,
    side: plan.side,
    type: "LIMIT",
    quantity: qty,
    price,
    timeInForce: "GTC",
    positionSide: hedgeMode ? gridSide : undefined,
    reduceOnly: plan.reduceOnly,
  });
}

/** Place many step-side limits (short: buys; long: sells). Does not touch anchor TP orders. */
export async function placeDcaStepLimits(
  apiKey: string,
  apiSecret: string,
  symbol: string,
  hedgeMode: boolean,
  gridSide: GridSide,
  plans: PlannedLimitOrder[],
  filters: LotPriceFilter
): Promise<{ placed: number; orderIds: number[] }> {
  let placed = 0;
  const orderIds: number[] = [];
  for (const p of plans) {
    if (p.role !== "dca") continue;
    const res = await placeSingleLimit(apiKey, apiSecret, symbol, hedgeMode, gridSide, p, filters);
    if (
      res &&
      typeof res === "object" &&
      "orderId" in res &&
      Number.isFinite(Number((res as { orderId?: unknown }).orderId))
    ) {
      orderIds.push(Number((res as { orderId?: unknown }).orderId));
    }
    placed += 1;
    await sleep(120);
  }
  return { placed, orderIds };
}
