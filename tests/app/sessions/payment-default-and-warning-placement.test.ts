import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// PR #200: service price default for the Session payment prepare form
// (booked service; client custom pricing wins). No executor, gate, or
// Stripe-call change.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const SESSION_PAGE = read(
  "app/(app)/clients/[id]/sessions/[sessionId]/page.tsx",
);
const RESOLVER = read("lib/billing/session-payment-amount.ts");

// ---------------------------------------------------------------------------
// Session payment default amount
// ---------------------------------------------------------------------------

// The pure pricing resolver moved to lib/billing/session-payment-amount.ts and
// is covered in full by tests/lib/billing/session-payment-amount.test.ts. The
// old display-default resolver is retired: it produced a SUGGESTION the browser
// could edit, and that edit became the charged amount (F-PAY-001).

describe("Session payment prepare form wiring", () => {
  it("the session page resolves the default from appointment + custom pricing and passes it down", () => {
    expect(SESSION_PAGE).toMatch(/getAuthoritativeSessionPaymentAmount\(\{/);
    // BARE-TABLE embed. The old `services:service_id(...)` column hint stopped
    // resolving when migration 0151 replaced the single-column FK with a
    // composite one (PGRST200), so the default was always null here. See
    // tests/app/tenant-consistency-embeds.test.ts for the permanent ban.
    expect(SESSION_PAGE).toMatch(
      /service:services\(name, price_cents, modality\)/,
    );
    // The page no longer assembles pricing itself: no client_pricing read and
    // no local precedence. ONE shared trusted loader serves the page, the
    // quick-checkout modal and the prepare action.
    expect(SESSION_PAGE).toMatch(/getAuthoritativeSessionPaymentAmount\(\{/);
    expect(SESSION_PAGE).toMatch(/amountResult=\{sessionPaymentAmount\}/);
    const pageCode = SESSION_PAGE.replace(/\/\*[\s\S]*?\*\//g, "").replace(
      /^\s*\/\/.*$/gm,
      "",
    );
    expect(pageCode).not.toMatch(/from\("client_pricing"\)/);
  });
});

describe("safety: defaulting is display-only", () => {
  it("the resolver imports nothing (pure) and never calls Stripe", () => {
    expect(RESOLVER).not.toMatch(/^import /m);
    expect(RESOLVER).not.toMatch(/require\(/);
    expect(RESOLVER).not.toMatch(/paymentIntents|stripeClient|getStripe/);
  });

  it("prepare/execute actions and the executor are untouched surfaces", () => {
    const actions = read(
      "app/(app)/clients/[id]/sessions/[sessionId]/payment-actions.ts",
    );
    expect(actions).not.toMatch(/resolveSessionPaymentDefault/);
    expect(actions).not.toMatch(/resolveAuthoritativeSessionPaymentAmount\(/);
    expect(
      existsSync(join(process.cwd(), "lib/billing/session-payment-charge.ts")),
    ).toBe(true);
    const executor = read("lib/billing/session-payment-charge.ts");
    expect(executor).not.toMatch(/resolveSessionPaymentDefault/);
  });
});
