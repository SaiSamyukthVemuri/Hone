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
// is gone and this gate is REPORT-ONLY for the durable allowlist: it describes
// the value and cannot fail a build over it.
//
// (A later draft did hard-fail on anything outside the current writer slug
// shape. That was withdrawn: the shape is what today's WRITERS enforce, not the
// domain of studios.slug, which has a UNIQUE constraint and no shape or length
// check — so the gate was stricter than the runtime and would have blocked a
// legitimate activation.)
//
// What must remain true, and is asserted below:
//
//   * unset / empty / whitespace / comma-only  -> zero studios, PASS, dark.
//     This is the state Stage B1 ships to production, and the ONE studio-level
//     claim this script can actually prove — an empty
//     set makes membership false for every slug, with no database needed.
//   * an explicitly named slug                 -> PASS, reported as CONFIGURED
//     NORMALISED ENTRIES. Activation is now possible without a code release,
//     but this script never proves it happened.
//   * anything outside the writer convention   -> WARN, build still succeeds.
//     Never FAIL, and never a claim that no studio matches.
//   * no slug value, of any shape, ever reaches stdout/stderr.
//   * off-production is untouched.
const VALID_SLUG_SENTINEL = "willowlike-studio-must-never-be-printed";
// Held as NAMED CONSTANTS, never inlined at the assignment site. A repository
// guard in tests/app/book/new-client-waitlist-durable-commit.test.ts scans every
// file that names this variable for a string-literal assignment to it, and the
// only one that may exist anywhere is the reserved e2e slug. Test fixtures must
// not weaken that scan by adding literals it has to be taught to ignore.
const PADDED_MIXED_CASE_SENTINEL = "  Willowlike-Studio-UPPER  ";
const UNCONVENTIONAL_SENTINEL = "*";

/**
 * Claims the gate has no evidence for, in EITHER direction.
 *
 * It has no database access and never reads NEW_CLIENT_WAITLIST_STUDIO_SLUGS,
 * so it can say neither that an entry identifies a studio nor that it does not.
 * The first three are the activation over-claim; the last three are its mirror
 * image — asserting non-existence from a shape the database does not enforce.
 */
const BANNED_GATE_CLAIMS = [
  /\benables \d+ studio/i,
  /\bexplicitly enables\b/i,
  /\b\d+ studios? (?:are |is )?(?:now )?(?:enabled|active|activated)\b/i,
  /\bmatched by exact slug equality\b/i,
  /\beach named in full\b/i,
  /\bcannot be a studio slug\b/i,
  /\bmatches no studio\b/i,
  /\bidentifies no studio\b/i,
];

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
    expect(out).toMatch(/carries 1 distinct normalised configuration entry\b/);
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
    expect(out).toMatch(/carries 2 distinct normalised configuration entries/);
    expect(out).not.toContain(VALID_SLUG_SENTINEL);
    expect(out).not.toContain(DURABLE_SLUG_SENTINEL_2);
  });

  // -------------------------------------------------------------------------
  // CODEX (#637). The PASS line said the allowlist "explicitly enables N
  // studio(s) ... each named in full and matched by exact slug equality". This
  // script has NO DATABASE ACCESS. Two facts stand between a well-shaped entry
  // and an activated studio, and it can decide NEITHER:
  //
  //   1. EXISTENCE — "studio-that-never-existed" is perfectly slug-shaped and
  //      names nothing; only a query against studios.slug could tell.
  //   2. ADMISSION — the durable list is subordinate to
  //      NEW_CLIENT_WAITLIST_STUDIO_SLUGS, which this script never reads, so a
  //      real studio named here whose intake gate is off activates nothing.
  //
  // So the number is an UPPER BOUND on activation. Reporting it as studios
  // enabled asserted both facts on evidence the script does not have — the same
  // over-claim, one layer down, that this PR removes from the privacy notice.
  // -------------------------------------------------------------------------
  it("reports CONFIGURED ENTRIES and states plainly that it proves no activation", () => {
    const r = run({
      ...PRODUCTION_BASELINE,
      NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS: `${VALID_SLUG_SENTINEL}, ${DURABLE_SLUG_SENTINEL_2}`,
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const out = r.stdout + r.stderr;
    // Counts ENTRIES, and says so in the units it actually measured.
    expect(out).toMatch(/carries 2 distinct normalised configuration entries/);
    // Names the missing evidence for BOTH unprovable facts, not just one.
    expect(out).toMatch(/no database access/i);
    expect(out).toMatch(/does not\s+prove any entry identifies a studio/);
    expect(out).toContain("NEW_CLIENT_WAITLIST_STUDIO_SLUGS");
    expect(out).toMatch(/cannot tell whether a named studio.s new-client intake is waitlisted/);
    // States the number's real meaning: a ceiling, not a result.
    expect(out).toMatch(/the MOST studios this value could activate/);
    expect(out).toMatch(/not as a\s+count of studios activated/);
  });

  it("NEGATIVE CONTROL: the PASS line may never claim studios are enabled", () => {
    // Across every populated shape, including the ones whose wording is
    // assembled separately (single, plural, duplicate-collapsed).
    for (const value of [
      VALID_SLUG_SENTINEL,
      `${VALID_SLUG_SENTINEL}, ${DURABLE_SLUG_SENTINEL_2}`,
      `${VALID_SLUG_SENTINEL}, ${VALID_SLUG_SENTINEL.toUpperCase()}`,
    ]) {
      const r = run({
        ...PRODUCTION_BASELINE,
        NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS: value,
      });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      const out = r.stdout + r.stderr;
      for (const banned of BANNED_GATE_CLAIMS) {
        expect(out, `must not claim activation: ${banned}`).not.toMatch(banned);
      }
    }
  });

  // Proof 7. The same three phrasings must be absent on EVERY path, including
  // the warning ones — an unconventional entry is exactly where the old code
  // asserted "cannot be a studio slug" and "matches no studio", neither of
  // which this script has the evidence to say.
  it("NEGATIVE CONTROL: no path asserts existence in either direction", () => {
    const long = "a".repeat(65);
    for (const value of [
      undefined,
      "",
      " , , ",
      VALID_SLUG_SENTINEL,
      `${VALID_SLUG_SENTINEL}, ${DURABLE_SLUG_SENTINEL_2}`,
      UNCONVENTIONAL_SENTINEL,
      long,
      `${VALID_SLUG_SENTINEL}, ${UNCONVENTIONAL_SENTINEL}`,
    ]) {
      const env: Record<string, string> = { ...PRODUCTION_BASELINE };
      if (value !== undefined) env.NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS = value;
      const r = run(env);
      expect(r.status, `${value}: ${r.stdout}${r.stderr}`).toBe(0);
      const out = r.stdout + r.stderr;
      for (const banned of BANNED_GATE_CLAIMS) {
        expect(out, `${JSON.stringify(value)} must not say: ${banned}`).not.toMatch(banned);
      }
    }
  });

  // The DARK line is the one place a studio-level claim IS proven: an empty set
  // makes slugIsListed() false for every slug that could ever exist, with no
  // database needed. It must keep saying so — weakening it to "no entries"
  // would give away a guarantee the script genuinely holds.
  it("still makes the PROVEN studio-level claim on the dark path", () => {
    const r = run(PRODUCTION_BASELINE);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/names no studio/);
    expect(r.stdout).toMatch(/stays dark/);
    expect(r.stdout).toMatch(/every studio\s+remains on the WAIT-01 commit point/);
    // No shape-only caveat here: there is nothing unproven to caveat.
    expect(r.stdout).not.toMatch(/CONFIG SHAPE ONLY/);
  });

  it("normalises case and padding exactly as the runtime does, and still passes", () => {
    const r = run({
      ...PRODUCTION_BASELINE,
      NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS: PADDED_MIXED_CASE_SENTINEL,
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/carries 1 distinct normalised configuration entry\b/);
  });

  // ---- unconventional activation config: WARN, never FAIL -----------------
  //
  // CODEX (#637) P2-B. An earlier draft FAILED the build on anything outside
  // the 1–64 lowercase-alnum-hyphen shape, calling it "unusable" and claiming
  // it "matches no studio". That shape is what TODAY'S WRITERS enforce, not the
  // domain of `studios.slug`: migration 0010 adds `slug text` plus a UNIQUE
  // constraint and NO shape or length check, and its name-based backfill
  // appends a 7-character id suffix without truncating. A legacy, backfilled or
  // directly-created row can therefore hold a 65-character slug that
  // slugIsListed() matches exactly — and the gate would have aborted that
  // studio's activation while telling the operator the entry identified none.
  //
  // A build gate must never be STRICTER than the runtime it guards. The shape
  // check survives as a non-blocking WARNING that asserts nothing about
  // existence.
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
  ])("WARNS but does NOT fail a production build on %s", (_label, value) => {
    const r = run({
      ...PRODUCTION_BASELINE,
      NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS: value,
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const out = r.stdout + r.stderr;
    expect(out).toMatch(/^WARN stage-b-durable-waitlist-env/m);
    expect(out).not.toMatch(/FAIL stage-b-durable-waitlist-env/);
    expect(out).toContain("NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS");
    // Not even a WARNED entry is printed: it is still a studio identifier.
    expect(out).not.toContain(value);
    // The warning must not decide existence in EITHER direction.
    expect(out).not.toMatch(/matches no studio|cannot be a studio slug|identifies no studio/i);
  });

  // THE CONCRETE REPRODUCTION Codex gave. Length alone must never block.
  it("a 65-character lowercase slug does NOT fail the build", () => {
    const long = "a".repeat(65);
    const r = run({
      ...PRODUCTION_BASELINE,
      NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS: long,
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const out = r.stdout + r.stderr;
    // It still counts as configured — the runtime would put it in its Set.
    expect(out).toMatch(/carries 1 distinct normalised configuration entry\b/);
    expect(out).toMatch(/^WARN stage-b-durable-waitlist-env/m);
    expect(out).toMatch(/no shape or length check/);
    expect(out).not.toContain(long);
  });

  it("WARNS on a partly-unconventional list without failing, counting over supplied", () => {
    const r = run({
      ...PRODUCTION_BASELINE,
      NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS: `${VALID_SLUG_SENTINEL}, not a slug`,
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const out = r.stdout + r.stderr;
    expect(out).toMatch(/1 of 2 configured entries falls outside the slug convention/);
    expect(out).not.toContain(VALID_SLUG_SENTINEL);
    expect(out).not.toContain("not a slug");
  });

  it("never prints a slug on ANY path — pass, warn, or dark", () => {
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
    expect(out).toMatch(/carries 1 distinct normalised configuration entry\b/);
    // The operator typed more than survives normalisation: said plainly, as
    // counts only.
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
    expect(r.stdout).toMatch(/carries 1 distinct normalised configuration entry\b/);
    expect(r.stdout).toMatch(/3 entries supplied; 2 duplicate normalised away/);
  });

  it("says nothing about duplicates when there are none", () => {
    const r = run({
      ...PRODUCTION_BASELINE,
      NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS: `${DUP_A}, ${DUP_B}`,
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/carries 2 distinct normalised configuration entries/);
    expect(r.stdout).not.toMatch(/duplicate/);
  });

  // THE ORDERING PROPERTY. The convention signal is computed per TYPED entry,
  // before any collapsing, so a repeated conventional slug can never absorb an
  // unconventional neighbour and silence the warning.
  it("a duplicate CANNOT hide an unconventional entry between its copies", () => {
    const r = run({
      ...PRODUCTION_BASELINE,
      NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS: `${DUP_A}, bad slug, ${DUP_A}`,
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const out = r.stdout + r.stderr;
    // Counted over SUPPLIED entries — 1 of the 3 typed, not of the 2 unique.
    expect(out).toMatch(/1 of 3 configured entries falls outside the slug convention/);
    expect(out).not.toContain(DUP_A);
    expect(out).not.toContain("bad slug");
  });

  // ---- off-production is untouched -----------------------------------------
  it("does NOT fail a PREVIEW deploy, even with an unconventional allowlist", () => {
    // Preview and the e2e lane legitimately set the reserved slug; neither is
    // a production deploy and neither is validated here.
    const r = run({
      VERCEL_ENV: "preview",
      NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS: UNCONVENTIONAL_SENTINEL,
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
    // An unconventional allowlist WARNS without disturbing anything else, and
    // without failing the build — the durable gate is report-only now.
    const onlyWaitlist = run({
      ...PRODUCTION_BASELINE,
      NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS: UNCONVENTIONAL_SENTINEL,
    });
    expect(onlyWaitlist.status, onlyWaitlist.stdout + onlyWaitlist.stderr).toBe(0);
    expect(onlyWaitlist.stdout).toMatch(/^WARN stage-b-durable-waitlist-env/m);
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

  /** How many entries the GATE reports for this value, via its PASS line. */
  function gateConfiguredCount(value: string): number {
    const r = run({
      ...PRODUCTION_BASELINE,
      NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS: value,
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    if (/names no studio/.test(r.stdout)) return 0;
    const m = r.stdout.match(/carries (\d+) distinct normalised configuration entr(?:y|ies)/);
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
    const gate = gateConfiguredCount(value as string);
    const runtime = runtimeEnabledCount(value as string, candidates as string[]);
    expect(gate, `gate count for ${JSON.stringify(value)}`).toBe(expected);
    expect(runtime, `runtime count for ${JSON.stringify(value)}`).toBe(expected);
    expect(gate).toBe(runtime);
  });

  it("agrees that no unlisted studio is enabled (no global enable crept in)", () => {
    expect(runtimeEnabledCount(`${A}, ${A.toUpperCase()}`, ["some-other-studio"])).toBe(0);
  });

  // Proof 6, EXTENDED FOR P2-B. The old gate filtered unconventional entries
  // out of its count while parseWaitlistSlugs() kept them, so the two parsers
  // disagreed on exactly the inputs the gate then failed the build over. Now
  // every non-empty entry is configured in both, and parity holds there too.
  it.each([
    ["a wildcard-looking literal", "*", ["*", A], 1],
    ["a 65-character slug", "a".repeat(65), ["a".repeat(65), A], 1],
    ["an unconventional entry beside a conventional one", `*, ${A}`, ["*", A], 2],
  ])("agrees on %s, which the gate no longer filters out", (_label, value, candidates, expected) => {
    const gate = gateConfiguredCount(value as string);
    const runtime = runtimeEnabledCount(value as string, candidates as string[]);
    expect(gate, `gate count for ${JSON.stringify(value)}`).toBe(expected);
    expect(runtime, `runtime count for ${JSON.stringify(value)}`).toBe(expected);
    expect(gate).toBe(runtime);
  });

  // Proof 5. A wildcard-looking value is a LITERAL string on both sides. It
  // must never behave as a pattern, and there is no global-enable mode.
  it("a wildcard-looking value enables only a studio literally named that", () => {
    // It matches the literal, and nothing else — not even one other studio.
    expect(runtimeEnabledCount("*", ["*"])).toBe(1);
    expect(runtimeEnabledCount("*", [A, B, "willow-electrolysis"])).toBe(0);
    expect(runtimeEnabledCount("%", [A, B])).toBe(0);
    expect(runtimeEnabledCount(".*", [A, B])).toBe(0);
    // And no value is read as "every studio".
    for (const global of ["*", "all", "true", "1", "ALL", "%"]) {
      expect(runtimeEnabledCount(global, [A, B]), `${global} must enable nobody`).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// THE GATE 4 CONTRACT, PINNED VERBATIM
// ---------------------------------------------------------------------------
//
// These eight sentences are authored in the GATE 4 CONTRACT block of
// scripts/check-production-env-gates.mjs and are what an operator relies on.
// Six review rounds showed that prose describing this gate drifts silently
// while the behaviour below stays correct, so the sentences are pinned as
// TEXT and the behaviour is proved separately by the executable suites above.
//
// This deliberately does NOT try to recognise a false paraphrase. Earlier
// attempts to detect wrong sentences were unsound in both directions — they
// missed "the gate is, in every production build, enforced" and flagged the
// truthful "the report does not, under any circumstances, block activation".
// Rewriting a pinned sentence simply fails, and a human decides.
// ---------------------------------------------------------------------------
describe("GATE 4 CONTRACT is stated verbatim in the script", () => {
  const CONTRACT: Record<string, string> = {
    "1 role": "Gate 4 is report-only.",
    "2 failure authority":
      "It does not fail the build solely because of\n *      NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS.",
    "3 existence limit":
      "The report does not prove a configured entry names an existing studio.",
    "4 activation limit": "The report does not prove that a studio is activated.",
    "5 runtime authority": "Runtime exact-membership is the activation control.",
    "6 wildcard law":
      "Configured values are literal; there is no wildcard or global-enable\n *      interpretation.",
    "7 dark law":
      "An empty normalized durable allowlist leaves every studio on the\n *      non-durable path.",
    "8 skip law":
      "The production-only configuration report is skipped outside production,\n *      while runtime membership still applies.",
  };

  it("carries all eight sentences, verbatim, in one authored block", () => {
    expect(SCRIPT_SOURCE).toContain("GATE 4 CONTRACT");
    for (const [name, sentence] of Object.entries(CONTRACT)) {
      expect(SCRIPT_SOURCE, `contract sentence missing: ${name}`).toContain(sentence);
    }
  });

  // ANTI-VACUITY. A pin is only worth having if the behaviour it describes is
  // actually true, so each sentence is tied to the executable proof that
  // establishes it. If a pin and its proof ever disagree, the proof wins.
  it("each pinned sentence has an executable proof, and the proofs hold", () => {
    // 1, 2 — report-only: no populated value fails the build.
    for (const value of ["", " , , ", VALID_SLUG_SENTINEL, "*", "a".repeat(65)]) {
      const r = run({
        ...PRODUCTION_BASELINE,
        NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS: value,
      });
      expect(r.status, `${JSON.stringify(value)}: ${r.stdout}${r.stderr}`).toBe(0);
    }
    // 3, 4 — the report claims neither existence nor activation.
    const populated = run({
      ...PRODUCTION_BASELINE,
      NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS: VALID_SLUG_SENTINEL,
    });
    const out = populated.stdout + populated.stderr;
    expect(out).toMatch(/does not\s+prove any entry identifies a studio/);
    expect(out).toMatch(/not as a\s+count of studios activated/);
    // 7 — empty is dark, and says so.
    expect(run(PRODUCTION_BASELINE).stdout).toMatch(/names no studio/);
    // 8 — off-production the report does not run at all.
    const skipped = run({ ...PRODUCTION_BASELINE, VERCEL_ENV: "preview" });
    expect(skipped.status).toBe(0);
    expect(skipped.stdout).toMatch(/^SKIP stage-b-durable-waitlist-env/m);
    expect(skipped.stdout).not.toMatch(/^(?:PASS|WARN|FAIL) stage-b-durable-waitlist-env/m);
    // ...and says the runtime control still applies, rather than denying it.
    expect(skipped.stdout).toContain("Runtime exact-membership");
    expect(skipped.stdout).not.toContain("no check here or anywhere");
  });

  // 5, 6 are runtime properties and are proved in
  // tests/lib/booking/new-client-waitlist-flag.test.ts and in the parity block
  // above; pinned here only as the operator-facing words.
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
    expect(SCRIPT_SOURCE).toMatch(/const configured = new Set\(\)/);
    expect(SCRIPT_SOURCE).toMatch(/configured: configured\.size/);
    expect(SCRIPT_SOURCE).not.toMatch(/configured: \w+\.length/);
    // ...and the convention signal is still computed per SUPPLIED entry,
    // before collapsing.
    expect(SCRIPT_SOURCE).toMatch(/for \(const entry of supplied\)/);
    expect(SCRIPT_SOURCE).toMatch(/supplied: supplied\.length/);
    // EVERY non-empty entry is configured — no filtering, or the count would
    // stop mirroring parseWaitlistSlugs().
    expect(SCRIPT_SOURCE).toMatch(/configured\.add\(entry\);\s*\n\s*if \(!MODERN_WRITER_SLUG_RE/);
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
