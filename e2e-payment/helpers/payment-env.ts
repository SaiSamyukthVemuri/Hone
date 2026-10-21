import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { E2E_APP_ORIGIN, E2E_WEB_SERVER_ENV } from "../../e2e/helpers/local-env";

// Environment wiring for the dedicated payment browser E2E lane.
//
// ONE validated run id is shared across all four participants:
//   * the Next.js server process (via PAYMENT_WEB_SERVER_ENV → webServer.env),
//   * the Playwright runner + worker processes (via process.env, set below),
//   * the guarded server-side fake ledger (reads HONE_E2E_RUN_ID),
//   * the Playwright-side ledger helper (reads HONE_E2E_RUN_ID).
//
// The CI job exports HONE_E2E_RUN_ID before launching Playwright, so this module
// reuses it; locally (or if unset) it generates one and pins it on process.env so
// the value the webServer receives is the SAME value the worker processes inherit.
// The run id matches the fake-Stripe guard regex (lib/stripe/e2e-fake-guard.ts).

function resolveRunId(): string {
  const existing = process.env.HONE_E2E_RUN_ID;
  if (existing && /^[a-z0-9][a-z0-9-]{7,63}$/i.test(existing)) return existing;
  const generated = `run-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  process.env.HONE_E2E_RUN_ID = generated;
  return generated;
}

export const PAYMENT_E2E_RUN_ID = resolveRunId();
export const PAYMENT_E2E_APP_ORIGIN = E2E_APP_ORIGIN;

// The Next server env: the proven local E2E env PLUS the two server-only fake
// markers. No NEXT_PUBLIC_* fake flag, no Vercel markers, sk_test_dummy only, so
// the fake-Stripe activation guard passes ONLY here and never in a deployed lane.
// PAY-CCY-09 (Codex P2 4264919601). The payment server is also preloaded with
// a Stripe egress guard: any connection to *.stripe.com from the SERVER process
// (where the charge/refund SDK calls run) is refused and recorded here, so a
// spec proves "no Stripe network" where it would actually happen.
//
// Loaded with `--import`, NOT a second `--require`: Next.js re-parses
// NODE_OPTIONS for its build/start children and MERGES a repeated flag into
// one value ("A B"), which it re-emits as a single nonexistent module path.
// The shared Sentry guard keeps its own `--require` exactly as every lane has
// it (globalSetup checks for it); the Stripe guard rides a different flag.
export const PAYMENT_STRIPE_EGRESS_GUARD = path.join(__dirname, "stripe-egress-guard.cjs");
export const PAYMENT_STRIPE_EGRESS_LOG = path.join(
  tmpdir(),
  `hone-e2e-stripe-egress-${PAYMENT_E2E_RUN_ID}.jsonl`,
);

function withStripeEgressGuard(coreNodeOptions: string | undefined): string {
  const current = (coreNodeOptions ?? "").trim();
  const target = pathToFileURL(PAYMENT_STRIPE_EGRESS_GUARD).href; // no spaces, safe in NODE_OPTIONS
  if (current.includes(target)) return current;
  return `${current} --import ${target}`.trim();
}

type EgressRecord = { kind: "armed" | "refused"; via?: string; host?: string; pid?: number; at: string };

function readEgressLog(): EgressRecord[] {
  if (!existsSync(PAYMENT_STRIPE_EGRESS_LOG)) return [];
  return readFileSync(PAYMENT_STRIPE_EGRESS_LOG, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as EgressRecord);
}

/** Every Stripe connection the payment server attempted (and was refused). */
export function readStripeEgress(): EgressRecord[] {
  return readEgressLog().filter((r) => r.kind === "refused");
}

/** True once the guard has armed in at least one payment-server process, so an
 * empty readStripeEgress() is evidence rather than an unloaded guard. */
export function stripeEgressGuardArmed(): boolean {
  return readEgressLog().some((r) => r.kind === "armed");
}

export const PAYMENT_WEB_SERVER_ENV: Record<string, string> = {
  ...E2E_WEB_SERVER_ENV,
  HONE_E2E_FAKE_STRIPE: "1",
  HONE_E2E_RUN_ID: PAYMENT_E2E_RUN_ID,
  // The core lanes' NODE_OPTIONS (Sentry guard --require) + the Stripe guard --import.
  NODE_OPTIONS: withStripeEgressGuard(E2E_WEB_SERVER_ENV.NODE_OPTIONS),
  HONE_E2E_STRIPE_EGRESS_LOG: PAYMENT_STRIPE_EGRESS_LOG,
};
