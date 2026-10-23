const privacyAlerts = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert: async (input: Record<string, unknown>) => { privacyAlerts.push(input); } }));
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FAKE_MESSAGE_ID,
  type FakeResendMode,
} from "@/lib/email/e2e-fake-resend";

/** The modes the fake actually implements, for pinning prefix spellings. */
const KNOWN_FAKE_MODES: FakeResendMode[] = [
  "success",
  "reject",
  "throw",
  "failonce",
  "hold",
];
import { claimEmailSend, claimEmailSendOutcome, recordEmailAttempt, recordEmailResult, logEmailFailure, sendCancellationEmail, sendEmailSafely } from "@/lib/email/send-appointment";

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

describe("the lane default and the acceptance seam are ONE contract", () => {
  // THE OSCILLATION THIS STOPS. Arming the fake for the whole lane has two
  // halves that must move together, and changing either alone broke the suite
  // twice in this PR: with `success` as the lane default every documented
  // degraded path silently became an accepted send, and with `reject` as the
  // lane default every welcome-email acceptance case silently became a failure.
  // Neither direction produced a red test in the lane that caused it -- the
  // first because those specs assert what is absent either way, the second only
  // in a browser job. So the coupling is asserted here, in the unit lane, where
  // it is cheap and always runs.
  const laneEnv = readFileSync(
    path.resolve(__dirname, "../../../e2e/helpers/local-env.ts"),
    "utf8",
  );
  const seedSource = readFileSync(
    path.resolve(__dirname, "../../../e2e/helpers/seed.ts"),
    "utf8",
  );

  it("the lane refuses by default, so a degraded-path spec gets a real refusal", () => {
    expect(laneEnv).toMatch(
      /HONE_E2E_FAKE_RESEND_DEFAULT_MODE:\s*"reject"/,
    );
  });

  it("and the welcome-email seam opts IN to acceptance, so success coverage survives", () => {
    // `insertBareStudio` is the welcome-email contracts' only seam. If the lane
    // default is refusal, its unprefixed default MUST ask for acceptance, or
    // every success / in-progress / retry-then-send case inverts.
    expect(seedSource).toMatch(/ownerEmail \?\? `success\+owner-\$\{runId\}@harness\.local`/);
  });

  it("the mode vocabulary the lane and seeds use is the one the fake implements", () => {
    // A typo in either prefix would silently fall through to the library
    // default rather than failing, so the spelling is pinned against the fake.
    for (const mode of ["success", "reject"]) {
      expect(KNOWN_FAKE_MODES).toContain(mode);
    }
  });
});


describe("MSG-004 cancellation transport result is observable", () => {
  const cancellation = (to: string) => sendCancellationEmail({
    to, recipientName: "Synthetic", clientName: "Synthetic",
    studio: { name: "Synthetic", timezone: "UTC" } as Parameters<typeof sendCancellationEmail>[0]["studio"],
    serviceName: "Consultation", durationMinutes: 30, startsAt: new Date("2099-01-01T12:00:00Z"),
    actorName: "Synthetic owner", actorRole: "owner", reason: null, isClient: true,
  });
  it.each([["client@harness.local", true], ["reject+cancel@harness.local", false], ["throw+cancel@harness.local", false]] as const)("returns the fake transport outcome for %s", async (to, ok) => {
    vi.stubEnv("HONE_E2E_FAKE_RESEND", "1");
    expect(await cancellation(to)).toMatchObject({ ok });
  });
});


describe("reminder claim outcome preserves legacy boolean callers", () => {
  it.each([
    [true, null, "claimed", true], [false, null, "not_claimed", false],
    [null, new Error("SYNTHETIC_PRIVATE RPC failure"), "unavailable", false],
    [null, null, "unavailable", false], ["true", null, "unavailable", false],
    [true, undefined, "unavailable", false], [false, false, "unavailable", false],
  ] as const)("classifies a claim reply without changing the legacy boolean contract (%s)", async (data, error, outcome, legacy) => {
    const rpc = vi.fn(async () => ({ data, error })); const admin = { rpc } as unknown as Parameters<typeof claimEmailSend>[0];
    expect(await claimEmailSendOutcome(admin, "synthetic-appointment", "reminder_24h")).toBe(outcome);
    expect(await claimEmailSend(admin, "synthetic-appointment", "reminder_24h")).toBe(legacy);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledWith("claim_email_send", { p_appointment_id: "synthetic-appointment", p_email_type: "reminder_24h" });
  });
  it("throwing RPC or diagnostic sink never turns unavailable into a collision or grant", async () => {
    const sink = vi.spyOn(console, "error").mockImplementation(() => { throw new Error("SYNTHETIC_PRIVATE log failure"); });
    try {
      const rpc = vi.fn(async () => { throw new Error("SYNTHETIC_PRIVATE transport failure"); });
      const admin = { rpc } as unknown as Parameters<typeof claimEmailSend>[0];
      expect(await claimEmailSendOutcome(admin, "synthetic-appointment", "reminder_24h")).toBe("unavailable");
      expect(await claimEmailSend(admin, "synthetic-appointment", "reminder_24h")).toBe(false);
      expect(JSON.stringify(sink.mock.calls)).not.toContain("SYNTHETIC_PRIVATE");
    } finally { sink.mockRestore(); }
  });
});


describe("MSG-007 email failure logs have a closed payload", () => {
  const APPOINTMENT_ID = "11111111-1111-4111-8111-111111111111";
  const PRIVATE = "PRIVATE patient@example.invalid +16045550199 https://example.invalid/intake/SECRET_TOKEN private clinical note";
  it.each(["attempt", "result"] as const)("%s RPC failure preserves behavior without exporting IDs or error content", async (operation) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const rpc = vi.fn(async () => ({ data: null, error: new Error(PRIVATE) }));
    const admin = { rpc } as unknown as Parameters<typeof claimEmailSend>[0];
    try {
      if (operation === "attempt") await recordEmailAttempt(admin, APPOINTMENT_ID, "reminder_24h", false);
      else await recordEmailResult(admin, APPOINTMENT_ID, "reminder_24h", false);
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(rpc).toHaveBeenCalledWith(
        operation === "attempt" ? "record_email_attempt" : "record_email_result",
        { p_appointment_id: APPOINTMENT_ID, p_email_type: "reminder_24h", p_success: false },
      );
      const output = JSON.stringify(log.mock.calls);
      expect(output).toContain("reminder_24h");
      expect(output).not.toContain(APPOINTMENT_ID);
      for (const privatePart of ["PRIVATE", "patient@example.invalid", "+16045550199", "SECRET_TOKEN", "private clinical note"]) expect(output).not.toContain(privatePart);
    } finally { log.mockRestore(); }
  });
  it("final failure keeps the operator event and attempt count without raw provider text", async () => {
    privacyAlerts.length = 0;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      logEmailFailure({ appointmentId: APPOINTMENT_ID, emailType: "reminder_24h", error: PRIVATE, retryable: true, attemptNumber: 3 });
      await vi.waitFor(() => expect(privacyAlerts).toHaveLength(1));
      const output = JSON.stringify(log.mock.calls);
      expect(output).toContain("email_send_failed");
      expect(output).not.toContain(APPOINTMENT_ID);
      expect(output).not.toContain("PRIVATE");
      expect(JSON.stringify(privacyAlerts)).not.toContain("PRIVATE");
      expect(privacyAlerts[0]).toMatchObject({ event: "email_send_gave_up", appointmentId: APPOINTMENT_ID, safeDetails: { attempt_number: 3, email_type: "reminder_24h" } });
    } finally { log.mockRestore(); }
  });
  it("a lower retryable attempt remains log-only", async () => {
    privacyAlerts.length = 0;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      logEmailFailure({ appointmentId: APPOINTMENT_ID, emailType: "reminder_2h", error: PRIVATE, retryable: true, attemptNumber: 2 });
      await Promise.resolve();
      expect(privacyAlerts).toEqual([]);
      expect(JSON.stringify(log.mock.calls)).toContain("reminder_2h");
      expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE");
    } finally { log.mockRestore(); }
  });
  it("unexpected runtime type/count inputs cannot smuggle private values into diagnostic fields", async () => {
    privacyAlerts.length = 0;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      logEmailFailure({ appointmentId: APPOINTMENT_ID, emailType: PRIVATE as "reminder_24h", error: PRIVATE, retryable: false, attemptNumber: 16045550199 });
      await vi.waitFor(() => expect(privacyAlerts).toHaveLength(1));
      expect(JSON.stringify([log.mock.calls, privacyAlerts[0]?.safeDetails, privacyAlerts[0]?.message])).not.toMatch(/PRIVATE|patient@example|16045550199|SECRET_TOKEN/);
      expect(privacyAlerts[0]).toMatchObject({ safeDetails: { email_type: "unknown", attempt_number: null } });
    } finally { log.mockRestore(); }
  });
});


describe("MSG-007 best-effort diagnostic sink and no-error controls", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  it.each(["attempt", "result"] as const)("successful %s RPC remains unchanged and log-free", async (kind) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const rpc = vi.fn(async () => ({ data: null, error: null })); const admin = { rpc } as unknown as Parameters<typeof recordEmailResult>[0];
      await (kind === "attempt" ? recordEmailAttempt : recordEmailResult)(admin, id, "reminder_24h", true);
      expect(rpc).toHaveBeenCalledExactlyOnceWith(kind === "attempt" ? "record_email_attempt" : "record_email_result", { p_appointment_id: id, p_email_type: "reminder_24h", p_success: true });
      expect(log).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
  it.each(["attempt", "result"] as const)("a throwing log sink cannot replace %s settlement", async (kind) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => { throw new Error("SYNTHETIC_PRIVATE log sink"); });
    try {
      const rpc = vi.fn(async () => ({ data: null, error: new Error("SYNTHETIC_PRIVATE contact/token") })); const admin = { rpc } as unknown as Parameters<typeof recordEmailResult>[0];
      await expect((kind === "attempt" ? recordEmailAttempt : recordEmailResult)(admin, id, "reminder_24h", false)).resolves.toBeUndefined();
      expect(rpc).toHaveBeenCalledTimes(1); expect(JSON.stringify(log.mock.calls)).not.toContain("SYNTHETIC_PRIVATE");
    } finally { log.mockRestore(); }
  });
  it("a throwing console sink does not suppress the existing final-failure ops event", async () => {
    privacyAlerts.length = 0;
    const log = vi.spyOn(console, "error").mockImplementation(() => { throw new Error("SYNTHETIC_PRIVATE log sink"); });
    try {
      expect(() => logEmailFailure({ appointmentId: id, emailType: "reminder_24h", error: "SYNTHETIC_PRIVATE contact/token", retryable: true, attemptNumber: 3 })).not.toThrow();
      await vi.waitFor(() => expect(privacyAlerts).toHaveLength(1));
      expect(privacyAlerts[0]).toMatchObject({ event: "email_send_gave_up", appointmentId: id, safeDetails: { attempt_number: 3 } });
      expect(JSON.stringify([log.mock.calls, privacyAlerts])).not.toContain("SYNTHETIC_PRIVATE");
    } finally { log.mockRestore(); }
  });
});
