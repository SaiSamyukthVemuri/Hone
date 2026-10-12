// PAY-CCY-02 (#824). A studio's PAYMENT COUNTRY and its CHARGE CURRENCY.
//
// Two facts, kept apart on purpose. The country is where the studio's business
// is, and so where its Stripe connected account must be. The currency is what
// its charges are denominated in. Today the only allowed pairs are CA/cad and
// US/usd (public.studio_payment_jurisdictions, migration 0214), but nothing in
// this module derives one from the other: an account is checked against the
// studio's COUNTRY, and a charge is prepared in the studio's CURRENCY. An
// account's own default currency is never used to decide what to charge.
//
// Pure and framework-free; the server read lives in
// payment-jurisdiction-server.ts.

export type PaymentCountry = "CA" | "US";
export type PaymentCurrency = "cad" | "usd";

export type StudioPaymentJurisdiction = {
  country: PaymentCountry;
  currency: PaymentCurrency;
};

/** Parse a stored row. Anything outside the two allowed pairs is refused. */
export function parseJurisdiction(row: {
  payment_country?: unknown;
  payment_currency?: unknown;
} | null | undefined): StudioPaymentJurisdiction | null {
  if (!row) return null;
  const { payment_country: country, payment_currency: currency } = row;
  if (country === "CA" && currency === "cad") return { country, currency };
  if (country === "US" && currency === "usd") return { country, currency };
  return null;
}

/** "CAD" / "USD": how money is labelled to people. */
export function currencyLabel(currency: PaymentCurrency): "CAD" | "USD" {
  return currency === "usd" ? "USD" : "CAD";
}

export type AccountCountryVerdict =
  // Stripe reported the account's country and it is the studio's.
  | "match"
  // Stripe reported a different country. Fails closed everywhere.
  | "mismatch"
  // Never observed, on a Canadian studio: every account created before #824
  // was created in CA, so this is the legacy case and stays chargeable.
  | "unobserved_legacy_ca"
  // Never observed, on a non-Canadian studio: refused until observed.
  | "unobserved_refused";

/**
 * Compare the account's OBSERVED country (studio_payment_settings.
 * stripe_account_country) with the studio's payment country. Mirrors the
 * database guard on payment_charge_attempts, which is the authority; this
 * exists so the application can refuse with a useful message first.
 */
export function accountCountryVerdict(
  studioCountry: PaymentCountry,
  observedAccountCountry: string | null | undefined,
): AccountCountryVerdict {
  if (observedAccountCountry == null || observedAccountCountry === "") {
    return studioCountry === "CA" ? "unobserved_legacy_ca" : "unobserved_refused";
  }
  return observedAccountCountry === studioCountry ? "match" : "mismatch";
}

export function accountCountryChargeable(verdict: AccountCountryVerdict): boolean {
  return verdict === "match" || verdict === "unobserved_legacy_ca";
}

/** Practitioner-facing refusal for a non-chargeable verdict. No raw codes. */
export function accountCountryBlockingReason(
  verdict: AccountCountryVerdict,
): string | null {
  switch (verdict) {
    case "mismatch":
      return "The studio's Stripe account is registered in a different country than the studio's payment settings. No charge can be prepared until Hone support resolves it.";
    case "unobserved_refused":
      return "Hone has not yet confirmed the country of the studio's Stripe account. Refresh the Stripe status in Settings, then try again.";
    default:
      return null;
  }
}

export const JURISDICTION_UNVERIFIED_REASON =
  "The studio's payment country and currency could not be verified. Refresh and try again.";
