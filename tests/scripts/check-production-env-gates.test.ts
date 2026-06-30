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

  it("does NOT touch Stripe / live-payment gates", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/STRIPE|paymentIntents|charges\.|refunds\.|checkout\.sessions|LIVE_MODE/i);
  });
});
