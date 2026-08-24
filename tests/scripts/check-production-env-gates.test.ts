import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  isNewClientWaitlistDurableEnabled,
  NEW_CLIENT_WAITLIST_DURABLE_SLUGS_ENV,
} from "@/lib/booking/new-client-waitlist";

// PR #262: Production public-rate-limit env gate.
//
// scripts/check-production-env-gates.mjs is the deploy-time complement to
// the runtime fail-open in lib/rate-limit/public.ts. On a Vercel
// production build (VERCEL_ENV === "production") it MUST fail when the
// required Upstash vars are missing, so a misconfigured production deploy
// cannot ship with public rate limiting silently disabled. Off-production
// (local / CI / preview) it MUST be a no-op so builds without Upstash
// configured still pass.
//
// The script is driven with an EXPLICIT, controlled env (never a spread of
// process.env): this Mac is production-connected via .env.local, so
// inheriting env could (a) pull real Upstash/secret values into the test
// and (b) make the production-gate cases non-deterministic. We pass only
// PATH (so `node` resolves) plus the exact vars each case needs.

const REPO_ROOT = path.resolve(__dirname, "../..");
const SCRIPT_PATH = path.resolve(
  REPO_ROOT,
  "scripts/check-production-env-gates.mjs",
);
const SCRIPT_SOURCE = readFileSync(SCRIPT_PATH, "utf8");

// Sentinel values: if the gate ever printed an env VALUE these would show
// up in stdout/stderr. The gate must only ever print variable NAMES.
const URL_SENTINEL = "URLVAL_must_never_be_printed";
const TOKEN_SENTINEL = "TOKVAL_must_never_be_printed";
// PR #291: a configured OPS_ALERT_EMAILS address must never be printed either.
const OPS_EMAIL_SENTINEL = "ops-alerts+secret@example.invalid";
// WAIT-02B: a configured studio slug must never be printed either.
// Shaped like a real slug so the case is realistic, and distinctive so a leak
// anywhere in stdout/stderr is unmissable.
const DURABLE_SLUG_SENTINEL = "willowlike-studio-must-never-be-printed";
const DURABLE_SLUG_SENTINEL_2 = "second-studio-must-never-be-printed";
// The env every production gate needs, so a case can isolate ONE gate.
const PRODUCTION_BASELINE = {
  VERCEL_ENV: "production",
  UPSTASH_REDIS_REST_URL: URL_SENTINEL,
  UPSTASH_REDIS_REST_TOKEN: TOKEN_SENTINEL,
  OPS_ALERT_EMAILS: OPS_EMAIL_SENTINEL,
};

function run(env: Record<string, string>) {
  return spawnSync("node", [SCRIPT_PATH], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    // Controlled env only. PATH lets the `node` binary resolve. Cast via
    // unknown because Next augments NodeJS.ProcessEnv to require NODE_ENV;
    // we intentionally pass a minimal partial env (the gate keys on
    // VERCEL_ENV, never NODE_ENV).
    env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv,
  });
}

describe("check-production-env-gates script (PR #262)", () => {
  it("FAILS a production build when UPSTASH_REDIS_REST_URL is missing", () => {
    const r = run({
      VERCEL_ENV: "production",
      UPSTASH_REDIS_REST_TOKEN: TOKEN_SENTINEL,
    });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/UPSTASH_REDIS_REST_URL/);
    expect(r.stdout + r.stderr).toMatch(/FAIL public-rate-limit-env/);
    // The present var's VALUE must not leak even on the failure path.
    expect(r.stdout + r.stderr).not.toContain(TOKEN_SENTINEL);
  });

  it("FAILS a production build when UPSTASH_REDIS_REST_TOKEN is missing", () => {
    const r = run({
      VERCEL_ENV: "production",
      UPSTASH_REDIS_REST_URL: URL_SENTINEL,
    });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/UPSTASH_REDIS_REST_TOKEN/);
    expect(r.stdout + r.stderr).not.toContain(URL_SENTINEL);
  });

  it("FAILS when a required var is present but empty", () => {
    const r = run({
      VERCEL_ENV: "production",
      UPSTASH_REDIS_REST_URL: "",
      UPSTASH_REDIS_REST_TOKEN: TOKEN_SENTINEL,
    });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/UPSTASH_REDIS_REST_URL/);
  });

  it("PASSES a production build when Upstash vars AND OPS_ALERT_EMAILS are present", () => {
    const r = run({
      VERCEL_ENV: "production",
      UPSTASH_REDIS_REST_URL: URL_SENTINEL,
      UPSTASH_REDIS_REST_TOKEN: TOKEN_SENTINEL,
      OPS_ALERT_EMAILS: OPS_EMAIL_SENTINEL,
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^PASS public-rate-limit-env/m);
    expect(r.stdout).toMatch(/^PASS ops-alert-delivery-env/m);
  });

  it("never prints env VALUES — only variable NAMES (all-present case)", () => {
    const r = run({
      VERCEL_ENV: "production",
      UPSTASH_REDIS_REST_URL: URL_SENTINEL,
      UPSTASH_REDIS_REST_TOKEN: TOKEN_SENTINEL,
      OPS_ALERT_EMAILS: OPS_EMAIL_SENTINEL,
    });
    const out = r.stdout + r.stderr;
    expect(out).not.toContain(URL_SENTINEL);
    expect(out).not.toContain(TOKEN_SENTINEL);
    // A configured alert email address must never be printed.
    expect(out).not.toContain(OPS_EMAIL_SENTINEL);
    // The names themselves are expected to appear.
    expect(out).toMatch(/UPSTASH_REDIS_REST_URL/);
    expect(out).toMatch(/OPS_ALERT_EMAILS/);
  });

  // --- PR #291: critical ops-alert delivery gate ---------------------------

  it("FAILS a production build when OPS_ALERT_EMAILS is missing (Upstash present)", () => {
    const r = run({
      VERCEL_ENV: "production",
      UPSTASH_REDIS_REST_URL: URL_SENTINEL,
      UPSTASH_REDIS_REST_TOKEN: TOKEN_SENTINEL,
    });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/FAIL ops-alert-delivery-env/);
    expect(r.stdout + r.stderr).toMatch(/OPS_ALERT_EMAILS/);
    // Upstash gate still passes independently.
    expect(r.stdout).toMatch(/^PASS public-rate-limit-env/m);
  });

  it("FAILS a production build when OPS_ALERT_EMAILS is empty", () => {
    const r = run({
      VERCEL_ENV: "production",
      UPSTASH_REDIS_REST_URL: URL_SENTINEL,
      UPSTASH_REDIS_REST_TOKEN: TOKEN_SENTINEL,
      OPS_ALERT_EMAILS: "",
    });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/FAIL ops-alert-delivery-env/);
  });

  it("FAILS a production build when OPS_ALERT_EMAILS is whitespace/comma-only (zero recipients)", () => {
    const r = run({
      VERCEL_ENV: "production",
      UPSTASH_REDIS_REST_URL: URL_SENTINEL,
      UPSTASH_REDIS_REST_TOKEN: TOKEN_SENTINEL,
      OPS_ALERT_EMAILS: " , ,  ",
    });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/FAIL ops-alert-delivery-env/);
  });

  it("PASSES with a multi-recipient OPS_ALERT_EMAILS and never prints the addresses", () => {
    const r = run({
      VERCEL_ENV: "production",
      UPSTASH_REDIS_REST_URL: URL_SENTINEL,
      UPSTASH_REDIS_REST_TOKEN: TOKEN_SENTINEL,
      OPS_ALERT_EMAILS: `${OPS_EMAIL_SENTINEL}, second-secret@example.invalid`,
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^PASS ops-alert-delivery-env/m);
    const out = r.stdout + r.stderr;
    expect(out).not.toContain(OPS_EMAIL_SENTINEL);
    expect(out).not.toContain("second-secret@example.invalid");
  });

  it("does NOT require OPS_ALERT_EMAILS off-production (preview, missing)", () => {
    const r = run({ VERCEL_ENV: "preview" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^SKIP public-rate-limit-env/m);
    // No FAIL for the missing ops-alert var outside production.
    expect(r.stdout + r.stderr).not.toMatch(/FAIL ops-alert-delivery-env/);
  });

  it("still requires Upstash even when OPS_ALERT_EMAILS is set (gates are independent)", () => {
    const r = run({
      VERCEL_ENV: "production",
      OPS_ALERT_EMAILS: OPS_EMAIL_SENTINEL,
    });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/FAIL public-rate-limit-env/);
    // The ops-alert gate itself passes; only Upstash fails here.
    expect(r.stdout).toMatch(/^PASS ops-alert-delivery-env/m);
    expect(r.stdout + r.stderr).not.toContain(OPS_EMAIL_SENTINEL);
  });

  it("is a NO-OP on preview deploys (env intentionally absent)", () => {
    const r = run({ VERCEL_ENV: "preview" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^SKIP public-rate-limit-env/m);
  });

  it("is a NO-OP when VERCEL_ENV is unset (local / CI build)", () => {
    // No VERCEL_ENV and no Upstash vars — the local/CI build path. Must
    // not fail, even though `next build` sets NODE_ENV=production.
    const r = run({ NODE_ENV: "production" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^SKIP public-rate-limit-env/m);
  });
});

// ===========================================================================
// WAIT-02B STAGE B — THE DURABLE WAITLIST ACTIVATION GUARD
// ===========================================================================
//
// Stage A made this gate a BLANKET PROHIBITION: a production build aborted
// while the allowlist named any studio at all. That existed for one reason —
// the public privacy notice did not cover a waitlist prospect, so collecting
// one would have put personal data outside every disclosed category. Stage B1
// ships that disclosure (pinned by
// tests/app/privacy/waitlist-prospect-disclosure.test.ts), so the prohibition
// is replaced by a SHAPE check.
//
// What must remain true after the swap, and is asserted below:
//
//   * unset / empty / whitespace / comma-only  -> zero studios, PASS, dark.
//     This is the state Stage B1 ships to production.
//   * an explicitly named, well-formed slug     -> PASS. Activation is now
//     possible without another code release.
//   * anything that CANNOT be a studio slug     -> FAIL. Exact-match membership
//     means a wildcard activates nothing; without this gate it would deploy
//     green and silently do nothing, which is worse than refusing it.
//   * no slug value, valid or rejected, ever reaches stdout/stderr.
//   * off-production is untouched.
const VALID_SLUG_SENTINEL = "willowlike-studio-must-never-be-printed";
// Held as NAMED CONSTANTS, never inlined at the assignment site. A repository
// guard in tests/app/book/new-client-waitlist-durable-commit.test.ts scans every
// file that names this variable for a string-literal assignment to it, and the
// only one that may exist anywhere is the reserved e2e slug. Test fixtures must
// not weaken that scan by adding literals it has to be taught to ignore.
const PADDED_MIXED_CASE_SENTINEL = "  Willowlike-Studio-UPPER  ";
const UNUSABLE_SENTINEL = "*";

describe("Stage-B durable waitlist activation guard", () => {
  it("PASSES and stays DARK when the allowlist is UNSET in production", () => {
    const r = run(PRODUCTION_BASELINE);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^PASS stage-b-durable-waitlist-env/m);
    expect(r.stdout).toMatch(/names no studio/);
    expect(r.stdout).toMatch(/stays dark/);
  });

  it.each([
    ["empty string", ""],
    ["whitespace only", "   "],
    ["commas only", ",,,"],
    ["commas and whitespace", " , ,  , "],
  ])("PASSES and stays DARK when present but enabling nobody (%s)", (_label, value) => {
    // Mirrors parseWaitlistSlugs(): these all mean OFF at runtime, so the gate
    // must not fail a deploy over a value that enables no studio, and must not
    // describe it as an activation either.
    const r = run({
      ...PRODUCTION_BASELINE,
      NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS: value,
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^PASS stage-b-durable-waitlist-env/m);
    expect(r.stdout).toMatch(/names no studio/);
  });

  // THE STAGE-B CHANGE ITSELF. Under Stage A this exact case aborted the build.
  it("PERMITS activation: one explicitly named studio PASSES a production build", () => {
    const r = run({
      ...PRODUCTION_BASELINE,
      NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS: VALID_SLUG_SENTINEL,
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const out = r.stdout + r.stderr;
    expect(r.stdout).toMatch(/^PASS stage-b-durable-waitlist-env/m);
    expect(out).toMatch(/explicitly enables 1 studio\(s\)/);
    // A COUNT is fine. THE SLUG IS NOT, on the pass path just as on the fail path.
    expect(out).not.toContain(VALID_SLUG_SENTINEL);
  });

  it("permits several explicitly named studios, reporting only the count", () => {
    const r = run({
      ...PRODUCTION_BASELINE,
      NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS: `${VALID_SLUG_SENTINEL}, ${DURABLE_SLUG_SENTINEL_2}`,
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const out = r.stdout + r.stderr;
    expect(out).toMatch(/explicitly enables 2 studio\(s\)/);
    expect(out).not.toContain(VALID_SLUG_SENTINEL);
    expect(out).not.toContain(DURABLE_SLUG_SENTINEL_2);
  });

  it("normalises case and padding exactly as the runtime does, and still passes", () => {
    const r = run({
      ...PRODUCTION_BASELINE,
      NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS: PADDED_MIXED_CASE_SENTINEL,
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/explicitly enables 1 studio\(s\)/);
  });

  // ---- malformed / unsafe activation config --------------------------------
  //
  // Every one of these matches NO studio at runtime (membership is exact
  // equality against studios.slug). The danger is not that they enable too
  // much — it is that they enable NOTHING while looking like an activation.
  it.each([
    ["a bare wildcard", "*"],
    ["a SQL-style wildcard", "%"],
    ["a regex-style catch-all", ".*"],
    ["an embedded space", "willow electrolysis"],
    ["a leading hyphen", "-willow-electrolysis"],
    ["a trailing hyphen", "willow-electrolysis-"],
    ["an underscore", "willow_electrolysis"],
    ["a URL rather than a slug", "https://hone.care/book/willow"],
    ["a slug over 64 characters", "a".repeat(65)],
    ["a quoted slug", '"willow-electrolysis"'],
  ])("FAILS a production build on %s", (_label, value) => {
    const r = run({
      ...PRODUCTION_BASELINE,
      NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS: value,
    });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    const out = r.stdout + r.stderr;
    expect(out).toMatch(/FAIL stage-b-durable-waitlist-env/);
    expect(out).toContain("NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS");
    // Not even a REJECTED entry is printed: it is still a studio identifier.
    expect(out).not.toContain(value);
  });

  it("FAILS the whole list when only ONE entry of several is unusable", () => {
    // Partial correctness must not ship: the operator believes N studios are on.
    const r = run({
      ...PRODUCTION_BASELINE,
      NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS: `${VALID_SLUG_SENTINEL}, not a slug`,
    });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    const out = r.stdout + r.stderr;
    expect(out).toMatch(/has 1 of 2 entries that cannot be a studio slug/);
    expect(out).not.toContain(VALID_SLUG_SENTINEL);
    expect(out).not.toContain("not a slug");
  });

  it("never prints a slug on ANY path — pass, fail, or dark", () => {
    for (const value of [undefined, VALID_SLUG_SENTINEL, "*", `${VALID_SLUG_SENTINEL},*`]) {
      const env: Record<string, string> = { ...PRODUCTION_BASELINE };
      if (value !== undefined) env.NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS = value;
      const r = run(env);
      const out = r.stdout + r.stderr;
      expect(out, String(value)).not.toContain(VALID_SLUG_SENTINEL);
      // The variable NAME is expected; only values are forbidden.
      expect(out).toContain("NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS");
    }
  });

  // ---- CODEX P2 (#637): DUPLICATES COLLAPSE, EXACTLY AS THE RUNTIME DOES ----
  //
  // The gate first counted the split array while parseWaitlistSlugs() builds a
  // SET, so "studio-a, Studio-A" enabled ONE studio at runtime and was reported
  // as TWO at deploy time. The two normalisers agreed on WHICH studios activate
  // and disagreed on HOW MANY — the count an operator reads to decide whether
  // the config is what they meant.
  const DUP_A = "studio-alpha-must-never-be-printed";
  const DUP_A_MIXED_CASE = "Studio-Alpha-Must-Never-Be-Printed";
  const DUP_B = "studio-beta-must-never-be-printed";

  it("counts UNIQUE normalised slugs: the same slug in two cases is ONE studio", () => {
    const r = run({
      ...PRODUCTION_BASELINE,
      NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS: `${DUP_A}, ${DUP_A_MIXED_CASE}`,
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const out = r.stdout + r.stderr;
    expect(out).toMatch(/explicitly enables 1 studio\(s\)/);
    // The operator typed more than they enabled: said plainly, as counts only.
    expect(out).toMatch(/2 entries supplied; 1 duplicate normalised away/);
    expect(out).not.toContain(DUP_A);
    expect(out).not.toContain(DUP_A_MIXED_CASE);
  });

  it("collapses a longer duplicate run to one studio", () => {
    const r = run({
      ...PRODUCTION_BASELINE,
      NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS: `${DUP_A}, ${DUP_A}, ${DUP_A_MIXED_CASE}`,
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/explicitly enables 1 studio\(s\)/);
    expect(r.stdout).toMatch(/3 entries supplied; 2 duplicate normalised away/);
  });

  it("says nothing about duplicates when there are none", () => {
    const r = run({
      ...PRODUCTION_BASELINE,
      NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS: `${DUP_A}, ${DUP_B}`,
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/explicitly enables 2 studio\(s\)/);
    expect(r.stdout).not.toMatch(/duplicate/);
  });

  // THE ORDERING PROPERTY. Validity is decided per TYPED entry, before any
  // collapsing, so a repeated valid slug can never absorb a malformed one.
  it("a duplicate CANNOT hide an invalid entry between its copies", () => {
    const r = run({
      ...PRODUCTION_BASELINE,
      NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS: `${DUP_A}, bad slug, ${DUP_A}`,
    });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    const out = r.stdout + r.stderr;
    expect(out).toMatch(/FAIL stage-b-durable-waitlist-env/);
    // Counted over SUPPLIED entries — 1 bad of the 3 typed, not of the 1 unique.
    expect(out).toMatch(/has 1 of 3 entries that cannot be a studio slug/);
    expect(out).not.toContain(DUP_A);
    expect(out).not.toContain("bad slug");
  });

  // ---- off-production is untouched -----------------------------------------
  it("does NOT fail a PREVIEW deploy, even with an unusable allowlist", () => {
    // Preview and the e2e lane legitimately set the reserved slug; neither is
    // a production deploy and neither is validated here.
    const r = run({
      VERCEL_ENV: "preview",
      NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS: UNUSABLE_SENTINEL,
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout + r.stderr).not.toMatch(/FAIL stage-b-durable-waitlist-env/);
  });

  it("does NOT fail a LOCAL/CI build with the allowlist populated", () => {
    const r = run({
      NODE_ENV: "production",
      NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS: DURABLE_SLUG_SENTINEL,
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout + r.stderr).not.toMatch(/FAIL stage-b-durable-waitlist-env/);
  });

  it("is INDEPENDENT of the other gates in both directions", () => {
    // An unusable allowlist fails even when everything else is correct...
    const onlyWaitlist = run({
      ...PRODUCTION_BASELINE,
      NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS: UNUSABLE_SENTINEL,
    });
    expect(onlyWaitlist.status).toBe(1);
    expect(onlyWaitlist.stdout).toMatch(/^PASS public-rate-limit-env/m);
    expect(onlyWaitlist.stdout).toMatch(/^PASS ops-alert-delivery-env/m);

    // ...and a VALID activation does not rescue a build that is broken
    // elsewhere. Upstash missing, allowlist well-formed.
    const onlyUpstash = run({
      VERCEL_ENV: "production",
      OPS_ALERT_EMAILS: OPS_EMAIL_SENTINEL,
      NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS: VALID_SLUG_SENTINEL,
    });
    expect(onlyUpstash.status).toBe(1);
    expect(onlyUpstash.stdout + onlyUpstash.stderr).toMatch(/FAIL public-rate-limit-env/);
    expect(onlyUpstash.stdout).toMatch(/^PASS stage-b-durable-waitlist-env/m);
    expect(onlyUpstash.stdout + onlyUpstash.stderr).not.toContain(VALID_SLUG_SENTINEL);
  });
});

// ===========================================================================
// NORMALISATION PARITY: THE BUILD-TIME GATE vs THE RUNTIME
// ===========================================================================
//
// The parser is duplicated on purpose — the gate is a dependency-free build
// script with no module graph, and its own contract test forbids an import. A
// duplicated parser is only safe while something proves the copies agree, and
// Codex P2 (#637) is what happens when nothing does: they agreed on WHICH
// studios activate and disagreed on HOW MANY.
//
// This drives BOTH for the same env value and compares the answers. It is a
// behavioural comparison, not a source comparison: the gate is only reachable
// as a process, and what must match is the answer, not the syntax.
describe("gate and runtime normalise the allowlist identically", () => {
  const A = "studio-alpha-parity";
  const B = "studio-beta-parity";

  /** How many studios the GATE reports for this value, via its PASS line. */
  function gateEnabledCount(value: string): number {
    const r = run({
      ...PRODUCTION_BASELINE,
      NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS: value,
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    if (/names no studio/.test(r.stdout)) return 0;
    const m = r.stdout.match(/explicitly enables (\d+) studio\(s\)/);
    expect(m, r.stdout).toBeTruthy();
    return Number((m as RegExpMatchArray)[1]);
  }

  /** How many DISTINCT studios the RUNTIME actually enables for that value. */
  function runtimeEnabledCount(value: string, candidates: string[]): number {
    const original = process.env[NEW_CLIENT_WAITLIST_DURABLE_SLUGS_ENV];
    process.env[NEW_CLIENT_WAITLIST_DURABLE_SLUGS_ENV] = value;
    try {
      return candidates.filter((slug) => isNewClientWaitlistDurableEnabled(slug))
        .length;
    } finally {
      if (original === undefined) delete process.env[NEW_CLIENT_WAITLIST_DURABLE_SLUGS_ENV];
      else process.env[NEW_CLIENT_WAITLIST_DURABLE_SLUGS_ENV] = original;
    }
  }

  it.each([
    ["the P2 case: same slug, two cases", `${A}, ${A.toUpperCase()}`, [A, B], 1],
    ["a longer duplicate run", `${A}, ${A}, ${A.toUpperCase()}`, [A, B], 1],
    ["two genuinely distinct studios", `${A}, ${B}`, [A, B], 2],
    ["padding and stray separators", ` ${A} , , ${B} ,`, [A, B], 2],
    ["mixed case with padding, duplicated", `  ${A.toUpperCase()}  ,${A}`, [A, B], 1],
    ["empty", "", [A, B], 0],
    ["comma and whitespace only", " , ,  , ", [A, B], 0],
  ])("agrees on %s", (_label, value, candidates, expected) => {
    const gate = gateEnabledCount(value as string);
    const runtime = runtimeEnabledCount(value as string, candidates as string[]);
    expect(gate, `gate count for ${JSON.stringify(value)}`).toBe(expected);
    expect(runtime, `runtime count for ${JSON.stringify(value)}`).toBe(expected);
    expect(gate).toBe(runtime);
  });

  it("agrees that no unlisted studio is enabled (no global enable crept in)", () => {
    expect(runtimeEnabledCount(`${A}, ${A.toUpperCase()}`, ["some-other-studio"])).toBe(0);
  });
});

describe("check-production-env-gates contract is pinned in source", () => {
  it("keys production on VERCEL_ENV, NOT NODE_ENV", () => {
    expect(SCRIPT_SOURCE).toMatch(/VERCEL_ENV\s*===\s*"production"/);
    // next build sets NODE_ENV=production everywhere; using it as the
    // trigger would break local/CI builds. Must not be the trigger.
    expect(SCRIPT_SOURCE).not.toMatch(/NODE_ENV\s*===\s*["']production["']/);
  });

  it("requires both Upstash vars by name", () => {
    expect(SCRIPT_SOURCE).toContain("UPSTASH_REDIS_REST_URL");
    expect(SCRIPT_SOURCE).toContain("UPSTASH_REDIS_REST_TOKEN");
  });

  it("has NO fail-open bypass env (a bypass would re-enable the silent prod fail-open)", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/process\.env\.\w*(BYPASS|ALLOW)\w*/i);
  });

  it("requires OPS_ALERT_EMAILS by name with its own gate label (PR #291)", () => {
    expect(SCRIPT_SOURCE).toContain("OPS_ALERT_EMAILS");
    expect(SCRIPT_SOURCE).toMatch(/ops-alert-delivery-env/);
    // Mirrors the runtime parser (split/trim/filter) so whitespace/comma-only fails.
    expect(SCRIPT_SOURCE).toMatch(/opsAlertRecipientCount/);
  });

  it("does NOT send email or add an external alert provider (env-presence gate only)", () => {
    // No real send: the gate reads presence only, never imports Resend/email or fetches.
    expect(SCRIPT_SOURCE).not.toMatch(/resend|nodemailer|sendEmail|fetch\(|import\s+/i);
    // No new external alert provider env (Slack / PagerDuty / OpsGenie / webhook URL).
    expect(SCRIPT_SOURCE).not.toMatch(/SLACK|PAGERDUTY|OPSGENIE|WEBHOOK_URL|DISCORD/i);
  });

  it("names the durable waitlist var and gives it its own gate label", () => {
    expect(SCRIPT_SOURCE).toContain("NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS");
    expect(SCRIPT_SOURCE).toMatch(/stage-b-durable-waitlist-env/);
    // Normalisation mirrors the runtime parser, so whitespace/comma-only is dark.
    expect(SCRIPT_SOURCE).toMatch(/durableWaitlistActivation/);
    // The Stage-A blanket prohibition is GONE, not renamed alongside the new one.
    expect(SCRIPT_SOURCE).not.toMatch(/stage-a-durable-waitlist-env/);
  });

  it("the activation guard is PRODUCTION-ONLY and has NO per-studio exception", () => {
    // It lives inside main(), after the production early-return, so it cannot
    // fire off-production. And no studio may be carved out of it by name.
    const afterGuard = SCRIPT_SOURCE.slice(SCRIPT_SOURCE.indexOf("function main()"));
    expect(afterGuard).toContain("stage-b-durable-waitlist-env");
    expect(SCRIPT_SOURCE.toLowerCase()).not.toContain("willow");
  });

  it("mirrors the ONE studio-slug shape the application enforces on write", () => {
    // Three copies of this literal exist: the two places a slug is WRITTEN and
    // this build-time check, which has no module graph to share one through.
    // Pin them to each other so the mirror cannot drift.
    const slugRe = (src: string) =>
      src.match(/\/\^\[a-z0-9\]\(\?:\[a-z0-9-\]\{0,62\}\[a-z0-9\]\)\?\$\//)?.[0];
    const gate = slugRe(SCRIPT_SOURCE);
    expect(gate, "gate must carry the slug shape").toBeTruthy();
    for (const rel of [
      "app/(app)/settings/booking/actions.ts",
      "lib/studios/new-studio.ts",
    ]) {
      const src = readFileSync(path.resolve(REPO_ROOT, rel), "utf8");
      expect(slugRe(src), `${rel} must define the same SLUG_RE`).toBe(gate);
    }
  });

  // CODEX P2 (#637). The regression shape was `enabled: entries.length` on the
  // split array; the runtime's parseWaitlistSlugs() returns a Set. Pinned at
  // the source as well as behaviourally, so the defect has a name here.
  it("counts UNIQUE slugs the way the runtime does — a Set, not an array length", () => {
    expect(SCRIPT_SOURCE).toMatch(/const enabled = new Set\(\)/);
    expect(SCRIPT_SOURCE).toMatch(/enabled: enabled\.size/);
    expect(SCRIPT_SOURCE).not.toMatch(/enabled: \w+\.length/);
    // ...and validity is still decided per SUPPLIED entry, before collapsing.
    expect(SCRIPT_SOURCE).toMatch(/for \(const entry of supplied\)/);
    expect(SCRIPT_SOURCE).toMatch(/supplied: supplied\.length/);
  });

  it("has NO escape hatch for the activation guard specifically", () => {
    // The file-wide BYPASS/ALLOW pin above covers process.env.X_BYPASS forms;
    // this closes the shapes that pin would miss for this feature.
    expect(SCRIPT_SOURCE).not.toMatch(/SKIP_WAITLIST|WAITLIST_BYPASS|ALLOW_DURABLE|FORCE_DURABLE/i);
    // Exactly one place decides. No second predicate, and no second call
    // site that could branch differently: the declaration plus the one gate.
    expect(
      [...SCRIPT_SOURCE.matchAll(/durableWaitlistActivation\(\)/g)],
    ).toHaveLength(2);
  });

  it("does NOT touch Stripe / live-payment gates", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/STRIPE|paymentIntents|charges\.|refunds\.|checkout\.sessions|LIVE_MODE/i);
  });
});
