import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";

// Dependency guard: the payment eligibility seed harness is TEST-ONLY. It seeds
// the full payment chain via privileged SQL and must never be reachable from any
// production route, server action, component, or library.
describe("payment-seed fixture is test-only (no production import)", () => {
  it("no app/lib/components file imports the seed harness", () => {
    // grep the production trees for any import of the fixture helper.
    let hits = "";
    try {
      hits = execSync(
        "grep -rEl \"db/helpers/payment-seed|helpers/payment-seed\" app lib components middleware.ts 2>/dev/null || true",
        { cwd: process.cwd(), encoding: "utf8" },
      ).trim();
    } catch {
      hits = "";
    }
    expect(hits).toBe("");
  });
});
