import { describe, expect, it } from "vitest";
import {
  sendWaitlistInvitationEmail,
  sendWaitlistRecipientProofEmail,
} from "@/lib/waitlist/delivery/send";
import {
  classifyDelivery,
  isProofExpiryWithinCeiling,
  proofRemainingMinutes,
  PROOF_TTL_CEILING_MINUTES,
  PROOF_TTL_TARGET_MINUTES,
} from "@/lib/waitlist/delivery/policy";
import type {
  IdempotentEmailTransport,
  ProviderPayload,
} from "@/lib/email/new-client-waitlist-send";

// WAIT DELIVERY-01. Every send below goes through an INJECTED transport that
// records its arguments and returns a canned result. Nothing in this file can
// reach a provider: the real client is never constructed, because `transport`
// is always supplied.

type Recorded = { payload: ProviderPayload; idempotencyKey?: string };

function recordingTransport(
  result: Awaited<ReturnType<IdempotentEmailTransport["emails"]["send"]>>,
): { transport: IdempotentEmailTransport; calls: Recorded[] } {
  const calls: Recorded[] = [];
  return {
    calls,
    transport: {
      emails: {
        send: async (payload, options) => {
          calls.push({ payload, idempotencyKey: options?.idempotencyKey });
          return result;
        },
      },
    },
  };
}

const ACCEPTED = { data: { id: "msg_123" }, error: null };

const STUDIO = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Willow Electrolysis",
  postcare_contact_email: "hello@willow.test",
  owner_email: "owner@willow.test",
};

const INVITATION_ID = "22222222-2222-4222-8222-222222222222";
const CHALLENGE_ID = "33333333-3333-4333-8333-333333333333";
const RECIPIENT = "prospect@example.test";
const URL = "https://hone.care/waitlist/invitation/RAWTOKEN";

describe("invitation delivery", () => {
  it("sends studio-branded, with the studio's Reply-To authority", async () => {
    const { transport, calls } = recordingTransport(ACCEPTED);
    await sendWaitlistInvitationEmail({
      studio: STUDIO,
      invitationId: INVITATION_ID,
      recipientEmail: RECIPIENT,
      invitationUrl: URL,
      expiresInPhrase: "3 days",
      transport,
    });

    expect(calls).toHaveLength(1);
    // COMMS-01A: display name is the studio, envelope stays on the one verified
    // sender domain, Reply-To resolves to the studio rather than to Hone.
    expect(calls[0].payload.from).toBe(
      "Willow Electrolysis via Hone <hello@hone.care>",
    );
    expect(calls[0].payload.replyTo).toBe("hello@willow.test");
    expect(calls[0].payload.to).toBe(RECIPIENT);
  });

  it("falls back to owner_email when the postcare address is malformed", async () => {
    // studioClientContactEmail picks over VALID authorities, not non-blank
    // strings — a legacy malformed value must not send replies to Hone.
    const { transport, calls } = recordingTransport(ACCEPTED);
    await sendWaitlistInvitationEmail({
      studio: { ...STUDIO, postcare_contact_email: "front:desk@willow.test" },
      invitationId: INVITATION_ID,
      recipientEmail: RECIPIENT,
      invitationUrl: URL,
      expiresInPhrase: "3 days",
      transport,
    });
    expect(calls[0].payload.replyTo).toBe("owner@willow.test");
  });

  it("scopes the idempotency key to the INVITATION, not just the payload", async () => {
    // 0188 keeps invitations in a child table precisely because an entry can be
    // invited, expire, be requeued and be invited AGAIN. Two cycles render
    // identical bytes for the same studio; without the invitation in the key
    // the provider replays the first response and the second invitation reports
    // accepted while nobody received it.
    const a = recordingTransport(ACCEPTED);
    await sendWaitlistInvitationEmail({
      studio: STUDIO,
      invitationId: INVITATION_ID,
      recipientEmail: RECIPIENT,
      invitationUrl: URL,
      expiresInPhrase: "3 days",
      transport: a.transport,
    });

    const b = recordingTransport(ACCEPTED);
    await sendWaitlistInvitationEmail({
      studio: STUDIO,
      invitationId: "44444444-4444-4444-8444-444444444444",
      recipientEmail: RECIPIENT,
      invitationUrl: URL,
      expiresInPhrase: "3 days",
      transport: b.transport,
    });

    expect(a.calls[0].idempotencyKey).toBeTruthy();
    expect(a.calls[0].idempotencyKey).not.toBe(b.calls[0].idempotencyKey);
    expect(a.calls[0].idempotencyKey).toContain(INVITATION_ID);
    expect(a.calls[0].idempotencyKey).toContain(STUDIO.id);
  });

  it("is stable for a genuine resubmission of the same invitation", async () => {
    const a = recordingTransport(ACCEPTED);
    const b = recordingTransport(ACCEPTED);
    const args = {
      studio: STUDIO,
      invitationId: INVITATION_ID,
      recipientEmail: RECIPIENT,
      invitationUrl: URL,
      expiresInPhrase: "3 days",
    };
    await sendWaitlistInvitationEmail({ ...args, transport: a.transport });
    await sendWaitlistInvitationEmail({ ...args, transport: b.transport });
    expect(a.calls[0].idempotencyKey).toBe(b.calls[0].idempotencyKey);
  });

  it("never mutates lifecycle, whatever the provider says", async () => {
    const rejected = recordingTransport({
      data: null,
      error: { name: "invalid_to_address" },
    });
    const out = await sendWaitlistInvitationEmail({
      studio: STUDIO,
      invitationId: INVITATION_ID,
      recipientEmail: RECIPIENT,
      invitationUrl: URL,
      expiresInPhrase: "3 days",
      transport: rejected.transport,
    });
    expect(out.disposition.mayMutateLifecycle).toBe(false);
    expect(out.disposition.delivered).toBe("no");
  });
});

describe("recipient proof delivery", () => {
  const NOW = new Date("2026-09-07T12:00:00.000Z");
  const IN_20 = new Date(NOW.getTime() + 20 * 60_000);

  it("scopes the idempotency key to the CHALLENGE", async () => {
    // Two challenges normally differ in their code and therefore in their
    // bytes. Relying on that would make correctness an accident of the
    // alphabet, and a short code space makes a repeat genuinely possible.
    const a = recordingTransport(ACCEPTED);
    const b = recordingTransport(ACCEPTED);
    const base = {
      studio: STUDIO,
      invitationId: INVITATION_ID,
      recipientEmail: RECIPIENT,
      code: "H4K2QF7P",
      expiresAt: IN_20,
      action: "book" as const,
      now: NOW,
    };
    await sendWaitlistRecipientProofEmail({
      ...base,
      challengeId: CHALLENGE_ID,
      transport: a.transport,
    });
    await sendWaitlistRecipientProofEmail({
      ...base,
      challengeId: "55555555-5555-4555-8555-555555555555",
      transport: b.transport,
    });
    expect(a.calls[0].idempotencyKey).not.toBe(b.calls[0].idempotencyKey);
    expect(a.calls[0].idempotencyKey).toContain(CHALLENGE_ID);
  });

  it("renders the window derived from the stored expiry, not a constant", async () => {
    const { transport, calls } = recordingTransport(ACCEPTED);
    await sendWaitlistRecipientProofEmail({
      studio: STUDIO,
      invitationId: INVITATION_ID,
      challengeId: CHALLENGE_ID,
      recipientEmail: RECIPIENT,
      code: "H4K2QF7P",
      // Deliberately NOT the target: the database is the owner and the copy
      // must describe what it actually stored.
      expiresAt: new Date(NOW.getTime() + 7 * 60_000),
      action: "book",
      now: NOW,
      transport,
    });
    expect(calls[0].payload.text).toContain("expires in 7 minutes");
    expect(calls[0].payload.text).not.toContain("20 minutes");
  });

  it("REFUSES to send a proof whose expiry exceeds the ceiling", async () => {
    const { transport, calls } = recordingTransport(ACCEPTED);
    const out = await sendWaitlistRecipientProofEmail({
      studio: STUDIO,
      invitationId: INVITATION_ID,
      challengeId: CHALLENGE_ID,
      recipientEmail: RECIPIENT,
      code: "H4K2QF7P",
      expiresAt: new Date(NOW.getTime() + 31 * 60_000),
      action: "book",
      now: NOW,
      transport,
    });
    expect(calls).toHaveLength(0); // nothing was transmitted
    expect(out.disposition.delivered).toBe("no");
    expect(out.disposition.reason).toBe("rejected_proof_expiry_outside_mandate");
  });

  it("REFUSES to send a proof that has already elapsed", async () => {
    const { transport, calls } = recordingTransport(ACCEPTED);
    const out = await sendWaitlistRecipientProofEmail({
      studio: STUDIO,
      invitationId: INVITATION_ID,
      challengeId: CHALLENGE_ID,
      recipientEmail: RECIPIENT,
      code: "H4K2QF7P",
      expiresAt: new Date(NOW.getTime() - 1_000),
      action: "book",
      now: NOW,
      transport,
    });
    expect(calls).toHaveLength(0);
    expect(out.disposition.reason).toBe("rejected_proof_expiry_outside_mandate");
  });

  it("never puts the invitation URL beside the code", async () => {
    const { transport, calls } = recordingTransport(ACCEPTED);
    await sendWaitlistRecipientProofEmail({
      studio: STUDIO,
      invitationId: INVITATION_ID,
      challengeId: CHALLENGE_ID,
      recipientEmail: RECIPIENT,
      code: "H4K2QF7P",
      expiresAt: IN_20,
      action: "book",
      now: NOW,
      transport,
    });
    expect(calls[0].payload.text).not.toContain(URL);
    expect(calls[0].payload.html).not.toContain(URL);
    expect(calls[0].payload.subject).not.toContain("H4K2QF7P");
  });
});

describe("provider failure classification", () => {
  it("an ambiguous send may NOT invalidate the challenge", () => {
    // The in-flight request was never cancelled and may still be accepted.
    // Killing the challenge would strand a code the recipient is about to type.
    for (const reason of ["timeout", "concurrent", "no_message_id"] as const) {
      const d = classifyDelivery({ status: "ambiguous", reason });
      expect(d.delivered).toBe("unknown");
      expect(d.mayInvalidateChallenge).toBe(false);
      expect(d.offerResend).toBe(true);
      expect(d.mayMutateLifecycle).toBe(false);
    }
  });

  it("a definite refusal MAY invalidate the challenge", () => {
    const d = classifyDelivery({ status: "rejected", code: "validation_error" });
    expect(d.delivered).toBe("no");
    expect(d.mayInvalidateChallenge).toBe(true);
    expect(d.mayMutateLifecycle).toBe(false);
  });

  it("acceptance still may not mutate lifecycle", () => {
    const d = classifyDelivery({ status: "accepted", messageId: "msg_1" });
    expect(d.delivered).toBe("yes");
    expect(d.mayMutateLifecycle).toBe(false);
  });
});

describe("proof window policy", () => {
  it("targets 20 minutes under a 30-minute ceiling", () => {
    expect(PROOF_TTL_TARGET_MINUTES).toBe(20);
    expect(PROOF_TTL_CEILING_MINUTES).toBe(30);
    expect(PROOF_TTL_TARGET_MINUTES).toBeLessThan(PROOF_TTL_CEILING_MINUTES);
  });

  it("accepts the ceiling exactly and rejects a millisecond beyond it", () => {
    const now = new Date("2026-09-07T12:00:00.000Z");
    const at = (ms: number) => new Date(now.getTime() + ms);
    expect(isProofExpiryWithinCeiling(at(30 * 60_000), now)).toBe(true);
    expect(isProofExpiryWithinCeiling(at(30 * 60_000 + 1), now)).toBe(false);
    expect(isProofExpiryWithinCeiling(at(0), now)).toBe(false);
    expect(isProofExpiryWithinCeiling(at(-1), now)).toBe(false);
  });

  it("rounds the advertised window DOWN", () => {
    // Advertising longer than the truth is the failure that matters: the
    // recipient trusts the sentence and finds a dead code.
    const now = new Date("2026-09-07T12:00:00.000Z");
    expect(proofRemainingMinutes(new Date(now.getTime() + 119_000), now)).toBe(1);
    expect(proofRemainingMinutes(new Date(now.getTime() - 1), now)).toBe(0);
  });
});
