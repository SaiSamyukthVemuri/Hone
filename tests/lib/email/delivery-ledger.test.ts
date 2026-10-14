import { afterEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// DELIVERY-VISIBILITY-01 — the email send path joins the delivery ledger.
//
// 1. sendEmailSafely tags a ledgered send with `hone_m = <row id>` and
//    classifies every failure by whether the provider was reached.
// 2. settleOutcomeForEmailSend maps that answer to the ledger truthfully:
//    acceptance needs a provider id, ambiguity is `unknown` (never a refusal),
//    no provider call is `skipped`, and no free-text provider message is kept.
// 3. The begin/settle wrappers are fail-soft and never throw.
// ===========================================================================

type Payload = Record<string, unknown>;
const sent: Payload[] = [];
let answer: () => Promise<unknown> = async () => ({ data: { id: "0b8f1c1e-6a52-4c0e-9f3e-2f6c3c1a7d10" }, error: null });
let transportPresent = true;

vi.mock("@/lib/email/client", () => ({
  FROM_ADDRESS: "Hone <hello@hone.care>",
  getResendTransport: () =>
    transportPresent
      ? {
          emails: {
            send: (payload: Payload) => {
              sent.push(payload);
              return answer();
            },
          },
        }
      : null,
}));

const { sendEmailSafely } = await import("@/lib/email/send-appointment");
const { settleOutcomeForEmailSend, beginAppointmentEmailMessage, settleEmailMessage } = await import(
  "@/lib/email/delivery-ledger"
);

const ROW = "6e5d4c3b-2a19-4807-a6b5-c4d3e2f1a0b9";
const base = { to: "client@example.test", subject: "Reminder", html: "<p>x</p>", text: "x" };

afterEach(() => {
  sent.length = 0;
  transportPresent = true;
  answer = async () => ({ data: { id: "0b8f1c1e-6a52-4c0e-9f3e-2f6c3c1a7d10" }, error: null });
});

describe("sendEmailSafely tags a ledgered send and classifies failures", () => {
  it("adds exactly the hone_m tag when a ledger row is given, and nothing when it is not", async () => {
    await sendEmailSafely({ ...base, ledgerMessageId: ROW });
    await sendEmailSafely(base);
    expect(sent[0]!.tags).toEqual([{ name: "hone_m", value: ROW }]);
    expect(sent[1]).not.toHaveProperty("tags");
  });

  it.each([
    ["a 422 validation refusal", { statusCode: 422, name: "validation_error", message: "bad" }, "refused"],
    ["a 429 rate limit", { statusCode: 429, name: "rate_limit_exceeded", message: "slow down" }, "refused"],
    ["a 500 from the provider", { statusCode: 500, name: "internal_server_error", message: "oops" }, "ambiguous"],
    ["an unfamiliar envelope", { message: "something odd" }, "ambiguous"],
  ] as const)("classifies %s", async (_label, error, attempt) => {
    answer = async () => ({ data: null, error });
    const r = await sendEmailSafely(base);
    expect(r).toMatchObject({ ok: false, attempt });
  });

  it("calls a thrown request ambiguous, and a request never made `none`", async () => {
    answer = async () => {
      throw new Error("socket hang up");
    };
    expect(await sendEmailSafely(base)).toMatchObject({ ok: false, attempt: "ambiguous" });
    expect(await sendEmailSafely({ ...base, to: "not-an-address" })).toMatchObject({ ok: false, attempt: "none" });
    transportPresent = false;
    expect(await sendEmailSafely(base)).toMatchObject({ ok: false, attempt: "none" });
  });
});

describe("settleOutcomeForEmailSend", () => {
  it("accepts only with a provider id it can correlate", () => {
    expect(settleOutcomeForEmailSend({ ok: true, messageId: "0B8F1C1E-6A52-4C0E-9F3E-2F6C3C1A7D10" })).toEqual({
      outcome: "accepted",
      providerEmailId: "0b8f1c1e-6a52-4c0e-9f3e-2f6c3c1a7d10",
    });
    expect(settleOutcomeForEmailSend({ ok: true, messageId: "fake-resend-message-id" })).toEqual({
      outcome: "unknown",
      providerError: "no_message_id",
    });
  });

  it("never turns an ambiguous or unclassified failure into a refusal", () => {
    expect(settleOutcomeForEmailSend({ ok: false, error: "Resend timeout after 15000ms", retryable: true, attempt: "ambiguous" })).toEqual({
      outcome: "unknown",
      providerError: "timeout",
    });
    expect(settleOutcomeForEmailSend({ ok: false, error: "x", retryable: false })).toMatchObject({ outcome: "unknown" });
  });

  it("records no provider call as a skip, with a closed reason", () => {
    expect(
      settleOutcomeForEmailSend({ ok: false, error: "Resend not configured (RESEND_API_KEY missing)", retryable: false, attempt: "none" }),
    ).toEqual({ outcome: "skipped", skipReason: "provider_not_configured" });
    expect(settleOutcomeForEmailSend({ ok: false, error: "No client email on file", retryable: false, attempt: "none" })).toEqual({
      outcome: "skipped",
      skipReason: "no_recipient",
    });
  });

  it("keeps a refusal's slug but never its free-text message", () => {
    const leaky = "Invalid `to` field: client.private@example.test is not allowed";
    const out = settleOutcomeForEmailSend({ ok: false, error: leaky, retryable: false, attempt: "refused" });
    expect(out).toEqual({ outcome: "refused", providerError: "provider_refused" });
    expect(JSON.stringify(out)).not.toContain("example.test");
  });
});

describe("the ledger wrappers are fail-soft", () => {
  const admin = (impl: (fn: string, args: Record<string, unknown>) => Promise<unknown>) =>
    ({ rpc: impl }) as unknown as Parameters<typeof beginAppointmentEmailMessage>[0];

  it("returns the row id, or null on any failure, never throwing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ok = admin(async () => ({ data: ROW, error: null }));
    expect(await beginAppointmentEmailMessage(ok, { studioId: ROW, appointmentId: ROW, purpose: "appointment_reminder_24h" })).toBe(ROW);
    const failing = admin(async () => ({ data: null, error: { message: "down" } }));
    expect(await beginAppointmentEmailMessage(failing, { studioId: ROW, appointmentId: ROW, purpose: "appointment_reminder_24h" })).toBeNull();
    const throwing = admin(async () => {
      throw new Error("reset");
    });
    expect(await settleEmailMessage(throwing, ROW, { outcome: "unknown", providerError: "timeout" })).toBeNull();
  });

  it("sends each outcome's fields and only those", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const spy = admin(async (_fn, args) => {
      calls.push(args);
      return { data: "settled", error: null };
    });
    await settleEmailMessage(spy, ROW, { outcome: "refused", providerError: "provider_refused" });
    expect(calls[0]).toEqual({
      p_message_id: ROW,
      p_outcome: "refused",
      p_provider_email_id: null,
      p_provider_error: "provider_refused",
      p_skip_reason: null,
    });
  });
});
