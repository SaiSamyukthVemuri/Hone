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

/** "Canadian dollars" / "US dollars": how a screen reader names the money. */
export function currencyName(
  currency: PaymentCurrency,
): "Canadian dollars" | "US dollars" {
  return currency === "usd" ? "US dollars" : "Canadian dollars";
}

/** "Canada" / "United States": the studio's payment country, for people. */
export function countryName(country: PaymentCountry): "Canada" | "United States" {
  return country === "US" ? "United States" : "Canada";
}

export type AccountCountryVerdict =
  // Stripe reported the account's country and it is the studio's.
  | "match"
  // Stripe reported a different country. Fails closed everywhere.
  | "mismatch"
  // Stripe reported the account in two different countries (0214 persists
  // the later one as stripe_account_country_conflict). Neither report is
  // trusted, whichever matches the studio. Fails closed everywhere.
  | "conflict"
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
  conflictingAccountCountry: string | null | undefined,
): AccountCountryVerdict {
  if (conflictingAccountCountry != null && conflictingAccountCountry !== "") {
    return "conflict";
  }
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
    case "conflict":
      return "Stripe has reported conflicting countries for the studio's Stripe account. No charge can be prepared until Hone support resolves it.";
    case "unobserved_refused":
      return "Hone has not yet confirmed the country of the studio's Stripe account. Refresh the Stripe status in Settings, then try again.";
    default:
      return null;
  }
}

/**
 * PAY-CCY-04. The owner-facing summary of where the studio takes payments.
 * Pure: the page passes in what it read, this decides what to say. The tone
 * is "ok" only when charging is actually possible from the country's side.
 */
export type PaymentCountrySummary = {
  tone: "ok" | "attention" | "blocked" | "unknown";
  heading: string;
  detail: string;
};

export function describePaymentCountry(input: {
  jurisdiction: StudioPaymentJurisdiction | null;
  account:
    | { kind: "none" }
    | { kind: "bound"; observedCountry: string | null }
    | { kind: "unknown" };
}): PaymentCountrySummary {
  const { jurisdiction, account } = input;
  if (!jurisdiction) {
    return {
      tone: "unknown",
      heading: "Payment country could not be verified",
      detail: "Hone could not read this studio's payment country and currency. No charge can be prepared until it can. Refresh the page; if this persists, contact Hone support.",
    };
  }
  const where = countryName(jurisdiction.country);
  const heading = `${where} · charges in ${currencyLabel(jurisdiction.currency)}`;
  if (account.kind === "unknown") {
    return {
      tone: "unknown",
      heading,
      detail: "Hone could not check the country of this studio's Stripe account. Refresh the page.",
    };
  }
  if (account.kind === "none") {
    return {
      tone: "ok",
      heading,
      detail: `When you connect Stripe, the account will be created in ${where}. Contact Hone support before connecting if this is not your business's country.`,
    };
  }
  const verdict = accountCountryVerdict(jurisdiction.country, account.observedCountry);
  switch (verdict) {
    case "match":
      return {
        tone: "ok",
        heading,
        detail: `Your Stripe account is registered in ${where}.`,
      };
    case "unobserved_legacy_ca":
      return {
        tone: "attention",
        heading,
        detail: "Stripe has not yet confirmed your account's country to Hone. Refresh status from Stripe to confirm it.",
      };
    case "unobserved_refused":
      return {
        tone: "blocked",
        heading,
        detail: `Stripe has not yet confirmed that your account is registered in ${where}. Charges are paused until it does. Refresh status from Stripe.`,
      };
    case "mismatch": {
      const reported =
        account.observedCountry === "CA" || account.observedCountry === "US"
          ? countryName(account.observedCountry)
          : (account.observedCountry ?? "another country");
      return {
        tone: "blocked",
        heading,
        detail: `Your Stripe account is registered in ${reported}, not ${where}. Onboarding and charges are blocked. Contact Hone support; the account will not be replaced automatically.`,
      };
    }
  }
}

export const JURISDICTION_UNVERIFIED_REASON =
  "The studio's payment country and currency could not be verified. Refresh and try again.";
