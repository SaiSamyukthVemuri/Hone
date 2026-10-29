// JURISDICTION-ONBOARDING. The pure decision behind "may this studio's
// payments be enabled, and if not, what must the owner fix?".
//
// Three facts are compared and none is ever derived from another:
//   * ENTERED  — the country and currency the owner explicitly confirmed
//                (public.studio_payment_jurisdictions, written only by the
//                0214 command). Never inferred from timezone, IP or locale.
//   * OBSERVED — the country Stripe reports for the connected account
//                (studio_payment_settings.stripe_account_country, written only
//                by record_stripe_account_jurisdiction).
//   * PRICES   — the currencies already stated by money rows or configured
//                prices, when any exist.
// An account's country alone does not decide the currency: the supported
// pairs are an explicit list, and the owner states both values.
//
// This module decides and explains. It writes nothing and enables nothing: the
// database guard on payment_charge_attempts stays the authority, and an
// activation switch stays a separate, default-off decision (G4).

import {
  accountCountryVerdict,
  parseJurisdiction,
  type PaymentCountry,
  type PaymentCurrency,
  type StudioPaymentJurisdiction,
} from "@/lib/billing/payment-jurisdiction";

/** Hone's supported combinations. The same two pairs 0214 admits. */
export const SUPPORTED_JURISDICTIONS: ReadonlyArray<StudioPaymentJurisdiction> = [
  { country: "CA", currency: "cad" },
  { country: "US", currency: "usd" },
];

export type ProposalVerdict =
  | { ok: true; jurisdiction: StudioPaymentJurisdiction }
  | { ok: false; reason: "missing_country" | "missing_currency" | "unsupported_combination" };

/**
 * Validate what the owner typed. Both values must be stated and the pair must
 * be one Hone supports. A country alone never selects a currency.
 */
export function validateProposal(input: { country?: unknown; currency?: unknown }): ProposalVerdict {
  if (input.country !== "CA" && input.country !== "US") {
    return { ok: false, reason: input.country == null || input.country === "" ? "missing_country" : "unsupported_combination" };
  }
  if (input.currency !== "cad" && input.currency !== "usd") {
    return { ok: false, reason: input.currency == null || input.currency === "" ? "missing_currency" : "unsupported_combination" };
  }
  const jurisdiction = parseJurisdiction({ payment_country: input.country, payment_currency: input.currency });
  return jurisdiction ? { ok: true, jurisdiction } : { ok: false, reason: "unsupported_combination" };
}

export type SetupState =
  | "needs_owner_confirmation"
  | "awaiting_stripe_account"
  | "awaiting_stripe_country"
  | "country_mismatch"
  | "country_conflict"
  | "price_currency_mismatch"
  | "ready";

export type SetupInput = {
  /** The stored, owner-confirmed row, as read. null: none exists. */
  entered: { payment_country?: unknown; payment_currency?: unknown } | null;
  /** Whether a connected account is bound to the studio in the current mode. */
  hasConnectedAccount: boolean;
  observedAccountCountry: string | null | undefined;
  conflictingAccountCountry: string | null | undefined;
  /** Currencies stated by existing money rows or configured prices. */
  statedCurrencies: ReadonlyArray<string | null | undefined>;
};

export type SetupVerdict = {
  state: SetupState;
  /** True only in "ready". Every other state keeps payment activation blocked. */
  paymentsMayBeEnabled: boolean;
  /** Owner-facing correction. No raw codes. */
  explanation: string;
};

const EXPLAIN: Record<Exclude<SetupState, "ready">, string> = {
  needs_owner_confirmation:
    "Confirm your business country and the currency you charge in. Hone does not guess these from your location or settings.",
  awaiting_stripe_account:
    "Connect your Stripe account. Your confirmed country is used to create it, and it cannot be changed afterwards.",
  awaiting_stripe_country:
    "Stripe has not yet reported your account's country. Refresh your Stripe status; this check cannot finish until it does.",
  country_mismatch:
    "Your Stripe account is registered in a different country than the one you confirmed. Contact Hone support to resolve it.",
  country_conflict:
    "Stripe has reported conflicting countries for your account. Contact Hone support to resolve it.",
  price_currency_mismatch:
    "Some of your prices or recorded payments are in a different currency than the one you confirmed. Contact Hone support to review it.",
};

const blocked = (state: Exclude<SetupState, "ready">): SetupVerdict =>
  ({ state, paymentsMayBeEnabled: false, explanation: EXPLAIN[state] });

/**
 * A new studio is "ready" only when the owner has confirmed a supported pair,
 * Stripe has reported the connected account's country, that country equals the
 * confirmed one, and no stated currency disagrees. The legacy allowance for a
 * never-observed Canadian account does NOT apply to a new setup: observation
 * is required.
 */
export function evaluateSetup(input: SetupInput): SetupVerdict {
  const entered = parseJurisdiction(input.entered);
  if (!entered) return blocked("needs_owner_confirmation");
  if (!input.hasConnectedAccount) return blocked("awaiting_stripe_account");

  const verdict = accountCountryVerdict(
    entered.country as PaymentCountry,
    input.observedAccountCountry,
    input.conflictingAccountCountry,
  );
  if (verdict === "conflict") return blocked("country_conflict");
  if (verdict === "mismatch") return blocked("country_mismatch");
  if (verdict !== "match") return blocked("awaiting_stripe_country");

  const disagreeing = input.statedCurrencies.some(
    (c) => c != null && (c as PaymentCurrency) !== entered.currency,
  );
  if (disagreeing) return blocked("price_currency_mismatch");

  // Say only what was compared: the country always, a currency only when a
  // stated price currency was actually checked against the confirmed one.
  const currencyCompared = input.statedCurrencies.some((c) => c != null);
  return {
    state: "ready",
    paymentsMayBeEnabled: true,
    explanation: currencyCompared
      ? "Your confirmed country matches your Stripe account, and your stated price currencies agree with your confirmed currency."
      : "Your confirmed country matches your Stripe account. Price currencies were not checked here.",
  };
}
