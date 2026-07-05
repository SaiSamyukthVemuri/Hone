// Server-only Stripe client + key-mode enforcement.
//
// Mode rule: Stripe LIVE mode requires an explicit opt-in
// (`STRIPE_ALLOW_LIVE_MODE === "true"`) alongside the sk_live_ key.
// Production has been flipped live via the supervised operator process
// (docs/16 §17.15); environments without the opt-in stay test-mode.
//
// Key acceptance matrix:
//
//   VERCEL_ENV         | key prefix | STRIPE_ALLOW_LIVE_MODE | accepted
//   -----------------  | --------   | --------------------- | --------
//   production         | sk_test_   | (any)                 |  yes
//   production         | sk_live_   | "true"                |  yes
//   production         | sk_live_   | (anything else)       |  NO
//   preview/development| sk_test_   | (any)                 |  yes
//   preview/development| sk_live_   | (any)                 |  NO  (Preview/Dev cannot use live)
//   (no vercel env)    | sk_test_   | (any)                 |  yes
//   (no vercel env)    | sk_live_   | "true"                |  yes  (e.g. live-staging server)
//   (no vercel env)    | sk_live_   | (anything else)       |  NO
//
// Other rules:
//   * STRIPE_SECRET_KEY is read at first use and never logged.
//   * Pinned API version `2026-04-22.dahlia`. Bumping it later must
//     be a deliberate code change.
//   * Client-side Stripe.js is used only in the card-on-file portal flow
//     (PortalPaymentMethodForm confirmSetup, PR #135), which loads its own
//     publishable key via lib/stripe/publishable-key.ts. This server module
//     never needs the publishable key; it uses the secret key only.

import Stripe from "stripe";
import { getRequiredAppOrigin } from "@/lib/app-origin";

const STRIPE_API_VERSION = "2026-04-22.dahlia" as const;

let cached: Stripe | null = null;

/**
 * Throw if the supplied STRIPE_SECRET_KEY is not allowed in the
 * current environment. Centralized so a future change cannot bypass
 * the live-mode gate by reaching directly into `new Stripe(...)`.
 *
 * @internal Exported for unit-test usage only.
 */
export function assertStripeKeyAllowed(raw: string): void {
  const isTestKey = raw.startsWith("sk_test_");
  const isLiveKey = raw.startsWith("sk_live_");

  if (!isTestKey && !isLiveKey) {
    throw new Error("Invalid Stripe secret key format.");
  }

  if (isLiveKey && process.env.STRIPE_ALLOW_LIVE_MODE !== "true") {
    throw new Error(
      "Stripe live mode is disabled for Phase 1. " +
        "Set STRIPE_ALLOW_LIVE_MODE=true behind a separate review before using sk_live_.",
    );
  }

  const vercelEnv = process.env.VERCEL_ENV;
  if ((vercelEnv === "preview" || vercelEnv === "development") && !isTestKey) {
    throw new Error(
      `Stripe ${vercelEnv} deployments must use sk_test_. ` +
        "Live keys are not permitted outside Production.",
    );
  }
}

function readSecretOrThrow(): string {
  const raw = process.env.STRIPE_SECRET_KEY;
  if (!raw || raw.length === 0) {
    throw new Error(
      "STRIPE_SECRET_KEY is not set. Required for Stripe Phase 1 onboarding.",
    );
  }
  assertStripeKeyAllowed(raw);
  return raw;
}

/**
 * Returns a singleton Stripe client. Server-only.
 *
 * Pinned to API version 2026-04-22.dahlia. To upgrade, change the
 * literal above AND verify the new version's webhook + accountLinks
 * + accounts.retrieve responses still match this codebase's
 * expectations. Do not bump silently.
 */
export function getStripe(): Stripe {
  if (cached) return cached;
  const secret = readSecretOrThrow();
  // appInfo.url is informational (sent in User-Agent). We never want
  // to silently send "https://hone.care" from a Preview/Dev/misconfigured
  // production deployment — that would mis-attribute the origin in
  // Stripe's logs. We therefore call getAppOrigin() and OMIT
  // appInfo.url if it cannot be resolved without falling back.
  let appOrigin: string | undefined;
  try {
    appOrigin = getRequiredAppOrigin();
  } catch {
    appOrigin = undefined;
  }
  const appInfo: Stripe.AppInfo = appOrigin
    ? { name: "Hone", url: appOrigin }
    : { name: "Hone" };
  cached = new Stripe(secret, {
    apiVersion: STRIPE_API_VERSION,
    typescript: true,
    appInfo,
  });
  return cached;
}

export { STRIPE_API_VERSION };

/**
 * Whether the current process is configured against Stripe live mode.
 * Used to set the `stripe_livemode` column on payment-settings /
 * provisioning-attempt / events rows.
 */
export function inferStripeLivemode(): boolean {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  return key.startsWith("sk_live_");
}

/**
 * Country for Express connected-account creation. Hardcoded to Canada
 * for the current single-country rollout. To generalize, plumb a
 * per-studio `country` column into the schema and read it here.
 */
export const STRIPE_CONNECT_COUNTRY: string =
  process.env.STRIPE_CONNECT_COUNTRY ?? "CA";

// ---------------------------------------------------------------------------
// App-origin resolution
// ---------------------------------------------------------------------------
//
// Used to build Stripe `return_url` / `refresh_url` and the Stripe SDK
// appInfo.url. The resolution logic now lives in lib/app-origin.ts so
// every link-generation call site (portal magic links, manage/cancel/
// reschedule links, intake links, cron reminders, Stripe return URLs)
// shares one source of truth. This wrapper is preserved so existing
// `import { getAppOrigin } from "@/lib/stripe/server"` callers keep
// working; new callers should import `getRequiredAppOrigin` directly.
// ---------------------------------------------------------------------------
export { getRequiredAppOrigin as getAppOrigin } from "@/lib/app-origin";
