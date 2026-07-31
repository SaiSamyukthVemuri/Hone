// THE pricing authority for a session payment.
//
// F-PAY-001. The browser used to decide `payment_charge_attempts.amount_cents`:
// the prepare action read `amount_dollars` off the form and inserted it. The
// page computed a correct suggestion, the practitioner could edit the field,
// and whatever came back was stored. A tampered request preparing $1.00 against
// a $145.00 service was accepted and became a real chargeable row — the
// executor then faithfully charged the tampered amount, because by then the
// unsafe decision had already been made.
//
// This module makes the amount a SERVER decision derived from trusted current
// records. It is PURE: no I/O, no clock, no mutation. The studio-local date is
// injected so "is this custom price effective yet" is deterministic and
// testable, and so a server render and a later prepare cannot disagree by
// milliseconds.
//
// PRECEDENCE (and nothing else is ever consulted):
//   1. A current client-specific price for the booked service.
//   2. Otherwise the booked service's current menu price.
//   3. Otherwise preparation is BLOCKED. There is no fallback to
//      sessions.price_paid_cents, to a prior attempt, or to anything the
//      browser sent — a guess is not an authority.
//
// Each service row is already its own duration variant, so no per-minute
// arithmetic is invented here. `durationMinutes` is descriptive metadata for
// the practitioner-facing copy only.

export type SessionPaymentAmountSource = "custom_pricing" | "service_price";

export type ResolvedSessionPaymentAmount = {
  kind: "resolved";
  amountCents: number;
  source: SessionPaymentAmountSource;
  serviceName: string;
  // Descriptive only — never an input to the arithmetic.
  durationMinutes: number | null;
  // Note from the matching client_pricing row (custom_pricing only).
  customPricingNote: string | null;
};

// Every way pricing can fail to produce ONE trustworthy number. Each is a
// distinct practitioner-facing explanation, never a silent null.
export type UnresolvedSessionPaymentAmount =
  // The appointment has no booked service, so there is nothing to price.
  | { kind: "missing_service" }
  // A service is booked but neither a custom price nor a menu price exists.
  | { kind: "missing_price"; serviceName: string }
  // Two or more equally-current custom rows disagree about the price. There is
  // no uniqueness constraint on client_pricing (traced: only a PK on id), so
  // this is genuinely reachable, and picking one would mean charging a client
  // an amount decided by database row order.
  | { kind: "ambiguous_custom_pricing"; serviceName: string; candidateCents: number[] };

export type SessionPaymentAmountResult =
  | ResolvedSessionPaymentAmount
  | UnresolvedSessionPaymentAmount;

export type AuthoritativeServiceInput = {
  name: string;
  price_cents: number | null;
} | null;

export type AuthoritativeCustomPricingInput = {
  service_name: string;
  price_cents: number;
  notes: string | null;
  // YYYY-MM-DD
  effective_from: string;
};

export function resolveAuthoritativeSessionPaymentAmount(input: {
  service: AuthoritativeServiceInput;
  appointmentDurationMinutes: number | null;
  customPricing: ReadonlyArray<AuthoritativeCustomPricingInput>;
  // Studio-local YYYY-MM-DD. Injected: this module never reads a clock.
  today: string;
}): SessionPaymentAmountResult {
  const { service, appointmentDurationMinutes, customPricing, today } = input;
  if (!service) return { kind: "missing_service" };

  const serviceName = service.name;
  // client_pricing has always matched by service NAME, not id. Preserved
  // deliberately: changing the linkage is a separate, migration-shaped decision.
  const serviceKey = serviceName.trim().toLowerCase();

  // Current, positively-priced custom rows for THIS service.
  //
  // A zero or negative custom price is not treated as "charge nothing" — the
  // model has always read it as "no custom price recorded", and silently
  // charging $0 because of a bad row would be worse than falling through to the
  // menu price. (The DB CHECK already forbids negatives; this is belt and
  // braces for a hand-built row.)
  const current = customPricing.filter(
    (row) =>
      row.service_name.trim().toLowerCase() === serviceKey &&
      row.effective_from <= today &&
      Number.isFinite(row.price_cents) &&
      row.price_cents > 0,
  );

  if (current.length > 0) {
    // Newest effective_from wins. Compared as strings, which is safe for the
    // fixed-width YYYY-MM-DD format this column uses.
    let latest = current[0].effective_from;
    for (const row of current) {
      if (row.effective_from > latest) latest = row.effective_from;
    }
    const tied = current.filter((row) => row.effective_from === latest);
    const distinct = Array.from(new Set(tied.map((r) => r.price_cents)));

    if (distinct.length > 1) {
      // Equally current, disagreeing prices. Fail closed: any pick here would
      // be decided by row order, not by anything the studio actually recorded.
      // Sorted so the reported candidates are stable for display and tests.
      return {
        kind: "ambiguous_custom_pricing",
        serviceName,
        candidateCents: [...distinct].sort((a, b) => a - b),
      };
    }

    // Equally current rows that AGREE on the price are safe and deterministic:
    // every candidate yields the same number, so no row-order dependence
    // exists. The note is taken from the first such row.
    const row = tied[0];
    return {
      kind: "resolved",
      amountCents: row.price_cents,
      source: "custom_pricing",
      serviceName,
      durationMinutes: appointmentDurationMinutes,
      customPricingNote: row.notes?.trim() || null,
    };
  }

  if (service.price_cents != null && service.price_cents > 0) {
    return {
      kind: "resolved",
      amountCents: service.price_cents,
      source: "service_price",
      serviceName,
      durationMinutes: appointmentDurationMinutes,
      customPricingNote: null,
    };
  }

  return { kind: "missing_price", serviceName };
}

// Practitioner-facing explanation for a blocked price. Kept beside the states
// so copy and branch cannot drift.
export function unresolvedAmountMessage(
  result: UnresolvedSessionPaymentAmount,
): string {
  switch (result.kind) {
    case "missing_service":
      return "This appointment has no booked service, so there is no price to charge. Add the service to the appointment first.";
    case "missing_price":
      return `No price is configured for ${result.serviceName}. Set its price in your service menu, or add a client-specific price, before preparing payment.`;
    case "ambiguous_custom_pricing":
      return `${result.serviceName} has more than one current client-specific price for this client. Review this client's pricing so there is a single current price before preparing payment.`;
  }
}
