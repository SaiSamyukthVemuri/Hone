import { parseJurisdiction, type PaymentCountry } from "@/lib/billing/payment-jurisdiction";

// HON-90. WHICH STRIPE PLATFORM ACCOUNT A STUDIO'S MONEY GOES THROUGH.
//
// Hone has one platform account per payment country. A connected account lives under exactly one platform, so a studio's charges, refunds,
// account links and webhooks must all use THE PLATFORM THAT OWNS ITS CONNECTED ACCOUNT:
//
//   studio payment country | platform | secret key             | webhook secret             | publishable key
//   CA (cad)               | CA       | STRIPE_SECRET_KEY      | STRIPE_WEBHOOK_SECRET      | NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
//   US (usd)               | US       | STRIPE_SECRET_KEY_US   | STRIPE_WEBHOOK_SECRET_US   | NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY_US
//
// The CA row is the EXISTING production binding, unchanged: same variable names, so the Canadian studio's key, account and behaviour do
// not move. The US variables are new and are read here and in lib/stripe/server.ts only (pinned by tests/lib/stripe/platform-routing.test.ts).
//
// THE RULES, each one a refusal and never a fallback:
//   * The studio's country AND currency must be one of the two supported pairs (CA/cad, US/usd). Anything else is refused: a studio with no
//     verified pair has no platform. (This is the rule the charge path already applies: a missing or invalid jurisdiction row refuses.)
//   * CA is routed to the CA variables and nothing else; US is routed to the US variables and nothing else. A US route NEVER reads a CA
//     variable, and a CA route NEVER reads a US one.
//   * The US platform resolves only when its key is present, is a Stripe secret key, is not the SAME key as the CA one, and runs in the
//     SAME MODE as the deployment (the mode the CA key sets today). Production is live on the CA key, so a US sandbox key is REFUSED there
//     until the deployment's mode and the US key's mode agree: the US path stays dormant in production, and Willow is untouched.

export type StripePlatform = PaymentCountry;

export const PLATFORM_ENV = {
  CA: {
    secretKey: "STRIPE_SECRET_KEY",
    webhookSecret: "STRIPE_WEBHOOK_SECRET",
    publishableKey: "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
  },
  US: {
    secretKey: "STRIPE_SECRET_KEY_US",
    webhookSecret: "STRIPE_WEBHOOK_SECRET_US",
    publishableKey: "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY_US",
  },
} as const satisfies Record<StripePlatform, { secretKey: string; webhookSecret: string; publishableKey: string }>;

export type PlatformRefusal =
  | "jurisdiction_unverified" // country/currency is not one of the two supported pairs
  | "platform_not_configured" // the US key is absent
  | "invalid_key" // not an sk_test_ / sk_live_ key
  | "platform_keys_identical" // the US key equals the CA key: one account cannot serve both
  | "mode_mismatch"; // the US key's mode differs from the deployment's

export type PlatformRoute = { ok: true; platform: StripePlatform } | { ok: false; reason: PlatformRefusal };

type Env = Readonly<Record<string, string | undefined>>;

function modeOf(key: string): "test" | "live" | null {
  if (key.startsWith("sk_test_")) return "test";
  if (key.startsWith("sk_live_")) return "live";
  return null;
}

/** The deployment's mode is the CA key's today (see inferStripeLivemode): live only on an sk_live_ CA key. */
export function deploymentMode(env: Env): "test" | "live" {
  return (env[PLATFORM_ENV.CA.secretKey] ?? "").startsWith("sk_live_") ? "live" : "test";
}

/** The studio's stored pair to the platform that owns its money, or the reason it has none. */
export function routeStripePlatform(pair: { country: unknown; currency: unknown }, env: Env): PlatformRoute {
  const j = parseJurisdiction({ payment_country: pair.country, payment_currency: pair.currency });
  if (!j) return { ok: false, reason: "jurisdiction_unverified" };
  if (j.country === "CA") return { ok: true, platform: "CA" };

  const key = env[PLATFORM_ENV.US.secretKey];
  if (!key) return { ok: false, reason: "platform_not_configured" };
  const mode = modeOf(key);
  if (mode === null) return { ok: false, reason: "invalid_key" };
  const caKey = env[PLATFORM_ENV.CA.secretKey];
  if (caKey && caKey === key) return { ok: false, reason: "platform_keys_identical" };
  if (mode !== deploymentMode(env)) return { ok: false, reason: "mode_mismatch" };
  return { ok: true, platform: "US" };
}

/** The platform's secret key variable's value; only the platform's own variable is ever read. */
export function secretKeyFor(platform: StripePlatform, env: Env): string | undefined {
  return env[PLATFORM_ENV[platform].secretKey];
}
