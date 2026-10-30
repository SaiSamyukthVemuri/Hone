import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFakeResendTransport,
  fakeResendLedgerPath,
} from "@/lib/email/e2e-fake-resend";

// SCH-001. The fake transport's capture ledger: recipient and subject only,
// written before the outcome is decided, gated exactly like the transport.

const env = (o: Record<string, string>): NodeJS.ProcessEnv => o as unknown as NodeJS.ProcessEnv;

let dir: string;
let file: string;
const saved = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "hone-resend-ledger-test-"));
  file = path.join(dir, "ledger.jsonl");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

function arm(extra: Record<string, string> = {}) {
  process.env.HONE_E2E_FAKE_RESEND = "1";
  process.env.HONE_E2E_FAKE_RESEND_LEDGER = file;
  for (const [k, v] of Object.entries(extra)) process.env[k] = v;
  for (const signal of ["VERCEL", "VERCEL_ENV", "AWS_REGION", "AWS_EXECUTION_ENV", "KUBERNETES_SERVICE_HOST"]) delete process.env[signal];
}

const lines = () =>
  existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

const PAYLOAD = (to: string) => ({ from: "Hone <hello@hone.care>", to, subject: "New booking BK-1", html: "<p>SECRET-BODY</p>", text: "SECRET-BODY" });

describe("fakeResendLedgerPath gate", () => {
  it("is null unless the fake marker AND a ledger path are both set", () => {
    expect(fakeResendLedgerPath(env({ HONE_E2E_FAKE_RESEND_LEDGER: file }))).toBeNull();
    expect(fakeResendLedgerPath(env({ HONE_E2E_FAKE_RESEND: "1" }))).toBeNull();
    expect(fakeResendLedgerPath(env({ HONE_E2E_FAKE_RESEND: "1", HONE_E2E_FAKE_RESEND_LEDGER: file }))).toBe(file);
  });
  it("refuses a deployed runtime", () => {
    for (const signal of [{ VERCEL: "1" }, { VERCEL_ENV: "preview" }, { AWS_REGION: "x" }, { KUBERNETES_SERVICE_HOST: "x" }] as Record<string, string>[]) {
      expect(fakeResendLedgerPath(env({ HONE_E2E_FAKE_RESEND: "1", HONE_E2E_FAKE_RESEND_LEDGER: file, ...signal }))).toBeNull();
    }
  });
  it("refuses a path outside the temp dirs, a non-.jsonl path, and a traversal", () => {
    const base = { HONE_E2E_FAKE_RESEND: "1" };
    expect(fakeResendLedgerPath(env({ ...base, HONE_E2E_FAKE_RESEND_LEDGER: "/etc/ledger.jsonl" }))).toBeNull();
    expect(fakeResendLedgerPath(env({ ...base, HONE_E2E_FAKE_RESEND_LEDGER: path.join(dir, "ledger.txt") }))).toBeNull();
    expect(fakeResendLedgerPath(env({ ...base, HONE_E2E_FAKE_RESEND_LEDGER: `${dir}/../../etc/x.jsonl` }))).toBeNull();
    expect(fakeResendLedgerPath(env({ ...base, HONE_E2E_FAKE_RESEND_LEDGER: "relative/ledger.jsonl" }))).toBeNull();
  });
});

describe("the fake transport records who was emailed", () => {
  it("appends one {t,pid,mode,to,subject} line per send, for every outcome, before the outcome", async () => {
    arm();
    const t = createFakeResendTransport();
    await t.emails.send(PAYLOAD("success+a@harness.local"));
    await t.emails.send(PAYLOAD("reject+b@harness.local"));
    await expect(t.emails.send(PAYLOAD("throw+c@harness.local"))).rejects.toThrow();
    const rows = lines();
    expect(rows.map((r) => [r.to, r.mode])).toEqual([
      ["success+a@harness.local", "success"],
      ["reject+b@harness.local", "reject"],
      ["throw+c@harness.local", "throw"],
    ]);
    expect(Object.keys(rows[0]).sort()).toEqual(["mode", "pid", "subject", "t", "to"]);
    expect(rows[0].subject).toBe("New booking BK-1");
    expect(rows[0].pid).toBe(process.pid);
  });

  it("never persists a message body or attachment", async () => {
    arm();
    await createFakeResendTransport().emails.send({ ...PAYLOAD("x@harness.local"), attachments: [{ filename: "a.ics", content: Buffer.from("SECRET-ICS") }] });
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain("SECRET-BODY");
    expect(raw).not.toContain("SECRET-ICS");
    expect(raw).not.toContain("<p>");
  });

  it("writes nothing when the ledger is not armed, and a write failure never changes the send", async () => {
    process.env.HONE_E2E_FAKE_RESEND = "1";
    delete process.env.HONE_E2E_FAKE_RESEND_LEDGER;
    await createFakeResendTransport().emails.send(PAYLOAD("x@harness.local"));
    expect(existsSync(file)).toBe(false);
    // A ledger path whose parent is a regular FILE cannot be created: the send still succeeds.
    writeFileSync(path.join(dir, "blocker"), "x");
    arm({ HONE_E2E_FAKE_RESEND_LEDGER: path.join(dir, "blocker", "x.jsonl") });
    const result = await createFakeResendTransport().emails.send(PAYLOAD("success+z@harness.local"));
    expect(result.error).toBeNull();
    expect(existsSync(path.join(dir, "blocker", "x.jsonl"))).toBe(false);
  });

  it("is mode-neutral: the recorded mode is the one the recipient asked for", async () => {
    arm({ HONE_E2E_FAKE_RESEND_DEFAULT_MODE: "reject" });
    await createFakeResendTransport().emails.send(PAYLOAD("nobody-asked@harness.local"));
    expect(lines()[0].mode).toBe("reject");
  });
});
