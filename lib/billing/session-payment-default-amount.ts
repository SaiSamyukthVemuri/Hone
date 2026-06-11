// PR #200 (Chloe iPad retest): "The payment amount should auto load
// depending on what the service was. If they booked 60 mins it should
// load the price on my service menu."
//
// Pure resolver for the Session payment prepare form's DEFAULT amount.
// Display/default only: the practitioner can always edit the field
// before preparing, the prepare action still validates the submitted
// amount, and the charge executor still reads the amount from the
// prepared attempt row. No Stripe call, no gate, no executor change.
//
// Defaulting order (safest the data model supports today):
//   1. Client custom pricing (client_pricing) whose service_name
//      matches the booked service's name (trimmed, case-insensitive)
//      and whose effective_from is not in the future. Newest
//      effective_from wins. client_pricing has always matched by
//      service NAME, not id; this reuses that convention.
//   2. The booked service's menu price (services.price_cents). Each
//      service row is its own duration variant (e.g. a 60-minute
//      electrolysis service carries its own price), so no per-minute
//      math is ever invented here.
//   3. null: the form keeps its existing behavior (historical
//      session price suggestion, else blank manual entry).

export type SessionPaymentDefaultAmount = {
  amountCents: number;
  source: "custom_pricing" | "service_price";
  serviceName: string;
  // The appointment's booked duration, for the "60-minute" copy.
  durationMinutes: number | null;
  // notes from the matching client_pricing row (custom_pricing only).
  customPricingNote: string | null;
};

export type DefaultAmountServiceInput = {
  name: string;
  price_cents: number | null;
} | null;

export type DefaultAmountCustomPricingInput = {
  service_name: string;
  price_cents: number;
  notes: string | null;
  // YYYY-MM-DD
  effective_from: string;
};

export function resolveSessionPaymentDefault(input: {
  service: DefaultAmountServiceInput;
  appointmentDurationMinutes: number | null;
  customPricing: ReadonlyArray<DefaultAmountCustomPricingInput>;
  // Studio-local YYYY-MM-DD; future-dated custom pricing is ignored.
  today: string;
}): SessionPaymentDefaultAmount | null {
  const { service, appointmentDurationMinutes, customPricing, today } = input;
  if (!service) return null;

  const serviceKey = service.name.trim().toLowerCase();
  const matching = customPricing
    .filter(
      (row) =>
        row.service_name.trim().toLowerCase() === serviceKey &&
        row.effective_from <= today &&
        Number.isFinite(row.price_cents) &&
        row.price_cents > 0,
    )
    .sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1));

  if (matching.length > 0) {
    const row = matching[0];
    return {
      amountCents: row.price_cents,
      source: "custom_pricing",
      serviceName: service.name,
      durationMinutes: appointmentDurationMinutes,
      customPricingNote: row.notes?.trim() || null,
    };
  }

  if (service.price_cents != null && service.price_cents > 0) {
    return {
      amountCents: service.price_cents,
      source: "service_price",
      serviceName: service.name,
      durationMinutes: appointmentDurationMinutes,
      customPricingNote: null,
    };
  }

  return null;
}
