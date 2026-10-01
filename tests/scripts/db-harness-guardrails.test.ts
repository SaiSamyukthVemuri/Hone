import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
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

/**
 * EVERY workflow, enumerated from the directory - not `ci.yml` alone.
 *
 * CI-COST-01: the production-safety scans below were bound to the literal
 * ".github/workflows/ci.yml" since PR #220, when ci.yml was the only workflow
 * that touched a database. It is no longer the only workflow, and it is no
 * longer the one triggered by a push to the production branch - post-merge.yml
 * is. A guard that names one file exempts every file added after it, and the
 * exemption is invisible: a reviewer reading this test sees "CI is secret-free"
 * and has no reason to ask which CI.
 *
 * Membership is by EXTENSION, matching what GitHub Actions itself reads, so a
 * new workflow is enrolled by existing rather than by somebody remembering to
 * edit this file. Same reasoning, and same shape, as readWorkflowDir() in
 * tests/ci/ci-config.test.ts.
 */
const WORKFLOW_DIR = ".github/workflows";
function readWorkflows(): ReadonlyArray<readonly [string, string]> {
  const dir = path.resolve(__dirname, "../..", WORKFLOW_DIR);
  return readdirSync(dir)
    .filter((n) => /\.ya?ml$/.test(n))
    .filter((n) => statSync(path.join(dir, n)).isFile())
    .sort()
    .map((n) => [n, readFileSync(path.join(dir, n), "utf8")] as const);
}
const WORKFLOWS = readWorkflows();

/** A workflow's executable text: comment-only lines stripped. */
function executableText(body: string): string {
  return body
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");
}

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

  it("NO workflow uses --linked, a project ref, or an access token", () => {
    // Scan executable lines only; comments may mention --linked to
    // document that it is NOT used.
    const offenders: string[] = [];
    for (const [file, body] of WORKFLOWS) {
      const executable = executableText(body);
      for (const [label, re] of [
        ["--linked", /--linked/],
        ["SUPABASE_ACCESS_TOKEN", /SUPABASE_ACCESS_TOKEN/],
        ["db push", /db push/],
        ["secrets.", /secrets\./],
      ] as const) {
        if (re.test(executable)) offenders.push(`${file}: ${label}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("NO workflow points the harness anywhere", () => {
    // No HONE_LOCAL_DB_URL override in any workflow: the harness uses its
    // localhost default, and the in-harness guard is the backstop.
    expect(
      WORKFLOWS.filter(([, body]) => /HONE_LOCAL_DB_URL/.test(body)).map(([f]) => f),
    ).toEqual([]);
  });

  it("the workflow universe being scanned is the DIRECTORY, not one file", () => {
    // Guards the guard. If this ever reads a single file again, the scans
    // above silently stop covering whatever was added last.
    expect(WORKFLOWS.length).toBeGreaterThanOrEqual(3);
    expect(WORKFLOWS.map(([f]) => f)).toContain("post-merge.yml");
  });
});
