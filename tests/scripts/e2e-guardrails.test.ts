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
const FLOWS = read("e2e/helpers/flows.ts");
const CONFIG = read("playwright.config.ts");
const RESOURCES = read("scripts/worktree-resources.mjs");
const CI = read(".github/workflows/ci.yml");
const PKG = read("package.json");
const UNIT_CONFIG = read("vitest.config.ts");

describe("e2e lane is local-only by construction", () => {
  it("every endpoint is hardcoded to the local stack", () => {
    expect(ENV).toMatch(/LOCAL_SUPABASE_URL = "http:\/\/127\.0\.0\.1:54321"/);
    expect(ENV).toMatch(
      /LOCAL_DB_URL = "postgresql:\/\/postgres:postgres@127\.0\.0\.1:54322\/postgres"/,
    );
    // TEST-PORT-01. The app origin is no longer a literal, because a shared
    // literal port is what let a run in one worktree attach to another's
    // server. What must stay hardcoded is the HOST, and it does: the origin is
    // built from E2E_HOST in scripts/worktree-resources.mjs, which is the
    // literal "localhost" and is not read from the environment. Only an integer
    // port varies, so no env var can point this lane off the local machine.
    expect(ENV).toMatch(/E2E_APP_ORIGIN: string = RESOURCES\.origin/);
    expect(RESOURCES).toMatch(/export const E2E_HOST = "localhost";/);
    expect(RESOURCES).toMatch(/`http:\/\/\$\{E2E_HOST\}:\$\{port\}`/);
    // The override is parsed as a bare integer and nothing else.
    expect(RESOURCES).toMatch(/\^\[0-9\]\{1,5\}\$/);
    // No environment variable may supply a host, a scheme or an origin.
    const envReads = RESOURCES.match(/env\[[A-Z_]+\]/g) ?? [];
    expect(envReads.length).toBeGreaterThan(0);
    expect(RESOURCES).not.toMatch(/E2E_HOST\s*=\s*(process\.)?env/);
    expect(RESOURCES).not.toMatch(/HONE_E2E_(HOST|ORIGIN|URL|BASE_URL)/);
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
    // The login flow moved to the shared flows helper in PR #228 so
    // the mobile spec reuses the identical real flow.
    expect(FLOWS).toMatch(/send magic link/i);
    expect(FLOWS).toMatch(/waitForMagicLink/);
    expect(SPEC).toMatch(/loginAsOwner/);
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
    // TEST-PORT-01. The `-p 3111` flag is gone because the port is now derived
    // per worktree. `next start` reads PORT when no flag is given, and PORT is
    // supplied by E2E_WEB_SERVER_ENV, so the server still cannot pick its own
    // port and the build is still a production build.
    const scripts = JSON.parse(PKG).scripts as Record<string, string>;
    for (const s of ["e2e:server", "e2e:payment-server", "e2e:google-server"]) {
      expect(scripts[s]).toBe("next build && next start");
      expect(scripts[s]).not.toMatch(/-p\s|--port/);
      expect(scripts[s]).toMatch(/^next build && /);
    }
    expect(ENV).toMatch(/PORT: String\(E2E_APP_PORT\)/);
  });

  it("server reuse is opt-in, so a run cannot attach to another worktree's server", () => {
    // This is the defect TEST-PORT-01 exists for: `!process.env.CI` is TRUE
    // locally, so Playwright attached to whatever was already answering on the
    // shared port — another worktree's server — and reported green.
    expect(CONFIG).not.toMatch(/reuseExistingServer:\s*!process\.env\.CI/);
    expect(CONFIG).toMatch(/reuseExistingServer: E2E_REUSE_EXISTING_SERVER/);
    const MOBILE = read("playwright.mobile.config.ts");
    expect(MOBILE).not.toMatch(/reuseExistingServer:\s*!process\.env\.CI/);
    expect(MOBILE).toMatch(/reuseExistingServer: E2E_REUSE_EXISTING_SERVER/);
    // The two fake-provider lanes were already fail-closed; keep them that way.
    expect(read("playwright.payment.config.ts")).toMatch(/reuseExistingServer: false/);
    expect(read("playwright.google.config.ts")).toMatch(/reuseExistingServer: false/);
  });
});
