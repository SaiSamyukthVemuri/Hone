import { mkdtempSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LEDGER_BODY_MAX_CHARS,
  createFakeResendTransport,
  extractLedgerHrefs,
  isHarnessRecipient,
  fakeResendLedgerBodiesEnabled,
} from "@/lib/email/e2e-fake-resend";

// HON-7 acceptance. The ledger can additionally carry the BODIES of a fake send, behind a second explicit switch, so a browser spec can prove what
// an email says and links to. Synthetic data only.

const env = (o: Record<string, string>): NodeJS.ProcessEnv => o as unknown as NodeJS.ProcessEnv;
let dir: string;
let file: string;
const saved = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "hone-resend-bodies-test-"));
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
  for (const signal of ["VERCEL", "VERCEL_ENV", "AWS_REGION", "AWS_EXECUTION_ENV", "KUBERNETES_SERVICE_HOST"]) delete process.env[signal];
  delete process.env.HONE_E2E_FAKE_RESEND_LEDGER_BODIES;
  for (const [k, v] of Object.entries(extra)) process.env[k] = v;
}
const rows = () => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const HTML = '<p>Hello</p><a href="https://app.example.invalid/settings/waitlist?followup=1&amp;x=2">Review response</a>';
const TEXT = "Hello. Review response: https://app.example.invalid/settings/waitlist?followup=1&x=2";
const PAYLOAD = { from: "Hone <hello@hone.care>", to: "success+o@harness.local", subject: "Subject A", html: HTML, text: TEXT };

describe("the bodies switch", () => {
  it("is off unless the fake marker, a valid ledger path AND the bodies switch are all present", () => {
    const base = { HONE_E2E_FAKE_RESEND: "1", HONE_E2E_FAKE_RESEND_LEDGER: file };
    expect(fakeResendLedgerBodiesEnabled(env({ ...base }))).toBe(false);
    expect(fakeResendLedgerBodiesEnabled(env({ ...base, HONE_E2E_FAKE_RESEND_LEDGER_BODIES: "true" }))).toBe(false);
    expect(fakeResendLedgerBodiesEnabled(env({ ...base, HONE_E2E_FAKE_RESEND_LEDGER_BODIES: "1" }))).toBe(true);
    expect(fakeResendLedgerBodiesEnabled(env({ HONE_E2E_FAKE_RESEND_LEDGER_BODIES: "1", HONE_E2E_FAKE_RESEND_LEDGER: file }))).toBe(false);
    expect(fakeResendLedgerBodiesEnabled(env({ HONE_E2E_FAKE_RESEND: "1", HONE_E2E_FAKE_RESEND_LEDGER_BODIES: "1" }))).toBe(false);
  });
  it("is refused in a deployed runtime even with every switch set", () => {
    for (const signal of [{ VERCEL: "1" }, { VERCEL_ENV: "production" }, { AWS_REGION: "x" }, { KUBERNETES_SERVICE_HOST: "x" }] as Record<string, string>[]) {
      expect(fakeResendLedgerBodiesEnabled(env({ HONE_E2E_FAKE_RESEND: "1", HONE_E2E_FAKE_RESEND_LEDGER: file, HONE_E2E_FAKE_RESEND_LEDGER_BODIES: "1", ...signal }))).toBe(false);
    }
  });
});

describe("what the fake writes", () => {
  it("with the bodies switch OFF a line is exactly {t, pid, mode, to, subject}: no body, no hash, no link", async () => {
    arm();
    await createFakeResendTransport().emails.send(PAYLOAD);
    expect(Object.keys(rows()[0]).sort()).toEqual(["mode", "pid", "subject", "t", "to"]);
    expect(readFileSync(file, "utf8").includes("Review response")).toBe(false);
  });

  it("with the switch ON and a harness recipient it adds text, html, the link targets and a sha256 of each full body (asserted by marker and hash, never by printing a body)", async () => {
    arm({ HONE_E2E_FAKE_RESEND_LEDGER_BODIES: "1" });
    await createFakeResendTransport().emails.send(PAYLOAD);
    const r = rows()[0];
    expect(sha(r.text)).toBe(sha(TEXT));
    expect(sha(r.html)).toBe(sha(HTML));
    expect(String(r.html).includes("Review response")).toBe(true);
    expect(r.text_sha256).toBe(sha(TEXT));
    expect(r.html_sha256).toBe(sha(HTML));
    expect(r.hrefs).toEqual(["https://app.example.invalid/settings/waitlist?followup=1&x=2"]);
    expect(r.subject).toBe("Subject A");
  });

  it("truncates a long body but hashes the FULL one, and still records a refused send", async () => {
    arm({ HONE_E2E_FAKE_RESEND_LEDGER_BODIES: "1" });
    const long = "x".repeat(LEDGER_BODY_MAX_CHARS + 500);
    await createFakeResendTransport().emails.send({ ...PAYLOAD, to: "reject+o@harness.local", html: long });
    const r = rows()[0];
    expect(String(r.html).length).toBe(LEDGER_BODY_MAX_CHARS);
    expect(r.html_sha256).toBe(sha(long));
    expect(r.mode).toBe("reject");
  });

  it("writes nothing at all when the ledger is not armed, whatever the bodies switch says", async () => {
    process.env.HONE_E2E_FAKE_RESEND = "1";
    delete process.env.HONE_E2E_FAKE_RESEND_LEDGER;
    process.env.HONE_E2E_FAKE_RESEND_LEDGER_BODIES = "1";
    await createFakeResendTransport().emails.send(PAYLOAD);
    expect(existsSync(file)).toBe(false);
  });
});

describe("bodies are stored for harness recipients only", () => {
  it("a recipient off @harness.local gets the hashes ONLY: no text, no html, no hrefs", async () => {
    arm({ HONE_E2E_FAKE_RESEND_LEDGER_BODIES: "1" });
    await createFakeResendTransport().emails.send({ ...PAYLOAD, to: "someone@example.invalid" });
    const r = rows()[0];
    expect("text" in r || "html" in r || "hrefs" in r).toBe(false);
    expect(r.text_sha256).toBe(sha(TEXT));
    expect(r.html_sha256).toBe(sha(HTML));
    expect(readFileSync(file, "utf8").includes("app.example.invalid")).toBe(false);
    expect(readFileSync(file, "utf8").includes("Review response")).toBe(false);
  });
  it.each([
    "real@x.com,someone@harness.local",
    "someone@harness.local;real@x.com",
    "someone@harness.local real@x.com",
    "Real <real@x.com>",
    "<someone@harness.local>",
    " someone@harness.local",
    "someone@harness.local\n",
    "a@b@harness.local",
  ])("%j is not a single exact harness address: hashes only", async (to) => {
    expect(isHarnessRecipient(to)).toBe(false);
    arm({ HONE_E2E_FAKE_RESEND_LEDGER_BODIES: "1" });
    await createFakeResendTransport().emails.send({ ...PAYLOAD, to });
    const r = rows()[0];
    expect("text" in r || "html" in r || "hrefs" in r).toBe(false);
    expect(r.html_sha256).toBe(sha(HTML));
  });
  it("a non-string or array recipient is never a harness recipient", () => {
    for (const v of [["someone@harness.local"], null, undefined, 7, { toString: () => "a@harness.local" }]) expect(isHarnessRecipient(v)).toBe(false);
  });
  it("recognises the harness domain exactly", () => {
    expect(isHarnessRecipient("success+a@harness.local")).toBe(true);
    expect(isHarnessRecipient("a@harness.local.evil.example")).toBe(false);
    expect(isHarnessRecipient("A+tag@HARNESS.LOCAL")).toBe(true);
    expect(isHarnessRecipient("a@notharness.local")).toBe(false);
  });
});

describe("the ledger is private to the user", () => {
  it("creates the directory 0700 and the file 0600", async () => {
    const nested = path.join(dir, "hone-e2e-resend-private");
    process.env.HONE_E2E_FAKE_RESEND = "1";
    process.env.HONE_E2E_FAKE_RESEND_LEDGER = path.join(nested, "l.jsonl");
    await createFakeResendTransport().emails.send(PAYLOAD);
    expect((statSync(nested).mode & 0o777).toString(8)).toBe("700");
    expect((statSync(path.join(nested, "l.jsonl")).mode & 0o777).toString(8)).toBe("600");
  });
});

describe("extractLedgerHrefs", () => {
  it("finds attribute hrefs and bare urls once each, in first-seen order", () => {
    expect(extractLedgerHrefs('<a href="https://a.example.invalid/x">x</a><a href=\'https://b.example.invalid/\'>y</a>', "see https://a.example.invalid/x and https://c.example.invalid/z")).toEqual([
      "https://a.example.invalid/x",
      "https://b.example.invalid/",
      "https://c.example.invalid/z",
    ]);
  });
});

// A TRIPWIRE, not a proof: it reads source text for names of the new switch and fields. It says nothing about behaviour. Assertions are booleans so a failure never prints a source file.
describe("tripwire: the real Resend path does not mention the body capture", () => {
  const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
  it("nothing outside the fake module mentions the bodies switch or the new ledger fields", () => {
    for (const p of ["lib/email/client.ts", "lib/email/send-appointment.ts", "lib/email/send-welcome.ts", "lib/email/new-client-waitlist-send.ts"]) {
      const src = read(p);
      expect(["LEDGER_BODIES", "text_sha256", "extractLedgerHrefs"].some((marker) => src.includes(marker)), p).toBe(false);
    }
  });
  it("the body capture sits only inside the fake transport, behind the helper that checks the gate", () => {
    const src = read("lib/email/e2e-fake-resend.ts");
    expect(src.includes('import "server-only"')).toBe(true);
    const fake = src.slice(src.indexOf("export function createFakeResendTransport"));
    expect(fake.includes("fakeResendLedgerBodiesEnabled()")).toBe(true);
  });
});
