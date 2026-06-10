import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #186. `import "server-only"` marks 23 runtime server modules
// (billing, portal, consent, supabase admin client, calendar feed
// token helper) as server-only boundaries. The package previously
// resolved only through Next's internal vendored alias
// (next/dist/compiled/server-only); it was absent from package.json
// and the lockfile, so a Next upgrade that dropped or renamed the
// alias would silently weaken a security boundary. These tests pin
// the explicit declaration so dependency drift is caught by CI.

const ROOT = path.resolve(__dirname, "../..");
const PKG = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const LOCK = JSON.parse(
  readFileSync(path.join(ROOT, "package-lock.json"), "utf8"),
);

describe("server-only is an explicit dependency", () => {
  it("package.json declares server-only in dependencies (not devDependencies)", () => {
    expect(PKG.dependencies["server-only"]).toBeTruthy();
    expect(PKG.devDependencies?.["server-only"]).toBeUndefined();
  });

  it("package-lock.json resolves node_modules/server-only", () => {
    const entry = LOCK.packages?.["node_modules/server-only"];
    expect(entry).toBeTruthy();
    expect(entry.resolved).toContain("registry.npmjs.org/server-only");
  });

  it("the root lock entry depends on server-only", () => {
    expect(LOCK.packages?.[""]?.dependencies?.["server-only"]).toBeTruthy();
  });
});

describe("server-only boundary modules still declare the import", () => {
  // Spot-check the security-sensitive boundary files; each test that
  // pins `import "server-only"` elsewhere still applies, this is the
  // dependency PR's own canary that the import style is unchanged.
  const BOUNDARY_FILES = [
    "lib/supabase/admin-server.ts",
    "lib/portal/session.ts",
    "lib/calendar-feed/token.ts",
    "lib/billing/session-payment-charge.ts",
  ];

  for (const rel of BOUNDARY_FILES) {
    it(`${rel} imports server-only`, () => {
      const src = readFileSync(path.join(ROOT, rel), "utf8");
      expect(src).toMatch(/^import "server-only";/m);
    });
  }
});
