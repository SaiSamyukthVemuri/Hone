import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

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
// WAIT-02B Stage A: a configured studio slug must never be printed either.
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
// WAIT-02B STAGE A — THE DURABLE WAITLIST KILL SWITCH
// ===========================================================================
//
// INVERTED relative to every other gate here: those fail when required config
// is MISSING, this fails when optional config is PRESENT.
//
// Stage A ships the durable new-client waitlist dark. Its table stores personal
// information for prospects the current public privacy notice does not cover,
// so "the allowlist is empty in production" is a security property. Repository
// tests and documentation cannot see the Vercel dashboard; without this gate
// one mistyped entry would activate prospect collection with nothing failing.
describe("Stage-A durable waitlist kill switch", () => {
  it("PASSES when the allowlist is UNSET in production", () => {
    const r = run(PRODUCTION_BASELINE);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^PASS stage-a-durable-waitlist-env/m);
  });

  it.each([
    ["empty string", ""],
    ["whitespace only", "   "],
    ["commas only", ",,,"],
    ["commas and whitespace", " , ,  , "],
  ])("PASSES when the allowlist is present but enables nobody (%s)", (_label, value) => {
    // Mirrors parseWaitlistSlugs(): these all mean OFF at runtime, so the gate
    // must not fail a deploy over a value that enables no studio.
    const r = run({
      ...PRODUCTION_BASELINE,
      NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS: value,
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^PASS stage-a-durable-waitlist-env/m);
  });

  it("FAILS a production build when ONE studio is configured", () => {
    const r = run({
      ...PRODUCTION_BASELINE,
      NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS: DURABLE_SLUG_SENTINEL,
    });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    const out = r.stdout + r.stderr;
    expect(out).toMatch(/FAIL stage-a-durable-waitlist-env/);
    expect(out).toContain("NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS");
    // THE VALUE MUST NEVER APPEAR.
    expect(out).not.toContain(DURABLE_SLUG_SENTINEL);
  });

  it("FAILS with MULTIPLE comma-separated studios, and prints none of them", () => {
    const r = run({
      ...PRODUCTION_BASELINE,
      NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS: `${DURABLE_SLUG_SENTINEL}, ${DURABLE_SLUG_SENTINEL_2}`,
    });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    const out = r.stdout + r.stderr;
    expect(out).toMatch(/FAIL stage-a-durable-waitlist-env/);
    // A count is fine; the slugs are not.
    expect(out).toMatch(/enables 2 studio\(s\)/);
    expect(out).not.toContain(DURABLE_SLUG_SENTINEL);
    expect(out).not.toContain(DURABLE_SLUG_SENTINEL_2);
  });

  it("does NOT fail a PREVIEW deploy with the allowlist populated", () => {
    // Preview and the e2e lane legitimately set the reserved slug.
    const r = run({
      VERCEL_ENV: "preview",
      NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS: DURABLE_SLUG_SENTINEL,
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout + r.stderr).not.toMatch(/FAIL stage-a-durable-waitlist-env/);
    expect(r.stdout + r.stderr).not.toContain(DURABLE_SLUG_SENTINEL);
  });

  it("does NOT fail a LOCAL/CI build with the allowlist populated", () => {
    const r = run({
      NODE_ENV: "production",
      NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS: DURABLE_SLUG_SENTINEL,
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout + r.stderr).not.toMatch(/FAIL stage-a-durable-waitlist-env/);
  });

  it("is INDEPENDENT of the other gates in both directions", () => {
    // A populated allowlist fails even when everything else is correct...
    const onlyWaitlist = run({
      ...PRODUCTION_BASELINE,
      NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS: DURABLE_SLUG_SENTINEL,
    });
    expect(onlyWaitlist.status).toBe(1);
    expect(onlyWaitlist.stdout).toMatch(/^PASS public-rate-limit-env/m);
    expect(onlyWaitlist.stdout).toMatch(/^PASS ops-alert-delivery-env/m);

    // ...and an empty allowlist does not rescue a build that is broken
    // elsewhere. Upstash missing, allowlist clean.
    const onlyUpstash = run({
      VERCEL_ENV: "production",
      OPS_ALERT_EMAILS: OPS_EMAIL_SENTINEL,
    });
    expect(onlyUpstash.status).toBe(1);
    expect(onlyUpstash.stdout + onlyUpstash.stderr).toMatch(/FAIL public-rate-limit-env/);
    expect(onlyUpstash.stdout).toMatch(/^PASS stage-a-durable-waitlist-env/m);
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

  it("names the Stage-A durable waitlist var and gives it its own gate label", () => {
    expect(SCRIPT_SOURCE).toContain("NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS");
    expect(SCRIPT_SOURCE).toMatch(/stage-a-durable-waitlist-env/);
    // Normalisation mirrors the runtime parser, so whitespace/comma-only PASSES.
    expect(SCRIPT_SOURCE).toMatch(/durableWaitlistStudioCount/);
  });

  it("the Stage-A gate is PRODUCTION-ONLY and has NO per-studio exception", () => {
    // It lives inside main(), after the production early-return, so it cannot
    // fire off-production. And no studio may be carved out of it by name.
    const afterGuard = SCRIPT_SOURCE.slice(SCRIPT_SOURCE.indexOf("function main()"));
    expect(afterGuard).toContain("stage-a-durable-waitlist-env");
    expect(SCRIPT_SOURCE.toLowerCase()).not.toContain("willow");
  });

  it("has NO escape hatch for the Stage-A gate specifically", () => {
    // The file-wide BYPASS/ALLOW pin above covers process.env.X_BYPASS forms;
    // this closes the shapes that pin would miss for this feature.
    expect(SCRIPT_SOURCE).not.toMatch(/SKIP_WAITLIST|WAITLIST_BYPASS|ALLOW_DURABLE|FORCE_DURABLE/i);
    // Exactly one place decides, and it is the count. No second predicate.
    expect(
      [...SCRIPT_SOURCE.matchAll(/durableWaitlistStudioCount\(\)/g)],
    ).toHaveLength(2); // the definition's own call site + the gate
  });

  it("does NOT touch Stripe / live-payment gates", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/STRIPE|paymentIntents|charges\.|refunds\.|checkout\.sessions|LIVE_MODE/i);
  });
});
