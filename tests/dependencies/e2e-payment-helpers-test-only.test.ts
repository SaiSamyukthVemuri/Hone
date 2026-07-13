import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";

// Dependency guard: the payment browser-E2E helpers are TEST-ONLY. The
// Playwright-side fake ledger reader (e2e-payment/helpers/fake-stripe-ledger-e2e)
// can read/write the guarded run-scoped temp files directly, and the fixture
// bridge chains privileged local SQL — neither may EVER be reachable from any
// production route, server action, component, or library, and no production code
// may enable fake Stripe.
describe("e2e-payment helpers are test-only (no production import)", () => {
  it("no app/lib/components/middleware file imports the payment E2E helpers", () => {
    let hits = "";
    try {
      hits = execSync(
        "grep -rEl \"e2e-payment/|fake-stripe-ledger-e2e|payment-fixture\" app lib components middleware.ts 2>/dev/null || true",
        { cwd: process.cwd(), encoding: "utf8" },
      ).trim();
    } catch {
      hits = "";
    }
    expect(hits).toBe("");
  });

  it("no production tree sets HONE_E2E_FAKE_STRIPE (fake mode is test/CI-only)", () => {
    let hits = "";
    try {
      hits = execSync(
        "grep -rEl \"HONE_E2E_FAKE_STRIPE *= *.1.|HONE_E2E_FAKE_STRIPE.:.*1\" app lib components middleware.ts next.config.ts 2>/dev/null || true",
        { cwd: process.cwd(), encoding: "utf8" },
      ).trim();
    } catch {
      hits = "";
    }
    expect(hits).toBe("");
  });
});
