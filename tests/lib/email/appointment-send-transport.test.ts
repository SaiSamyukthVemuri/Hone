import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FAKE_MESSAGE_ID } from "@/lib/email/e2e-fake-resend";
import { sendEmailSafely } from "@/lib/email/send-appointment";

// ===========================================================================
// RESCHEDULE-E2E-01 — the appointment send path resolves a FAKEABLE transport.
// ===========================================================================
//
// THE DEFECT THIS PINS. `sendEmailSafely` imported the raw `resend` client from
// lib/email/client.ts instead of calling `getResendTransport()`. The onboarding
// path already used the resolver, so a fake transport existed and worked — but
// every appointment email, including the public-reschedule confirmation, went
// around it and reached the real Resend SDK. Under the E2E lane that meant a
// live HTTPS request to api.resend.com carrying `re_dummy_resend_key`, and
// `e2e/public-reschedule-v2.spec.ts` asserted the failure copy that the
// provider's rejection happened to produce. When that external behaviour
// changed, the same tree began failing with no code change.
//
// These tests exercise the REAL resolver, not a mocked module: the only thing
// stubbed is the server-only marker the fake itself reads. A mock of
// `@/lib/email/client` could pass while the real path reached a different
// transport, which is exactly how the bypass survived.

const BASE = { subject: "s", html: "<p>h</p>", text: "t" };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the fake transport decides the outcome, per recipient", () => {
  it("accepts an ordinary recipient and reports the provider message id", async () => {
    vi.stubEnv("HONE_E2E_FAKE_RESEND", "1");
    const result = await sendEmailSafely({ ...BASE, to: "client@harness.local" });
    expect(result.ok).toBe(true);
    // Proves the send actually went through the fake rather than succeeding
    // for some other reason: only the fake returns this id.
    expect(result.ok && result.messageId).toBe(FAKE_MESSAGE_ID);
  });

  it("a `reject+` recipient is REFUSED, terminally, with the provider message", async () => {
    vi.stubEnv("HONE_E2E_FAKE_RESEND", "1");
    const result = await sendEmailSafely({
      ...BASE,
      to: "reject+abc@harness.local",
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/fake resend rejected/i);
    // TERMINAL, not retryable. Exact-head #793 P2: the fake's error envelope
    // used to carry only `message`, so `classifyResendError` fell through to
    // its unfamiliar-shape default and a "refusal" was classified as a
    // transient blip -- which meant B7 exercised the retry path, not the
    // terminal-refusal bookkeeping, and the final-failure ops alert was never
    // reached. The envelope now carries what the classifier reads.
    expect(result.ok === false && result.retryable).toBe(false);
  });

  it("a `throw+` recipient surfaces a provider EXCEPTION, not a silent success", async () => {
    vi.stubEnv("HONE_E2E_FAKE_RESEND", "1");
    const result = await sendEmailSafely({
      ...BASE,
      to: "throw+abc@harness.local",
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/network exception/i);
    // A thrown network error IS retryable, and must stay distinguishable from
    // the terminal refusal above -- otherwise one fake mode could stand in for
    // the other and neither branch would be proven.
    expect(result.ok === false && result.retryable).toBe(true);
  });

  it("the refusal is NOT an artifact of the recipient being invalid", async () => {
    // Non-vacuity: the same address shape with no mode prefix succeeds, so the
    // refusal above comes from the mode and not from recipient validation.
    vi.stubEnv("HONE_E2E_FAKE_RESEND", "1");
    const ok = await sendEmailSafely({ ...BASE, to: "plain+abc@harness.local" });
    expect(ok.ok).toBe(true);
  });
});

describe("production behaviour is unchanged", () => {
  // THESE TWO MUST CONTROL THEIR OWN ENVIRONMENT, and an earlier revision did
  // not. `lib/email/client.ts` reads RESEND_API_KEY at MODULE LOAD, so
  // `vi.stubEnv` after the static import above came too late: on a machine with
  // no key these passed, and in CI -- which has one -- `resend` was a real
  // client, the "unconfigured" assertion saw "API key is invalid" instead, and
  // the test had made a LIVE request to the provider. A test whose verdict
  // depends on ambient environment is the very thing this PR removes, so these
  // reset the module registry and import with the environment already set.
  const freshSend = async (env: Record<string, string>, to: string) => {
    vi.resetModules();
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const mod = await import("@/lib/email/send-appointment");
    return mod.sendEmailSafely({ ...BASE, to });
  };

  it("with the fake marker ABSENT and no API key, the send is refused as unconfigured", async () => {
    // The guard this path has always had: `getResendTransport()` returns the
    // real client, which is null without RESEND_API_KEY. No network call, and
    // the same terminal result the raw-`resend` guard used to produce.
    const result = await freshSend(
      { HONE_E2E_FAKE_RESEND: "", RESEND_API_KEY: "" },
      "client@example.com",
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/not configured/i);
  });

  it("a deployed runtime signal makes the fake marker REFUSE AT IMPORT", async () => {
    // Stronger than checking a send result: `client.ts` calls
    // `assertFakeResendNotRequestedInDeployment()` at module scope, so a leaked
    // marker in a deployed runtime does not degrade quietly -- the module
    // refuses to load at all. Nothing can send fake mail from production.
    vi.resetModules();
    vi.stubEnv("HONE_E2E_FAKE_RESEND", "1");
    vi.stubEnv("VERCEL", "1");
    await expect(import("@/lib/email/send-appointment")).rejects.toThrow(
      /must never be set in a deployed environment/i,
    );
  });
});

describe("the bypass cannot return", () => {
  const source = readFileSync(
    path.resolve(__dirname, "../../../lib/email/send-appointment.ts"),
    "utf8",
  );

  it("resolves the transport and never imports the raw `resend` client", () => {
    expect(source).toMatch(/getResendTransport/);
    // The import list must not pull `resend` back in. Matched on the import
    // statement specifically, so the explanatory comment that NAMES the retired
    // export cannot satisfy or defeat this.
    const importLine = /import\s*\{([^}]*)\}\s*from\s*"@\/lib\/email\/client"/.exec(
      source,
    );
    expect(importLine, "the client import could not be located").toBeTruthy();
    expect(importLine![1]).not.toMatch(/(^|[\s,])resend([\s,]|$)/);
  });

  it("sends through the resolved transport, not a module-level client", () => {
    expect(source).toMatch(/transport\.emails\.send\(/);
    expect(source).not.toMatch(/\bresend\.emails\.send\(/);
  });
});
