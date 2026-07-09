import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Portal verify-page TTL copy fix (copy only). The login page + email were
// already correct ("1 hour"); the verify page still said "30 minutes" (stale
// since the TTL was raised to 60 min in PR #166). Fix the copy only — no token /
// hashing / TTL / verify-behavior / enumeration change.
function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}
const VERIFY = read("app/portal/verify/[token]/page.tsx");
const LOGIN = read("app/portal/login/page.tsx");
const ISSUANCE = read("app/portal/login/actions.ts");
const HELPER = read("lib/portal/magic-link.ts");

describe("portal verify-page expiry copy matches the 60-minute TTL", () => {
  it("verify page no longer says 30 minutes", () => {
    expect(VERIFY).not.toMatch(/30 minutes/);
  });
  it("verify page says 1 hour", () => {
    expect(VERIFY).toMatch(/expire after 1 hour/);
  });
  it("login page still says 1 hour (unchanged since PR #367)", () => {
    expect(LOGIN).toMatch(/expires in 1 hour/);
    expect(LOGIN).not.toMatch(/30 minutes/);
  });
  it("the actual TTL constant remains 60 minutes (unchanged)", () => {
    expect(ISSUANCE).toMatch(/const MAGIC_LINK_TTL_MS = 60 \* 60 \* 1000;/);
    expect(HELPER).toMatch(/PORTAL_MAGIC_LINK_TTL_MS = 60 \* 60 \* 1000;/);
  });
  it("copy-only: verify behavior + token handling in the verify page are intact", () => {
    // the token hash-lookup + expiry + single-use checks are still present.
    expect(VERIFY).toMatch(/hashToken/);
    expect(VERIFY).toMatch(/expires_at/);
    expect(VERIFY).toMatch(/consumed_at/);
    // the copy change introduced no TTL redefinition on the verify page.
    expect(VERIFY).not.toMatch(/MAGIC_LINK_TTL_MS\s*=/);
  });
});
