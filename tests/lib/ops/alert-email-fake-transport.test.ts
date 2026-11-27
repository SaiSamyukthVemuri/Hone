import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
// The durable row is out of scope here (a DB test owns it): a writer that accepts the insert, so the email path after it runs for real.
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({ from: () => ({ insert: async () => ({ error: null }) }) }),
}));

// HON-127. The critical-alert operator email goes through the lane's fake email transport, so CI can prove it without RESEND_BASE_URL. This test
// uses the REAL lib/email/client (no mock) with the fake armed: nothing leaves the machine, and a send is observed through the capture ledger.

const DEPLOY_SIGNALS = ["VERCEL", "VERCEL_ENV", "AWS_REGION", "AWS_EXECUTION_ENV", "KUBERNETES_SERVICE_HOST"];
let dir: string;
let file: string;
const saved = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  dir = mkdtempSync(path.join(os.tmpdir(), "hone-ops-alert-fake-"));
  file = path.join(dir, "ledger.jsonl");
  for (const k of DEPLOY_SIGNALS) delete process.env[k];
  delete process.env.RESEND_API_KEY;
  process.env.HONE_E2E_FAKE_RESEND = "1";
  process.env.HONE_E2E_FAKE_RESEND_LEDGER = file;
  process.env.HONE_E2E_FAKE_RESEND_LEDGER_BODIES = "1";
  process.env.OPS_ALERT_EMAILS = "ops@harness.local";
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  vi.restoreAllMocks();
});

const ledger = () =>
  existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

const CLIENT_DATA = {
  clientEmail: "jane.doe@client-example.test",
  uuid: "6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5",
  paymentIntent: "pi_3AbCdEfGhIjKlMnO",
};

describe("critical ops alert email through the fake transport", () => {
  it("sends exactly ONE fake email, to the operator list only, with no client data", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { recordOpsAlert } = await import("@/lib/ops/alerts");
    await recordOpsAlert({
      severity: "critical",
      event: "session_payment_succeeded_write_zero_rows",
      message: `Charge failed for ${CLIENT_DATA.clientEmail} client ${CLIENT_DATA.uuid} ${CLIENT_DATA.paymentIntent} amount $145.00`,
      studioId: "11111111-2222-4333-8444-555555555555",
      clientId: CLIENT_DATA.uuid,
      stripePaymentIntentId: CLIENT_DATA.paymentIntent,
    });

    const rows = ledger();
    expect(rows).toHaveLength(1);
    // Recipient class: the operator list from OPS_ALERT_EMAILS, never a studio or client address.
    expect(rows[0].to).toEqual(["ops@harness.local"]);
    expect(rows[0].subject).toBe("[Hone CRITICAL] session_payment_succeeded_write_zero_rows");
    expect(rows[0].mode).toBe("success");
    // The recipient is a list, so the ledger keeps only hashes, never the body (nothing to leak onto disk).
    expect(rows[0].text).toBeUndefined();
    expect(rows[0].text_sha256).toMatch(/^[0-9a-f]{64}$/);
    const raw = readFileSync(file, "utf8");
    for (const secret of [CLIENT_DATA.clientEmail, CLIENT_DATA.uuid, CLIENT_DATA.paymentIntent, "11111111-2222-4333-8444-555555555555"]) {
      expect(raw).not.toContain(secret);
    }
  });

  it("the email BODY carries no client data (inspected through the fake transport itself)", async () => {
    const seen: Array<{ to: unknown; text: string }> = [];
    const mod = await import("@/lib/email/e2e-fake-resend");
    const real = mod.createFakeResendTransport();
    const client = await import("@/lib/email/client");
    vi.spyOn(client, "getResendTransport").mockImplementation(() => ({
      emails: {
        send: async (a) => {
          seen.push({ to: a.to, text: a.text });
          return real.emails.send(a);
        },
      },
    }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { recordOpsAlert } = await import("@/lib/ops/alerts");
    await recordOpsAlert({
      severity: "critical",
      event: "session_payment_succeeded_write_zero_rows",
      message: `Charge failed for ${CLIENT_DATA.clientEmail} client ${CLIENT_DATA.uuid} ${CLIENT_DATA.paymentIntent}`,
      studioId: "11111111-2222-4333-8444-555555555555",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.to).toEqual(["ops@harness.local"]);
    for (const secret of [CLIENT_DATA.clientEmail, CLIENT_DATA.uuid, CLIENT_DATA.paymentIntent]) {
      expect(seen[0]!.text).not.toContain(secret);
    }
    expect(seen[0]!.text).toContain("Record and payment details are on the alert itself");
  });

  it("a list with ANY non-harness address never reaches the ledger in plaintext (only hashes)", async () => {
    process.env.OPS_ALERT_EMAILS = "ops@harness.local, real.operator@example.com";
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { recordOpsAlert } = await import("@/lib/ops/alerts");
    await recordOpsAlert({ severity: "critical", event: "x_event", message: "m" });
    const rows = ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0].to).toHaveLength(2);
    for (const a of rows[0].to) expect(a).toMatch(/^sha256:[0-9a-f]{12}$/);
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain("real.operator");
    expect(raw).not.toContain("example.com");
    // not even the harness address of a MIXED list is kept: the rule is all-or-nothing
    expect(raw).not.toContain("ops@harness.local");
  });

  it("CONTROL: a list of ONLY harness addresses is stored in plaintext (the hashing is the non-harness rule, not a broken ledger)", async () => {
    process.env.OPS_ALERT_EMAILS = "ops@harness.local,second@harness.local";
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { recordOpsAlert } = await import("@/lib/ops/alerts");
    await recordOpsAlert({ severity: "critical", event: "x_event", message: "m" });
    expect(ledger()[0].to).toEqual(["ops@harness.local", "second@harness.local"]);
  });

  it("CONTROL: with the fake NOT armed and no Resend key, nothing is sent (the lane flag is what routes it)", async () => {
    delete process.env.HONE_E2E_FAKE_RESEND;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { recordOpsAlert } = await import("@/lib/ops/alerts");
    await recordOpsAlert({ severity: "critical", event: "x_event", message: "m" });
    expect(ledger()).toHaveLength(0);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("ops_alert_email_disabled_no_resend_key"))).toBe(true);
  });

  it("a deployed runtime never uses the fake, even with the flag set", async () => {
    process.env.VERCEL_ENV = "preview";
    const { isE2eFakeResendEnabled } = await import("@/lib/email/e2e-fake-resend");
    expect(isE2eFakeResendEnabled()).toBe(false);
  });
});
