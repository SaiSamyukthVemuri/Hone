import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertSeedTargetsE2eDatabase } from "@/e2e-payment/helpers/db-target-guard";

// The payment browser fixtures must never seed a different database from the
// one the browser app uses. Twice on 2026-10-12 a run whose local-env pointed
// at an isolated stack seeded the SHARED 54322 stack through the tests/db
// harness fallback instead.

const SHARED = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ISOLATED = "postgresql://postgres:postgres@127.0.0.1:65322/postgres";

describe("assertSeedTargetsE2eDatabase", () => {
  it("passes when both point at the same stack (the CI default)", () => {
    expect(() => assertSeedTargetsE2eDatabase(SHARED, SHARED)).not.toThrow();
    expect(() => assertSeedTargetsE2eDatabase(ISOLATED, ISOLATED)).not.toThrow();
  });

  it("REFUSES the spill shape: app on an isolated stack, harness on the shared fallback", () => {
    expect(() => assertSeedTargetsE2eDatabase(SHARED, ISOLATED)).toThrow(
      /refuses to seed.*127\.0\.0\.1:54322.*127\.0\.0\.1:65322/,
    );
  });

  it("refuses the reverse, a different host, and an unparseable URL", () => {
    expect(() => assertSeedTargetsE2eDatabase(ISOLATED, SHARED)).toThrow(/refuses to seed/);
    expect(() =>
      assertSeedTargetsE2eDatabase(SHARED, "postgresql://postgres:postgres@localhost:54322/postgres"),
    ).toThrow(/refuses to seed/);
    expect(() => assertSeedTargetsE2eDatabase("not a url", SHARED)).toThrow(/refuses to seed/);
  });

  it("is enforced at import by the payment fixture, before any seed", () => {
    const src = readFileSync(
      path.join(process.cwd(), "e2e-payment/helpers/payment-fixture.ts"),
      "utf8",
    );
    expect(src).toContain("assertSeedTargetsE2eDatabase(resolveLocalDbUrl(), E2E_DB_URL);");
    // ...and at module level, ahead of the first exported seeding function.
    expect(src.indexOf("assertSeedTargetsE2eDatabase(resolveLocalDbUrl()")).toBeLessThan(
      src.indexOf("export async function"),
    );
  });
});
