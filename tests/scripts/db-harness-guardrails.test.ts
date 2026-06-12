import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #220. Static pins (unit lane) for the DB/RLS integration
// harness guardrails. The harness itself runs in the separate
// `npm run test:db` lane against a local database; these pins make
// sure the SAFETY PROPERTIES of that lane cannot quietly erode:
// the unit lane stays DB-free, the harness stays localhost-only,
// and the CI job stays secret-free and production-blind.

function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../..", rel), "utf8");
}

const HARNESS = read("tests/db/helpers/harness.ts");
const UNIT_CONFIG = read("vitest.config.ts");
const DB_CONFIG = read("vitest.db.config.ts");
const CI = read(".github/workflows/ci.yml");
const PKG = read("package.json");

describe("unit lane stays DB-free", () => {
  it("vitest.config.ts excludes tests/db/**", () => {
    expect(UNIT_CONFIG).toMatch(/"tests\/db\/\*\*"/);
  });

  it("the db lane has its own config and script", () => {
    expect(DB_CONFIG).toMatch(/include: \["tests\/db\/\*\*\/\*\.db\.test\.ts"\]/);
    expect(PKG).toMatch(
      /"test:db": "vitest run --config vitest\.db\.config\.ts"/,
    );
  });

  it("npm run ci does not gain a hidden DB dependency", () => {
    // The fast lane must keep working without Docker. test:db is a
    // separate script and a separate CI job, never part of `ci`.
    const ciScript = JSON.parse(PKG).scripts.ci as string;
    expect(ciScript).not.toMatch(/test:db/);
  });
});

describe("harness is localhost-only by construction", () => {
  it("allows only localhost hosts", () => {
    expect(HARNESS).toMatch(/LOCAL_HOSTS = new Set\(\["127\.0\.0\.1", "localhost"/);
    expect(HARNESS).toMatch(/is not localhost/);
  });

  it("refuses hosted-database URL patterns", () => {
    expect(HARNESS).toMatch(
      /supabase\\\.co\|supabase\\\.com\|supabase\\\.in\|pooler\\\.\|amazonaws\\\.com/,
    );
    expect(HARNESS).toMatch(/hosted-database host pattern/);
  });

  it("reads no production credentials", () => {
    expect(HARNESS).not.toMatch(/NEXT_PUBLIC_SUPABASE_URL\s*[^,\s]/);
    expect(HARNESS).not.toMatch(/process\.env\.SUPABASE_SERVICE_ROLE_KEY/);
    expect(HARNESS).not.toMatch(/process\.env\.STRIPE/);
    // The single env var it consults:
    const envReads = HARNESS.match(/process\.env\.[A-Z_]+/g) ?? [];
    expect([...new Set(envReads)]).toEqual(["process.env.HONE_LOCAL_DB_URL"]);
  });

  it("simulates auth with fake local users, not real accounts", () => {
    expect(HARNESS).toMatch(/@harness\.local/);
    expect(HARNESS).toMatch(/randomUUID\(\)/);
    expect(HARNESS).toMatch(/request\.jwt\.claims/);
  });
});

describe("CI db-integration job is local-only and secret-free", () => {
  it("the job exists and runs the db lane", () => {
    expect(CI).toMatch(/db-integration:/);
    expect(CI).toMatch(/supabase db start/);
    expect(CI).toMatch(/supabase db reset --local/);
    expect(CI).toMatch(/npm run test:db/);
  });

  it("never uses --linked, a project ref, or an access token", () => {
    // Scan executable lines only; comments may mention --linked to
    // document that it is NOT used.
    const runLines = CI.split("\n").filter(
      (l) => !l.trim().startsWith("#"),
    );
    const executable = runLines.join("\n");
    expect(executable).not.toMatch(/--linked/);
    expect(executable).not.toMatch(/SUPABASE_ACCESS_TOKEN/);
    expect(executable).not.toMatch(/db push/);
    expect(executable).not.toMatch(/secrets\./);
  });

  it("does not point the harness anywhere", () => {
    // No HONE_LOCAL_DB_URL override in CI: the harness uses its
    // localhost default, and the in-harness guard is the backstop.
    expect(CI).not.toMatch(/HONE_LOCAL_DB_URL/);
  });
});
