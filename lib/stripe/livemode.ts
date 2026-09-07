// ===========================================================================
// The Stripe mode flag, and NOTHING else
// ===========================================================================
//
// WHY THIS FILE EXISTS. `inferStripeLivemode` used to be defined in
// lib/stripe/server.ts, which imports the Stripe SDK and constructs a client.
// Any module that needed only the MODE therefore acquired the whole SDK.
//
// That is fatal for the owner Financials surface. FIN-01A's contract is that
// /financials makes no Stripe call, and its guard proves the property by
// walking the compiler-resolved static ESM closure of the route. Importing the
// mode from lib/stripe/server.ts would put the SDK inside that closure and the
// guard would — correctly — fail.
//
// The alternative was a second copy of the rule inside lib/finance. That is the
// defect lib/booking/reporting-period.ts already exists to prevent: it was
// extracted OUT of lib/dashboard/practice-metrics.ts for exactly this reason,
// so the period vocabulary would not drag a money module behind it. A second
// implementation of "which Stripe mode is this deployment in" would let the
// ledger be read in one mode and written in another, which is how test money
// and real money end up in the same total.
//
// So the rule moved DOWN to a leaf module with no imports at all, and
// lib/stripe/server.ts re-exports it. THERE IS STILL EXACTLY ONE
// IMPLEMENTATION; every existing caller keeps importing it from where it
// always did, and nothing about the mode rule changed.

/**
 * Whether the current process is configured against Stripe live mode.
 *
 * DEPLOYMENT-GLOBAL, NOT PER-STUDIO. It reads the process environment, so every
 * studio served by one deployment is in the same mode. A reader that scopes a
 * money query by studio still has to scope it by THIS, because migration 0105
 * permits one TEST and one LIVE succeeded attempt for the same session — and
 * summing across modes counts a single real-world payment twice.
 */
export function inferStripeLivemode(): boolean {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  return key.startsWith("sk_live_");
}
