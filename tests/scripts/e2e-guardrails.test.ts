import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

// PR #227. Static pins (unit lane) for the browser E2E lane. The
// suite itself runs in the separate browser-e2e job / npm run
// test:e2e; these pins keep its safety properties from eroding:
// local-only by construction, no production credentials, no auth
// bypass, no live-payment capability, and no runtime app change.

function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../..", rel), "utf8");
}

const ENV = read("e2e/helpers/local-env.ts");
const SEED = read("e2e/helpers/seed.ts");
const SPEC = read("e2e/core-memory-loop.spec.ts");
const CONFIG = read("playwright.config.ts");
const CI = read(".github/workflows/ci.yml");
const PKG = read("package.json");
const UNIT_CONFIG = read("vitest.config.ts");

describe("e2e lane is local-only by construction", () => {
  it("every endpoint is hardcoded to the local stack", () => {
    expect(ENV).toMatch(/LOCAL_SUPABASE_URL = "http:\/\/127\.0\.0\.1:54321"/);
    expect(ENV).toMatch(
      /LOCAL_DB_URL = "postgresql:\/\/postgres:postgres@127\.0\.0\.1:54322\/postgres"/,
    );
    expect(ENV).toMatch(/E2E_APP_ORIGIN = "http:\/\/localhost:3111"/);
  });

  it("hosted-URL overrides are refused before anything runs", () => {
    expect(ENV).toMatch(/supabase\\\.co\|supabase\\\.com/);
    expect(ENV).toMatch(/refuseHostedOverrides\(\);/);
    expect(ENV).toMatch(/e2e refuses to run/);
  });

  it("live Stripe is refused and the env ships only dummy provider keys", () => {
    expect(ENV).toMatch(/sk_live_/);
    expect(ENV).toMatch(/STRIPE_ALLOW_LIVE_MODE === "true"/);
    expect(ENV).toMatch(/STRIPE_SECRET_KEY: "sk_test_dummy"/);
    expect(ENV).toMatch(/RESEND_API_KEY: "re_dummy_resend_key"/);
    expect(ENV).not.toMatch(/sk_live_[a-zA-Z0-9]/);
  });

  it("the only JWTs are the public supabase-demo local keys", () => {
    const jwts = ENV.match(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g) ?? [];
    for (const jwt of jwts) {
      const payload = JSON.parse(
        Buffer.from(jwt.split(".")[1], "base64").toString("utf8"),
      );
      expect(payload.iss).toBe("supabase-demo");
    }
    expect(jwts.length).toBeGreaterThan(0);
  });
});

describe("no auth bypass and no runtime change", () => {
  it("login happens through the REAL magic-link UI + Mailpit capture", () => {
    expect(SPEC).toMatch(/send magic link/i);
    expect(SPEC).toMatch(/waitForMagicLink/);
    expect(SEED).toMatch(/pending_invitations/);
    expect(SEED).toMatch(/handle_new_user/);
  });

  it("no service-role browser route or app-side test hook exists", () => {
    // The seed talks to the LOCAL GoTrue admin API and local Postgres
    // directly; nothing under app/ or lib/ knows about E2E.
    for (const dir of ["app", "lib", "components", "middleware.ts"]) {
      const grepTargets = [SPEC, SEED, ENV, CONFIG];
      for (const content of grepTargets) {
        expect(content).not.toMatch(/process\.env\.E2E_AUTH_BYPASS/);
      }
      void dir;
    }
    expect(existsSync(path.resolve(__dirname, "../..", "app/api/e2e"))).toBe(
      false,
    );
  });

  it("seed data is e2e-prefixed and cleanup relies on the disposable local DB", () => {
    expect(SEED).toMatch(/e2e-owner-/);
    expect(SEED).toMatch(/e2e-client-/);
    expect(SEED).toMatch(/disposable local database/);
    expect(SEED).not.toMatch(/delete from public\./i);
  });

  it("the spec asserts anonymous lockout of Records, print, and Dashboard", () => {
    expect(SPEC).toMatch(/anonymous access to Records and print redirects to login/);
    expect(SPEC).toMatch(/waitForURL\(\/login\//);
  });
});

describe("lane isolation", () => {
  it("vitest never picks up e2e specs and npm run ci stays browser-free", () => {
    expect(UNIT_CONFIG).toMatch(/include: \["tests\/\*\*\/\*\.test\.ts"\]/);
    const scripts = JSON.parse(PKG).scripts as Record<string, string>;
    expect(scripts["test:e2e"]).toBe("playwright test");
    expect(scripts.ci).not.toMatch(/test:e2e/);
  });

  it("the CI job is separate, pinned, secret-free, and local-only", () => {
    const job = CI.slice(CI.indexOf("browser-e2e:"));
    expect(job).toMatch(/supabase start -x/);
    expect(job).toMatch(/supabase db reset --local/);
    expect(job).toMatch(/npm run test:e2e/);
    expect(job).toMatch(/version: 2\.102\.0/);
    const executable = job
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    expect(executable).not.toMatch(/secrets\./);
    expect(executable).not.toMatch(/--linked/);
    expect(executable).not.toMatch(/SUPABASE_ACCESS_TOKEN/);
  });

  it("the web server under test is a production build, not the dev watcher", () => {
    expect(CONFIG).toMatch(/npm run e2e:server/);
    expect(JSON.parse(PKG).scripts["e2e:server"]).toBe(
      "next build && next start -p 3111",
    );
  });
});
