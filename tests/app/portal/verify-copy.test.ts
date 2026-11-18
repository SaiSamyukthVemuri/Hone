import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Portal expiry copy: the verify and login pages state the 60-minute
// magic-link TTL as "1 hour".
function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}
const VERIFY = read("app/portal/verify/[token]/page.tsx");
const LOGIN = read("app/portal/login/page.tsx");

describe("portal verify-page expiry copy matches the 60-minute TTL", () => {
  it("verify page says 1 hour", () => {
    expect(VERIFY).toMatch(/expire after 1 hour/);
  });
  it("login page still says 1 hour (unchanged since PR #367)", () => {
    expect(LOGIN).toMatch(/expires in 1 hour/);
    expect(LOGIN).not.toMatch(/30 minutes/);
  });
});
