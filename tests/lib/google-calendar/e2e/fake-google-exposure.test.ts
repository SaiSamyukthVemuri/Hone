import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isE2eFakeGoogleEnabled } from "@/lib/google-calendar/e2e/fake-google-guard";

// Proves the fake Google system cannot be reached in a production build: the fake
// authorize route is guarded (404 when the guard fails), the network seam only
// routes to the fake when the fail-closed guard passes, the fake modules are
// server-only, and no browser-selectable (NEXT_PUBLIC_*) flag exists.

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("fake Google: not exposed in a production build", () => {
  it("the fake authorize route is guarded and 404s when the guard fails", () => {
    const src = read("app/api/google-calendar/e2e/authorize/route.ts");
    expect(src).toMatch(/assertE2eFakeGoogleAllowed\(process\.env\)/);
    expect(src).toMatch(/status:\s*404/);
    // The redirect only happens AFTER the guard assertion (guard precedes it).
    expect(src.indexOf("assertE2eFakeGoogleAllowed")).toBeLessThan(src.indexOf("NextResponse.redirect"));
  });

  it("the network seam routes to the fake ONLY when the fail-closed guard passes", () => {
    const src = read("lib/google-calendar/google-transport.ts");
    // Guard-gated: fake only when isE2eFakeGoogleEnabled(); otherwise the real fetch.
    expect(src).toMatch(/if \(isE2eFakeGoogleEnabled\(\)\) return fakeGoogleFetch\(/);
    expect(src).toMatch(/return fetch\(input, init\)/);
    expect(src.indexOf("isE2eFakeGoogleEnabled()")).toBeLessThan(src.indexOf("return fetch(input, init)"));
  });

  it("oauth.ts makes NO raw network fetch, every Google call goes through googleFetch", () => {
    const src = read("lib/google-calendar/oauth.ts");
    expect(src).not.toMatch(/await fetch\(/);
    expect(src).toMatch(/await googleFetch\(/);
  });

  it("the fake modules are server-only", () => {
    for (const p of [
      "lib/google-calendar/e2e/fake-google-guard.ts",
      "lib/google-calendar/e2e/fake-google-ledger.ts",
      "lib/google-calendar/e2e/fake-google-provider.ts",
      "lib/google-calendar/google-transport.ts",
    ]) {
      expect(read(p).startsWith('import "server-only"')).toBe(true);
    }
  });

  it("no browser-selectable (NEXT_PUBLIC_*) fake-Google flag exists in the seam", () => {
    for (const p of [
      "lib/google-calendar/e2e/fake-google-guard.ts",
      "lib/google-calendar/google-transport.ts",
      "lib/google-calendar/config.ts",
      "app/api/google-calendar/e2e/authorize/route.ts",
    ]) {
      expect(read(p)).not.toMatch(/NEXT_PUBLIC_[A-Z_]*(FAKE|GOOGLE_E2E)/);
    }
  });

  it("is OFF by default in this (non-E2E) runtime", () => {
    // The unit-test process sets no HONE_E2E_FAKE_GOOGLE marker → fake is inert.
    expect(isE2eFakeGoogleEnabled(process.env)).toBe(false);
  });
});
