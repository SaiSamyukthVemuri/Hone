import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// The email and fresh sign-in page explain the TTL. Someone using an old
// message gets an actionable recovery prompt without diagnosing their session.
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
  it("offers a fresh sign-in link without a contradictory expiry headline", () => {
    expect(VERIFY).toMatch(/Get a fresh sign-in link/);
    expect(VERIFY).not.toMatch(/link has expired|secure link can.t be used/i);
  });
  it("login page still says 1 hour (unchanged since PR #367)", () => {
    expect(LOGIN).toMatch(/expires in 1 hour/);
    expect(LOGIN).not.toMatch(/30 minutes/);
  });
  it("the actual TTL constant remains 60 minutes (unchanged)", () => {
    expect(ISSUANCE).toMatch(/const MAGIC_LINK_TTL_MS = 60 \* 60 \* 1000;/);
    expect(HELPER).toMatch(/PORTAL_MAGIC_LINK_TTL_MS = 60 \* 60 \* 1000;/);
  });
  it("the verify page still uses the one-time token and keeps its checks", () => {
    // the token hash-lookup + expiry + single-use checks are still present.
    expect(VERIFY).toMatch(/hashToken/);
    expect(VERIFY).toMatch(/expires_at/);
    expect(VERIFY).toMatch(/consumed_at/);
    // the copy change introduced no TTL redefinition on the verify page.
    expect(VERIFY).not.toMatch(/MAGIC_LINK_TTL_MS\s*=/);
  });
});
