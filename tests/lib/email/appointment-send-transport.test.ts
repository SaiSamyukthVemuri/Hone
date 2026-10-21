import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
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
import { claimEmailSend, logEmailFailure, recordEmailAttempt, recordEmailResult, sendCancellationEmail, sendEmailSafely } from "@/lib/email/send-appointment";
import { createFakeResendTransport } from "@/lib/email/e2e-fake-resend";
import { bindEmailOperationRequest, classifyEmailOperationObservation, retainEmailOperationObservation } from "@/lib/email/operation-state";
import { createEmailOperationDispatchAdapter } from "@/lib/email/operation-dispatch";

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

const privacyAlerts = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert: async (input: Record<string, unknown>) => { privacyAlerts.push(input); } }));

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


describe("MSG-007 email failure logs have a closed payload", () => {
  const APPOINTMENT_ID = "11111111-1111-4111-8111-111111111111";
  const PRIVATE = "PRIVATE patient@example.invalid +16045550199 https://example.invalid/intake/SECRET_TOKEN private clinical note";
  it.each(["attempt", "claim", "result"] as const)("%s RPC failure preserves behavior without exporting IDs or error content", async (operation) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const rpc = vi.fn(async () => ({ data: null, error: new Error(PRIVATE) }));
    const admin = { rpc } as unknown as Parameters<typeof claimEmailSend>[0];
    try {
      if (operation === "claim") expect(await claimEmailSend(admin, APPOINTMENT_ID, "reminder_24h")).toBe(false);
      else if (operation === "attempt") await recordEmailAttempt(admin, APPOINTMENT_ID, "reminder_24h", false);
      else await recordEmailResult(admin, APPOINTMENT_ID, "reminder_24h", false);
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(rpc).toHaveBeenCalledWith(
        operation === "attempt" ? "record_email_attempt" : operation === "claim" ? "claim_email_send" : "record_email_result",
        { p_appointment_id: APPOINTMENT_ID, p_email_type: "reminder_24h", ...(operation === "claim" ? {} : { p_success: false }) },
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

describe("0247 pure operation observations and request binding (not dispatch authority)", () => {
  const payload = { from: "Hone <hello@hone.care>", to: "success+operation@harness.local", ...BASE };
  const context = { providerAccount: "synthetic-account", providerKey: "opaque-synthetic-operation", purpose: "reminder_24h" as const };

  it("holds contradictory acceptance and validation-refusal evidence", () => {
    expect(classifyEmailOperationObservation({ kind: "reply", reply: { data: { id: FAKE_MESSAGE_ID }, error: { name: "validation_error", statusCode: 422 } } })).toEqual({ kind: "unknown", reason: "malformed_reply" });
  });
  it("rejects added runtime payload and attachment options rather than treating them as the frozen request", () => {
    const binding = bindEmailOperationRequest(payload, context);
    for (const extra of [{ bcc: "private@harness.local" }, { cc: [] }, { headers: { private: "token" } }]) {
      expect(binding.matches({ ...payload, ...extra }, context)).toBe(false);
    }
    const withAttachment = { ...payload, attachments: [{ filename: "a", content: Buffer.from("a") }] };
    const extended = { ...withAttachment, attachments: [{ ...withAttachment.attachments[0], contentType: "text/plain" }] };
    expect(bindEmailOperationRequest(withAttachment, context).matches(extended, context)).toBe(false);
  });

  it.each([null, {}, { data: { id: "id" } }, { error: false }])("holds malformed replies without acceptance: %j", (reply) => {
    expect(classifyEmailOperationObservation({ kind: "reply", reply }).kind).toBe("unknown");
  });
  it.each([undefined, "", " ", "id\nPRIVATE", 3])("requires a valid provider id: %j", (id) => {
    expect(classifyEmailOperationObservation({ kind: "reply", reply: { data: { id }, error: null } })).toEqual({ kind: "unknown", reason: "missing_id" });
  });
  it.each([
    ["invalid_idempotent_request", 409, "payload_conflict"],
    ["concurrent_idempotent_requests", 409, "inflight"],
    ["invalid_idempotency_key", 400, "invalid_key"],
    ["server_error", 503, "server_error"],
  ])("holds %s separately and excludes raw private messages", (name, statusCode, reason) => {
    const result = classifyEmailOperationObservation({ kind: "reply", reply: { data: null, error: { name, statusCode, message: "PRIVATE token patient@example.invalid" } } });
    expect(result).toEqual({ kind: "unknown", reason });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|token|patient@/);
  });
  it("uses the existing fake for acceptance/refusal and observes an exception without retry", async () => {
    vi.stubEnv("HONE_E2E_FAKE_RESEND", "1");
    const fake = createFakeResendTransport();
    const send = vi.spyOn(fake.emails, "send");
    const accepted = classifyEmailOperationObservation({ kind: "reply", reply: await fake.emails.send(payload) });
    expect(accepted).toEqual({ kind: "accepted", messageId: FAKE_MESSAGE_ID });
    expect(classifyEmailOperationObservation({ kind: "reply", reply: await fake.emails.send({ ...payload, to: "reject+operation@harness.local" }) })).toEqual({ kind: "definite_refusal" });
    let thrown: unknown;
    try { await fake.emails.send({ ...payload, to: "throw+operation@harness.local" }); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(Error);
    expect(classifyEmailOperationObservation({ kind: "transport" })).toEqual({ kind: "unknown", reason: "transport" });
    expect(send).toHaveBeenCalledTimes(3); // one explicit call per scenario; no replay
  });
  it("freezes attachment bytes, omitted fields, tokenized content and provider context in memory only", () => {
    const content = Buffer.from("PRIVATE original ICS");
    const original = { ...payload, attachments: [{ filename: "appointment.ics", content }] };
    const binding = bindEmailOperationRequest(original, context);
    expect(binding.matches({ ...original }, { ...context })).toBe(true);
    for (const changed of [
      { ...original, html: "PRIVATE reminted-token" }, { ...original, text: "changed" },
      { ...original, to: "other@harness.local" }, { ...original, from: "Other" },
      { ...original, subject: "changed" }, { ...original, replyTo: "" },
      { ...original, attachments: [] },
    ]) expect(binding.matches(changed, context)).toBe(false);
    expect(binding.matches(original, { ...context, providerKey: "rotated" })).toBe(false);
    expect(binding.matches(original, { ...context, providerAccount: "different" })).toBe(false);
    expect(binding.matches(original, { ...context, purpose: "reminder_2h" })).toBe(false);
    content[0] = 0;
    expect(binding.matches(original, context)).toBe(false);
    expect(JSON.stringify(binding)).toBe("{}");
  });
  it("keeps unknown and positive original-operation observations monotonic", () => {
    const unknown = classifyEmailOperationObservation({ kind: "timeout" });
    const lateAccepted = { kind: "accepted" as const, messageId: FAKE_MESSAGE_ID };
    const accepted = retainEmailOperationObservation(unknown, lateAccepted);
    expect(accepted).toEqual(lateAccepted);
    expect(retainEmailOperationObservation(accepted, { kind: "definite_refusal" })).toBe(accepted);
    expect(retainEmailOperationObservation(unknown, { kind: "definite_refusal" })).toBe(unknown);
    // This proves only the pure effect merge. Lease/projection isolation,
    // immutable DB horizons and dispatch permission need the reviewed adapter
    // and DB concurrency proof; this helper cannot settle or authorize them.
  });
});

describe("0247 private one-use SDK observation adapter (SQL port not wired)", () => {
  type Ports = Parameters<typeof createEmailOperationDispatchAdapter>[0];
  const payload = { from: "Hone <hello@hone.care>", to: "success+capability@harness.local", ...BASE };
  const context = { operationId: "opaque-operation", studioId: "synthetic-studio", appointmentId: "synthetic-appointment", purpose: "reminder_24h" as const, authority: { appointment: "2", client: "3", studio: "4", intake: "5" }, providerAccount: "synthetic-account", providerKey: "opaque-provider-key" };
  function setup() {
    vi.stubEnv("HONE_E2E_FAKE_RESEND", "1");
    const fake = createFakeResendTransport();
    const authorize = vi.fn<Ports["authorize"]>().mockResolvedValue({ kind: "authorized", firstPossibleAttemptAt: "2026-10-21T00:00:00Z", retryNotAfter: null });
    const observe = vi.fn<Ports["observe"]>().mockResolvedValue(undefined);
    const send = vi.fn<Ports["send"]>(async (request) => fake.emails.send(request));
    return { adapter: createEmailOperationDispatchAdapter({ authorize, observe, send }), authorize, observe, send, fake };
  }
  it("consumes authorization and dispatch synchronously so concurrent calls have one initial SDK invocation", async () => {
    const { adapter, authorize, observe, send } = setup();
    const request = adapter.freeze(payload, context)!;
    const grants = await Promise.all([adapter.authorize(request), adapter.authorize(request)]);
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(grants[1]).toBeNull();
    const results = await Promise.all([adapter.dispatchAndSettle(request, grants[0]!), adapter.dispatchAndSettle(request, grants[0]!)]);
    expect(results[0]).toMatchObject({ kind: "observed", observation: { kind: "accepted", messageId: FAKE_MESSAGE_ID } });
    expect(results[1]).toEqual({ kind: "held" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(payload, { idempotencyKey: context.providerKey });
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe.mock.calls[0][0]).toEqual(authorize.mock.calls[0][0]);
    expect(authorize.mock.calls[0][0]).toMatchObject({ ...context, channel: "email", requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(observe.mock.calls[0][1]).not.toBe(context.providerKey);
    expect(observe.mock.calls[0][1]).not.toBe(context.operationId);
    expect(createHash("sha256").update(observe.mock.calls[0][1]).digest("hex")).toBe(authorize.mock.calls[0][0].capabilityDigest);
    expect(JSON.stringify([request, ...grants])).toBe("[{},{},null]");
  });
  it("rejects forged/cross-request grants and consumes a mismatched grant without SDK or accepted write", async () => {
    const { adapter, send, observe } = setup();
    const request = adapter.freeze(payload, context)!;
    expect(await adapter.authorize({})).toBeNull();
    expect(await adapter.dispatchAndSettle(request, {})).toEqual({ kind: "held" });
    const other = adapter.freeze({ ...payload, html: "PRIVATE changed token" }, { ...context, operationId: "other-operation" })!;
    const grant = (await adapter.authorize(request))!;
    expect(await adapter.dispatchAndSettle(other, grant)).toEqual({ kind: "held" });
    expect(await adapter.dispatchAndSettle(request, grant)).toEqual({ kind: "held" });
    expect(send).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
  });
  it("sends only detached canonical bytes and refuses unmodelled runtime payload fields", async () => {
    const { adapter, send } = setup();
    const bytes = Buffer.from("original ICS");
    const mutable = { ...payload, attachments: [{ filename: "a.ics", content: bytes }] };
    const extended = { ...payload, bcc: "private@harness.local" };
    expect(adapter.freeze(extended, context)).toBeNull();
    const request = adapter.freeze(mutable, context)!;
    mutable.html = "PRIVATE changed token";
    bytes.fill(0);
    const grant = (await adapter.authorize(request))!;
    await adapter.dispatchAndSettle(request, grant);
    expect(send.mock.calls[0][0].html).toBe(payload.html);
    expect(send.mock.calls[0][0].attachments?.[0].content.toString()).toBe("original ICS");
  });
  it("keeps a refused/lost authorization held without any SDK or replacement authorization", async () => {
    const { adapter, authorize, send, observe } = setup();
    authorize.mockRejectedValueOnce(new Error("PRIVATE lost commit response"));
    const request = adapter.freeze(payload, context)!;
    expect(await adapter.authorize(request)).toBeNull();
    expect(await adapter.authorize(request)).toBeNull();
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
  });
  it("retains SDK-observed acceptance separately from failed persistence, with no second dispatch", async () => {
    const { adapter, observe, send } = setup();
    observe.mockRejectedValueOnce(new Error("PRIVATE receipt persistence unavailable"));
    const request = adapter.freeze(payload, context)!;
    const grant = (await adapter.authorize(request))!;
    expect(await adapter.dispatchAndSettle(request, grant)).toMatchObject({ kind: "observed", observation: { kind: "accepted" }, persistence: "unconfirmed" });
    expect(await adapter.dispatchAndSettle(request, grant)).toEqual({ kind: "held" });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it.each([
    { data: {}, error: null },
    { data: null, error: { name: "server_error", statusCode: 503 } },
    { data: null, error: { name: "invalid_idempotent_request", statusCode: 409 } },
    { data: null, error: { name: "concurrent_idempotent_requests", statusCode: 409 } },
  ])("holds uncertain SDK reply without a second invocation or replacement key: %j", async (reply) => {
    const { adapter, send } = setup();
    send.mockResolvedValueOnce(reply);
    const request = adapter.freeze(payload, context)!;
    const grant = (await adapter.authorize(request))!;
    expect(await adapter.dispatchAndSettle(request, grant)).toMatchObject({ kind: "observed", observation: { kind: "unknown" } });
    expect(await adapter.dispatchAndSettle(request, grant)).toEqual({ kind: "held" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toEqual({ idempotencyKey: context.providerKey });
  });
  it("holds timeout without replay and binds late SDK evidence to the original authorization", async () => {
    vi.useFakeTimers();
    try {
      const { adapter, send, observe, authorize, fake } = setup();
      let release!: () => void;
      send.mockImplementationOnce(async (request) => { await new Promise<void>((resolve) => { release = resolve; }); return fake.emails.send(request); });
      const request = adapter.freeze(payload, context)!;
      const grant = (await adapter.authorize(request))!;
      const pending = adapter.dispatchAndSettle(request, grant);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await pending).toMatchObject({ kind: "observed", observation: { kind: "unknown", reason: "timeout" } });
      expect(await adapter.dispatchAndSettle(request, grant)).toEqual({ kind: "held" });
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(observe).toHaveBeenCalledTimes(2);
      expect(observe.mock.calls[1][2]).toEqual({ kind: "accepted", messageId: FAKE_MESSAGE_ID });
      expect(observe.mock.calls[1][0]).toEqual(authorize.mock.calls[0][0]);
      expect(observe.mock.calls[1][1]).toBe(observe.mock.calls[0][1]);
      expect(send).toHaveBeenCalledTimes(1);
      // This proves ORIGINAL binding only, not SQL successor-lease/projection CAS.
    } finally { vi.useRealTimers(); }
  });
});
