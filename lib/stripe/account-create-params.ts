import type Stripe from "stripe";

// HON-90. The exact payload sent to stripe.accounts.create, per payment country.
//
// CA (Willow, production): the legacy `type: "express"` payload, BYTE-FOR-BYTE what account.ts sent before this file existed, pinned by
// tests/lib/stripe/account-create-params.test.ts. `type: "express"` implies (Stripe, Connect "migrate to controller properties"):
// Express Dashboard, fees.payer = application_express, losses.payments = application (the PLATFORM is liable for negative balances),
// requirement_collection = stripe.
//
// US (Option A, Accounts v2): see usAccountCreateParams below. The v1 `accounts.create` is refused for new Connect integrations on the US
// platform ("Stripe no longer recommends Accounts v1"), so the US path never uses this function.
export function connectedAccountCreateParams(country: "CA", studioId: string): Stripe.AccountCreateParams {
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

// US, "Option A" (decided for new US studios, verified against the US sandbox): POST /v2/core/accounts with
//   dashboard "full"            the studio signs in to its own Stripe Dashboard (no Hone-generated Express login link exists for it);
//   fees_collector "stripe"     Stripe collects its processing fees from the connected account (Hone takes no fee, as in Canada);
//   losses_collector "stripe"   Stripe, not Hone, carries negative-balance losses. (Express + Stripe losses is REFUSED by Stripe:
//                               account_controller_unsupported_configuration.)
// Stripe collects the requirements and Terms of Service acceptance in its hosted onboarding; Hone can never complete them for the studio.
// Charges are DIRECT charges on the connected account, so only the merchant card_payments capability is requested.
export type UsAccountCreateParams = {
  identity: { country: "us" };
  dashboard: "full";
  defaults: { currency: "usd"; responsibilities: { fees_collector: "stripe"; losses_collector: "stripe" } };
  configuration: { merchant: { capabilities: { card_payments: { requested: true } } } };
  metadata: { hone_studio_id: string };
};

export function usAccountCreateParams(studioId: string): UsAccountCreateParams {
  return {
    identity: { country: "us" },
    dashboard: "full",
    defaults: { currency: "usd", responsibilities: { fees_collector: "stripe", losses_collector: "stripe" } },
    configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
    metadata: { hone_studio_id: studioId },
  };
}
