// DISPLAY ONLY. Which of a client's saved prices disagree with each other in a way that blocks fees and charges.
//
// This mirrors the tie rule in lib/billing/session-payment-amount.ts without changing it: for one service, among the rows
// already in effect (effective_from <= today), the newest effective date wins, and if two or more rows share that newest date
// with DIFFERENT prices the price is ambiguous and fees and payments for that service are refused until only one remains.
// SERVICE MATCH is by name, trimmed and case-insensitive, exactly like the resolver. A saved price of $0 counts as a price here, which
// is the rule #1483 introduces (an explicit $0 client price is a real price, so a $0 row and a positive row on the same date
// disagree). On production BEFORE #1483 the resolver ignores $0 rows, so a $0 + positive pair does not block there; this notice is
// meant to ship after #1483. Positive-price ties block under both rules.
// A same-date pair on an older date (superseded by a newer row) or on a future date does not block anything today and is not
// reported. Nothing here resolves a price, writes a row or logs a value; it returns service names and dates only.

export type ClientPricingConflictRow = {
  service_name: string;
  effective_from: string;
  price_cents: number;
};

export type ClientPricingConflict = { serviceName: string; effectiveFrom: string };

export function findBlockingPriceConflicts(
  rows: readonly ClientPricingConflictRow[],
  today: string,
): ClientPricingConflict[] {
  const byService = new Map<string, ClientPricingConflictRow[]>();
  for (const row of rows) {
    if (row.effective_from > today) continue;
    const key = row.service_name.trim().toLowerCase();
    const list = byService.get(key);
    if (list) list.push(row);
    else byService.set(key, [row]);
  }
  const out: ClientPricingConflict[] = [];
  for (const list of byService.values()) {
    const serviceName = list[0].service_name;
    let latest = list[0].effective_from;
    for (const r of list) if (r.effective_from > latest) latest = r.effective_from;
    const prices = new Set(list.filter((r) => r.effective_from === latest).map((r) => r.price_cents));
    if (prices.size > 1) out.push({ serviceName, effectiveFrom: latest });
  }
  return out.sort((a, b) => (a.serviceName < b.serviceName ? -1 : a.serviceName > b.serviceName ? 1 : 0));
}

export function priceConflictNotice(conflict: ClientPricingConflict): string {
  return `Two different prices are saved for ${conflict.serviceName} on ${conflict.effectiveFrom}. Until only one is left, fees and charges for this service are blocked. Delete the one you do not want with its ✕ button above, or delete both and add the right price again.`;
}
