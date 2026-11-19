import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// The HON-80 device matrix is a separate config that only re-selects projects. These pin that it cannot change isolation or turn the switch on.
const cfg = readFileSync("playwright.charting.config.ts", "utf8");
const spec = readFileSync("e2e/charting-new-view.spec.ts", "utf8");

describe("playwright.charting.config.ts", () => {
  it("extends the ordinary config, so global setup, the app server and its guards are the same ones", () => {
    expect(cfg).toMatch(/import base from "\.\/playwright\.config"/);
    expect(cfg).toMatch(/\.\.\.base,/);
    expect(cfg).not.toMatch(/webServer|globalSetup|globalTeardown|baseURL|reuseExistingServer/);
  });
  it("only ever selects the charting spec, once per device", () => {
    const matches = [...cfg.matchAll(/testMatch: MATCH/g)].length;
    expect(matches).toBe(6);
    expect(cfg).toMatch(/const MATCH = \/charting-new-view\\\.spec\\\.ts\$\//);
  });
  it("covers desktop, iPhone and Android portrait, iPad both ways, and WebKit only when opted in", () => {
    for (const n of ["desktop-chromium", "iphone-portrait", "android-portrait", "ipad-portrait", "ipad-landscape", "webkit-charting"]) expect(cfg).toContain(`name: "${n}"`);
    expect(cfg).toMatch(/HONE_E2E_WEBKIT === "1"[\s\S]*webkit-charting/);
  });
  it("never sets the rollout setting itself", () => {
    expect(cfg.replace(/\/\/.*$/gm, "")).not.toMatch(/HONE_CHARTING_NEW_VIEW_STUDIO_IDS/);
  });
});

describe("e2e/charting-new-view.spec.ts", () => {
  it("is skipped unless the local server was started with the rollout setting set to all", () => {
    expect(spec).toMatch(/test\.skip\(process\.env\.HONE_CHARTING_NEW_VIEW_STUDIO_IDS !== "all"/);
  });
  it("uses only the local synthetic seed and reaches no hosted or provider endpoint", () => {
    expect(spec).toMatch(/seedE2eStudio\(\)/);
    expect(spec).not.toMatch(/https?:\/\/(?!localhost|127\.0\.0\.1)/);
    expect(spec).not.toMatch(/supabase\.co|stripe\.com|vercel\.app/);
  });
  it("the payment-lane spec is opt-in the same way and reaches no real provider", () => {
    const pay = readFileSync("e2e-payment/charting-new-view-payment.spec.ts", "utf8");
    expect(pay).toMatch(/test\.skip\(process\.env\.HONE_CHARTING_NEW_VIEW_STUDIO_IDS !== "all"/);
    expect(pay).toMatch(/api\\\.stripe\\\.com/);
    expect(pay).toMatch(/configureFakeStripeOutcome/);
    expect(pay).not.toMatch(/supabase\.co|vercel\.app|sk_live|pk_live/);
  });
  it("proves the rollout setting reached the server instead of skipping silently", () => {
    expect(spec).toMatch(/the switch must exist: start the app server with HONE_CHARTING_NEW_VIEW_STUDIO_IDS=all/);
  });
});

// Loading a Playwright config imports e2e/helpers/local-env.ts, which REFUSES a non-local Supabase URL. A CI job's environment legitimately carries one, and
// the guard must stay strict, so the child that only LISTS tests gets an environment with every Supabase, database and e2e origin override (and any Stripe live
// switch) removed: the guard then falls back to its own local defaults.
const DROPPED = /^(NEXT_PUBLIC_SUPABASE_.*|SUPABASE_.*|E2E_.*|HONE_LOCAL_DB_URL|STRIPE_SECRET_KEY|STRIPE_ALLOW_LIVE_MODE)$/;
export function listEnv(base: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(base).filter(([k]) => !DROPPED.test(k)));
}

describe("playwright.charting-payment.config.ts selects only the charting payment spec", () => {
  const listed = (webkit: "0" | "1") => {
    const out = execFileSync("npx", ["playwright", "test", "--config", "playwright.charting-payment.config.ts", "--list", "--reporter=json"], {
      encoding: "utf8",
      env: { ...listEnv(), HONE_E2E_WEBKIT: webkit },
      maxBuffer: 64 * 1024 * 1024,
    });
    const files = new Set<string>();
    const projects = new Set<string>();
    let tests = 0;
    const walk = (suite: { file?: string; suites?: unknown[]; specs?: { file: string; tests: { projectName: string }[] }[] }) => {
      for (const sp of suite.specs ?? []) {
        files.add(sp.file);
        for (const t of sp.tests) {
          tests += 1;
          projects.add(t.projectName);
        }
      }
      for (const c of (suite.suites ?? []) as (typeof suite)[]) walk(c);
    };
    for (const s of JSON.parse(out).suites) walk(s);
    return { files: [...files], projects: [...projects].sort(), tests };
  };
  it("without WebKit: only the charting payment spec, in one project", () => {
    const r = listed("0");
    expect(r.files).toEqual(["charting-new-view-payment.spec.ts"]);
    expect(r.projects).toEqual(["chromium-charting-payment"]);
    expect(r.tests).toBe(3);
  }, 30_000);
  it("with HONE_E2E_WEBKIT=1: still only the charting payment spec (no inherited quick-checkout project or grep)", () => {
    const r = listed("1");
    expect(r.files).toEqual(["charting-new-view-payment.spec.ts"]);
    expect(r.projects).toEqual(["chromium-charting-payment", "webkit-charting-payment"]);
    expect(r.tests).toBe(6);
  }, 30_000);
});

describe("the child environment of the --list cases", () => {
  it("carries no Supabase, database or e2e origin override, whatever the parent has", () => {
    const hostile = { PATH: "/usr/bin", NEXT_PUBLIC_SUPABASE_URL: "https://x.example", SUPABASE_DB_URL: "postgres://x", E2E_SUPABASE_URL: "https://x.example", HONE_LOCAL_DB_URL: "postgres://x", SUPABASE_SERVICE_ROLE_KEY: "k", STRIPE_SECRET_KEY: "sk_live_x" };
    const env = listEnv(hostile);
    expect(Object.keys(env)).toEqual(["PATH"]);
    expect(Object.values(listEnv()).join("\n")).not.toMatch(/supabase\.co/);
  });
});
