// Hone Canada (Connect) and Hone Care Inc (subscriptions) are two Stripe
// accounts that must never mix. The billing code must never read
// STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET; the Connect code must never read
// HONE_BILLING_*.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../..");

function files(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  const out: string[] = [];
  for (const name of readdirSync(abs)) {
    const p = path.join(abs, name);
    if (statSync(p).isDirectory()) out.push(...files(path.relative(ROOT, p)));
    else if (/\.(ts|tsx)$/.test(name)) out.push(path.relative(ROOT, p));
  }
  return out;
}

const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/** Strip comments so prose that NAMES a variable is not mistaken for reading it. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// `STRIPE_SECRET_KEY` not preceded by another identifier character, so
// HONE_BILLING_STRIPE_SECRET_KEY does not match.
const CONNECT_VAR = /(?<![A-Z0-9_])STRIPE_(SECRET_KEY|WEBHOOK_SECRET|ALLOW_LIVE_MODE|CONNECT_COUNTRY)\b/;
const BILLING_VAR = /HONE_BILLING_|HONE_STRIPE_PRICE_|HONE_SELF_SERVE_CHECKOUT_ENABLED/;

const BILLING_SIDE = [...files("lib/subscriptions"), ...files("app/api/billing")];
const CONNECT_SIDE = [
  ...files("lib/stripe"),
  ...files("lib/billing"),
  ...files("lib/payments"),
  ...files("app/api/stripe"),
];

describe("billing / Connect Stripe separation", () => {
  it("scans real files on both sides (anti-vacuity)", () => {
    expect(BILLING_SIDE.length).toBeGreaterThanOrEqual(5);
    expect(CONNECT_SIDE.length).toBeGreaterThan(10);
    // The detector does find the Connect variable where it is really read.
    expect(CONNECT_VAR.test(code(read("lib/stripe/server.ts")))).toBe(true);
    // ...and does not confuse the billing variable for it.
    expect(CONNECT_VAR.test("process.env.HONE_BILLING_STRIPE_SECRET_KEY")).toBe(false);
    expect(BILLING_VAR.test(code(read("lib/subscriptions/billing-client.ts")))).toBe(true);
  });

  it("billing code never reads a Connect Stripe variable", () => {
    const offenders = BILLING_SIDE.filter((f) => CONNECT_VAR.test(code(read(f))));
    expect(offenders).toEqual([]);
  });

  it("billing code never imports the Connect Stripe client", () => {
    const offenders = BILLING_SIDE.filter((f) =>
      /@\/lib\/(stripe|billing|payments)\//.test(code(read(f))),
    );
    expect(offenders).toEqual([]);
  });

  it("Connect code never reads a billing variable", () => {
    const offenders = CONNECT_SIDE.filter((f) => BILLING_VAR.test(code(read(f))));
    expect(offenders).toEqual([]);
  });

  it("never passes a connected-account option to the billing Stripe API", () => {
    const src = code(read("lib/subscriptions/billing-client.ts"));
    expect(src).not.toMatch(/stripeAccount|Stripe-Account/i);
  });
});
