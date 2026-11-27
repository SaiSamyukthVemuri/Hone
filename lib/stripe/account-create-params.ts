import type Stripe from "stripe";
import type { PaymentCountry } from "@/lib/billing/payment-jurisdiction";

// HON-90. The exact payload sent to stripe.accounts.create, per payment country.
//
// CA (Willow, production): the legacy `type: "express"` payload, BYTE-FOR-BYTE what account.ts sent before this file existed, pinned by
// tests/lib/stripe/account-create-params.test.ts. `type: "express"` implies (Stripe, Connect "migrate to controller properties"):
// Express Dashboard, fees.payer = application_express, losses.payments = application (the PLATFORM is liable for negative balances),
// requirement_collection = stripe.
//
// US: today the same payload. Its controller configuration (Stripe-managed losses) is decided and verified against the US sandbox
// before it replaces this; the CA branch above never changes with it.
export function connectedAccountCreateParams(country: PaymentCountry, studioId: string): Stripe.AccountCreateParams {
  if (country === "CA") {
    return {
      type: "express",
      country,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      metadata: {
        hone_studio_id: studioId,
      },
    };
  }
  return {
    type: "express",
    country,
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
    metadata: {
      hone_studio_id: studioId,
    },
  };
}
