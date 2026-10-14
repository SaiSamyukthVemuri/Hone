import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  SMS_SKIP_REASONS,
  beginAppointmentSmsMessage,
  claimWaitlistInvitationSms,
  isFailedDeliveryStatus,
  normalizeTwilioMessageStatus,
  recordSmsDeliveryStatus,
  settleOutcomeForSend,
  settleSmsMessage,
  smsStatusCallbackUrl,
} from "@/lib/sms/delivery-ledger";

// SMS-00 — the ledger's application half. The commands themselves are proved
// against a real database in tests/db/sms-delivery-foundation.db.test.ts; this
// file pins the mapping each wrapper performs and the fail-soft/fail-closed
// split: bookkeeping never breaks a send, and the invitation claim never lets
// one through when it cannot be taken.

const ROW = "0b8f1c1e-6a52-4c0e-9f3e-2f6c3c1a7d10";
const SID = `SM${"ab".repeat(16)}`;

type Answer = { data: unknown; error: unknown } | Error;
function admin(answer: Answer) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

let logs: string[] = [];
beforeEach(() => {
  logs = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
});
afterEach(() => vi.restoreAllMocks());

describe("normalizeTwilioMessageStatus", () => {
  it("maps Twilio's outbound vocabulary onto the ledger's six states", () => {
    expect(normalizeTwilioMessageStatus("accepted")).toBe("queued");
    expect(normalizeTwilioMessageStatus("scheduled")).toBe("queued");
    expect(normalizeTwilioMessageStatus("queued")).toBe("queued");
    expect(normalizeTwilioMessageStatus("sending")).toBe("sending");
    expect(normalizeTwilioMessageStatus("sent")).toBe("sent");
    expect(normalizeTwilioMessageStatus("delivered")).toBe("delivered");
    expect(normalizeTwilioMessageStatus("read")).toBe("delivered");
    expect(normalizeTwilioMessageStatus("undelivered")).toBe("undelivered");
    expect(normalizeTwilioMessageStatus("failed")).toBe("failed");
    expect(normalizeTwilioMessageStatus("canceled")).toBe("failed");
  });

  it("records nothing for inbound, partial or unknown statuses", () => {
    for (const raw of ["received", "receiving", "partially_delivered", "", "DELIVERED", undefined, 3]) {
      expect(normalizeTwilioMessageStatus(raw), String(raw)).toBeNull();
    }
  });

  it("only undelivered and failed count as a failed delivery", () => {
    expect(isFailedDeliveryStatus("undelivered")).toBe(true);
    expect(isFailedDeliveryStatus("failed")).toBe(true);
    for (const s of ["queued", "sending", "sent", "delivered"] as const) {
      expect(isFailedDeliveryStatus(s)).toBe(false);
    }
  });
});

describe("smsStatusCallbackUrl", () => {
  it("is built from TWILIO_WEBHOOK_BASE_URL, so it matches what the route re-derives", () => {
    expect(smsStatusCallbackUrl(ROW, { TWILIO_WEBHOOK_BASE_URL: "https://hone.care/" } as unknown as NodeJS.ProcessEnv)).toBe(
      `https://hone.care/api/twilio/message-status?m=${ROW}`,
    );
  });

  it("is null without a base, with an unusable base, or for a non-uuid row id", () => {
    expect(smsStatusCallbackUrl(ROW, {} as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(smsStatusCallbackUrl(ROW, { TWILIO_WEBHOOK_BASE_URL: "not a url" } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(smsStatusCallbackUrl(ROW, { TWILIO_WEBHOOK_BASE_URL: "ftp://hone.care" } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(
      smsStatusCallbackUrl("1; drop", { TWILIO_WEBHOOK_BASE_URL: "https://hone.care" } as unknown as NodeJS.ProcessEnv),
    ).toBeNull();
  });
});

describe("settleOutcomeForSend", () => {
  it("success is accepted with the SID", () => {
    expect(settleOutcomeForSend({ ok: true, messageSid: SID })).toEqual({
      outcome: "accepted",
      providerMessageSid: SID,
    });
  });

  it("no request -> skipped, with the reason that says why", () => {
    expect(
      settleOutcomeForSend({ ok: false, error: "sms_fenced_non_production", retryable: false, attempt: "none" }),
    ).toEqual({ outcome: "skipped", skipReason: "non_production_deployment" });
    expect(
      settleOutcomeForSend({ ok: false, error: "twilio_not_configured", retryable: false, attempt: "none" }),
    ).toEqual({ outcome: "skipped", skipReason: "provider_not_configured" });
  });

  it("a provider refusal is refused; a lost answer is unknown, never refused", () => {
    expect(
      settleOutcomeForSend({
        ok: false,
        error: "twilio_http_400",
        retryable: false,
        attempt: "refused",
        providerErrorCode: 21211,
      }),
    ).toEqual({ outcome: "refused", providerErrorCode: 21211 });
    expect(
      settleOutcomeForSend({ ok: false, error: "twilio_timeout", retryable: true, attempt: "ambiguous" }),
    ).toEqual({ outcome: "unknown", providerErrorCode: null });
  });

  it("every skip reason it can produce is in the closed vocabulary", () => {
    for (const error of ["sms_fenced_non_production", "twilio_not_configured", "twilio_missing_sender"]) {
      const s = settleOutcomeForSend({ ok: false, error, retryable: false, attempt: "none" });
      expect(s.outcome).toBe("skipped");
      if (s.outcome === "skipped") expect(SMS_SKIP_REASONS).toContain(s.skipReason);
    }
  });
});

describe("beginAppointmentSmsMessage is fail-soft", () => {
  it("returns the row id", async () => {
    const { client, calls } = admin({ data: ROW, error: null });
    expect(
      await beginAppointmentSmsMessage(client, {
        studioId: "s",
        appointmentId: "a",
        purpose: "appointment_reminder_24h",
      }),
    ).toBe(ROW);
    expect(calls[0]).toEqual({
      fn: "begin_appointment_sms_message",
      args: { p_studio_id: "s", p_appointment_id: "a", p_purpose: "appointment_reminder_24h" },
    });
  });

  it("returns null, without throwing, on a refusal, an error or a throw", async () => {
    for (const answer of [
      { data: null, error: null },
      { data: null, error: { message: "function does not exist" } },
      new Error("network"),
    ]) {
      const { client } = admin(answer);
      await expect(
        beginAppointmentSmsMessage(client, {
          studioId: "s",
          appointmentId: "a",
          purpose: "appointment_confirmation",
        }),
      ).resolves.toBeNull();
    }
  });
});

describe("claimWaitlistInvitationSms is fail-CLOSED", () => {
  const claimed = {
    result: "claimed",
    message_id: ROW,
    phone: "+16475550123",
    sms_consent_at: "2026-10-01T00:00:00Z",
    sms_opted_out_at: null,
    mobile_verified_at: "2026-10-01T00:00:00Z",
    expires_at: "2026-10-09T00:00:00Z",
  };

  it("a claim carries the row id and the prospect's facts", async () => {
    const { client } = admin({ data: [claimed], error: null });
    expect(await claimWaitlistInvitationSms(client, { studioId: "s", invitationId: "i" })).toEqual({
      result: "claimed",
      messageId: ROW,
      target: {
        phone: "+16475550123",
        smsConsentAt: "2026-10-01T00:00:00Z",
        smsOptedOutAt: null,
        mobileVerifiedAt: "2026-10-01T00:00:00Z",
        expiresAt: "2026-10-09T00:00:00Z",
      },
    });
  });

  it("passes every refusal word through", async () => {
    for (const result of ["already_claimed", "not_found", "not_live", "studio_disabled", "invalid_input"]) {
      const { client } = admin({ data: [{ result }], error: null });
      expect(await claimWaitlistInvitationSms(client, { studioId: "s", invitationId: "i" })).toEqual({
        result,
      });
    }
  });

  it("an error, a throw, an unknown word or a malformed claim is `unavailable` -- never a claim", async () => {
    for (const answer of [
      { data: null, error: { message: "function does not exist" } },
      new Error("network"),
      { data: [{ result: "maybe" }], error: null },
      { data: [{ ...claimed, message_id: "not-a-uuid" }], error: null },
      { data: [{ ...claimed, expires_at: null }], error: null },
    ]) {
      const { client } = admin(answer);
      expect(await claimWaitlistInvitationSms(client, { studioId: "s", invitationId: "i" })).toEqual({
        result: "unavailable",
      });
    }
  });
});

describe("settleSmsMessage sends exactly the fields each outcome owns", () => {
  it("accepted sends the SID only", async () => {
    const { client, calls } = admin({ data: "settled", error: null });
    expect(await settleSmsMessage(client, ROW, { outcome: "accepted", providerMessageSid: SID })).toBe(
      "settled",
    );
    expect(calls[0]?.args).toEqual({
      p_message_id: ROW,
      p_outcome: "accepted",
      p_provider_message_sid: SID,
      p_provider_error_code: null,
      p_skip_reason: null,
    });
  });

  it("refused sends the code only; skipped sends the reason only", async () => {
    const r = admin({ data: "settled", error: null });
    await settleSmsMessage(r.client, ROW, { outcome: "refused", providerErrorCode: 21610 });
    expect(r.calls[0]?.args).toMatchObject({
      p_provider_message_sid: null,
      p_provider_error_code: 21610,
      p_skip_reason: null,
    });
    const s = admin({ data: "settled", error: null });
    await settleSmsMessage(s.client, ROW, { outcome: "skipped", skipReason: "no_consent" });
    expect(s.calls[0]?.args).toMatchObject({
      p_provider_message_sid: null,
      p_provider_error_code: null,
      p_skip_reason: "no_consent",
    });
  });

  it("is null, without throwing, when the ledger cannot be reached", async () => {
    for (const answer of [{ data: null, error: { message: "x" } }, new Error("network"), { data: "weird", error: null }]) {
      const { client } = admin(answer);
      await expect(settleSmsMessage(client, ROW, { outcome: "unknown" })).resolves.toBeNull();
    }
  });
});

describe("recordSmsDeliveryStatus", () => {
  it("returns the result, studio, purpose and appointment", async () => {
    const { client } = admin({
      data: [
        {
          result: "updated",
          studio_id: "4f0a1b2c-3d4e-4f50-8a6b-7c8d9e0f1a2b",
          purpose: "waitlist_invitation",
          status: "delivered",
          appointment_id: null,
        },
      ],
      error: null,
    });
    expect(
      await recordSmsDeliveryStatus(client, {
        messageId: ROW,
        providerMessageSid: SID,
        status: "delivered",
        providerErrorCode: null,
      }),
    ).toEqual({
      result: "updated",
      studioId: "4f0a1b2c-3d4e-4f50-8a6b-7c8d9e0f1a2b",
      purpose: "waitlist_invitation",
      appointmentId: null,
    });
  });

  it("is null on an error, a throw or an unknown result word", async () => {
    for (const answer of [{ data: null, error: { message: "x" } }, new Error("n"), { data: [{ result: "?" }], error: null }]) {
      const { client } = admin(answer);
      expect(
        await recordSmsDeliveryStatus(client, {
          messageId: ROW,
          providerMessageSid: SID,
          status: "sent",
          providerErrorCode: null,
        }),
      ).toBeNull();
    }
  });
});

describe("logging discipline", () => {
  it("failure logs carry shapes and words, never a phone or a SID", async () => {
    const { client } = admin(new Error("+16475550123 boom"));
    await claimWaitlistInvitationSms(client, { studioId: "s", invitationId: "i" });
    await settleSmsMessage(client, ROW, { outcome: "accepted", providerMessageSid: SID });
    const all = logs.join("\n");
    expect(all).toContain("sms_invitation_claim_failed");
    expect(all).not.toContain("6475550123");
    expect(all).not.toContain(SID);
  });
});
