import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// lib/portal/session.ts pins with no behavioural equivalent: a revoked or
// expired session row resolves to null, and the module is server-only. The
// last_seen_at touch and its log privacy are proved in
// session-last-seen-privacy.test.ts.

const SESSION_PATH = path.resolve(
  __dirname,
  "../../../lib/portal/session.ts",
);
const SESSION = readFileSync(SESSION_PATH, "utf8");

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}
const SESSION_CODE = codeOnly(SESSION);

describe("session lookup / validity", () => {
  it("revoked and expired rows still resolve to null", () => {
    expect(SESSION_CODE).toMatch(/if \(data\.revoked_at\) return null;/);
    expect(SESSION_CODE).toMatch(
      /if \(data\.expires_at <= nowIso\) return null;/,
    );
  });

  it("the module is still server-only", () => {
    expect(SESSION).toMatch(/^import "server-only";/);
  });
});
