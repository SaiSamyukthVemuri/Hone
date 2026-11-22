import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #166. Secure-link expiry audit: the portal magic-link TTL was raised
// from 30 to 60 minutes. The value is pinned in
// tests/lib/portal/magic-link.test.ts; this file pins that the insert
// site reads the constant.

const ACTIONS_PATH = path.resolve(
  __dirname,
  "../../../../app/portal/login/actions.ts",
);
const SOURCE = readFileSync(ACTIONS_PATH, "utf8");

describe("portal magic-link insert uses the TTL constant", () => {
  it("expiresAt is computed from MAGIC_LINK_TTL_MS, not a literal", () => {
    // The insert site must read the TTL from the constant so a
    // future change is single-source. A literal minute count
    // wired directly into the insert would defeat the TTL test
    // above.
    expect(SOURCE).toMatch(
      /const expiresAt = new Date\(Date\.now\(\) \+ MAGIC_LINK_TTL_MS\)/,
    );
  });
});
