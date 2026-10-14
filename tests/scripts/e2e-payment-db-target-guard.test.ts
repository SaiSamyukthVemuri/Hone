import { readdirSync, readFileSync } from "node:fs";
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

// PAY-CCY-09 (Codex P2 4265382406, 4265382410). The operator replay tool reads a
// TWIN's database on its own port, so it must not load the fixture's seed guard
// (which pins local-env's) — and it may only do that because it seeds nothing.
describe("the read-only webhook replay tool", () => {
  const src = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");
  const code = (rel: string) => src(rel).replace(/^\s*\/\/.*$/gm, "");
  const TOOL = "e2e-payment/fake-stripe-webhook-replay.tool.spec.ts";
  const HELPER = "e2e-payment/helpers/fake-stripe-webhook.ts";
  const CONFIG = "e2e-payment/replay-tool.playwright.config.ts";

  it("neither the tool nor the webhook helper loads the fixture's seed guard", () => {
    for (const f of [TOOL, HELPER]) {
      expect(code(f)).not.toMatch(/payment-fixture/);
      expect(code(f)).toMatch(/from "(\.\.\/)+tests\/db\/helpers\/harness"/);
    }
  });

  it("the tool seeds, cleans up and writes nothing", () => {
    expect(code(TOOL)).not.toMatch(/\bseed[A-Z]|cleanup|bindFakeStripeAccount/);
    expect(code(TOOL)).not.toMatch(/\b(insert|update|delete)\b/i);
  });

  it("every SEEDING payment spec still imports the guarded fixture", () => {
    const specs = readdirSync(path.join(process.cwd(), "e2e-payment"))
      .filter((f) => f.endsWith(".spec.ts"))
      .map((f) => `e2e-payment/${f}`);
    const seeding = specs.filter((f) => /\bseed[A-Z]\w*\(|cleanupPaymentScenario/.test(code(f)));
    expect(seeding.length).toBeGreaterThan(0);
    for (const f of seeding) expect(code(f), f).toMatch(/helpers\/payment-fixture"/);
  });

  it("has its own config with NO webServer, and refuses any other config", () => {
    expect(code(CONFIG)).not.toMatch(/webServer|globalSetup/);
    expect(code(CONFIG)).toMatch(/process\.env\.HONE_E2E_REPLAY_TOOL_CONFIG = "1"/);
    expect(code(CONFIG)).toMatch(/testMatch: \/fake-stripe-webhook-replay\\\.tool\\\.spec\\\.ts\$\//);
    expect(code(TOOL)).toMatch(/HONE_E2E_REPLAY_TOOL_CONFIG !== "1"/);
  });

  it("cannot pass on a no-op: unknown events fail, and a delivered refund event must reconcile", () => {
    // Codex P2 4265594526: no silent zero-delivery run.
    expect(code(TOOL)).toMatch(/KNOWN_EVENTS = new Set\(\["succeeded", "refunded"\]\)/);
    expect(code(TOOL)).toMatch(/builders\.length === 0/);
    // Codex P2 4265724221: acknowledged-but-ignored charge.refunded is a failure,
    // checked BEFORE the replays compare state to itself.
    const tool = code(TOOL);
    const reconcile = tool.indexOf('refund_status: "succeeded"');
    expect(reconcile).toBeGreaterThan(tool.indexOf("const settled = await state(attemptId)"));
    expect(reconcile).toBeLessThan(tool.indexOf("const after = await state(attemptId)"));
    expect(tool).toMatch(/stripe_refund_id: processor\.id/);
  });

  it("requires every target explicitly: no fallback to the shared stack or the lane's port", () => {
    for (const k of ["HONE_E2E_RUN_ID", "HONE_LOCAL_DB_URL", "HONE_E2E_WEBHOOK_ORIGIN", "HONE_E2E_WEBHOOK_SECRET"]) {
      expect(code(TOOL)).toContain(`"${k}"`);
    }
  });
});
