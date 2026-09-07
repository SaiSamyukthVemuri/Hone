import { describe, expect, it, vi, afterEach } from "vitest";
import {
  buildDeliveryLogRecord,
  DELIVERY_LOG_KEYS,
} from "@/lib/waitlist/delivery/log-safety";
import {
  sendWaitlistInvitationEmail,
  sendWaitlistRecipientProofEmail,
} from "@/lib/waitlist/delivery/send";
import { redactOpsAlertDetails } from "@/lib/ops/redact";
import type { IdempotentEmailTransport } from "@/lib/email/new-client-waitlist-send";

// ===========================================================================
// WAIT DELIVERY-01 — THE TWO SECRETS MUST NEVER REACH A LOG
// ===========================================================================
//
// The secrets are the invitation's raw bearer token (inside the URL) and the
// recipient proof code. Neither may appear in a log line, an ops alert, or any
// telemetry payload — and not in a hashed, truncated or prefixed form either.
// lib/security/token-routes.ts already argued why a derivative is not good
// enough: a stable hash of a bearer credential is still a correlatable
// identifier, and a prefix is a brute-force head start. A proof code is drawn
// from a far smaller space than a 256-bit token, so a truncation is
// proportionally MORE of a head start, not less.
//
// The primary defence is structural: `buildDeliveryLogRecord` is the only way
// to construct a delivery log record and its input type has no slot for a
// secret. These tests pin that closed shape from the outside, then verify the
// send paths actually route through it while the secrets are in scope.

const SECRET_CODE = "H4K2QF7P";
const RAW_TOKEN = "RAWTOKEN-do-not-log-me";
const URL = `https://hone.care/waitlist/invitation/${RAW_TOKEN}`;

const STUDIO = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Willow Electrolysis",
  postcare_contact_email: "hello@willow.test",
  owner_email: "owner@willow.test",
};
const INVITATION_ID = "22222222-2222-4222-8222-222222222222";
const CHALLENGE_ID = "33333333-3333-4333-8333-333333333333";
const RECIPIENT = "prospect@example.test";

function transportReturning(
  result: Awaited<ReturnType<IdempotentEmailTransport["emails"]["send"]>>,
): IdempotentEmailTransport {
  return { emails: { send: async () => result } };
}

const ACCEPTED = { data: { id: "msg_123" }, error: null };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the delivery log record is a closed shape", () => {
  it("has exactly the permitted keys and no others", () => {
    const rec = buildDeliveryLogRecord({
      kind: "recipient_proof",
      studioId: STUDIO.id,
      invitationId: INVITATION_ID,
      challengeId: CHALLENGE_ID,
      disposition: "accepted",
      providerMessageId: "msg_123",
    });
    // If a field is added to the record, this fails until DELIVERY_LOG_KEYS is
    // updated — which is the moment to ask whether the new field can carry a
    // secret. A type alone would not force that pause.
    expect(Object.keys(rec).sort()).toEqual([...DELIVERY_LOG_KEYS].sort());
  });

  it("carries no recipient address, subject, body or URL", () => {
    const rec = buildDeliveryLogRecord({
      kind: "invitation",
      studioId: STUDIO.id,
      invitationId: INVITATION_ID,
      disposition: "accepted",
      providerMessageId: "msg_123",
    });
    const serialized = JSON.stringify(rec);
    expect(serialized).not.toContain(RECIPIENT);
    expect(serialized).not.toContain("@");
    expect(serialized).not.toContain("http");
  });

  it("survives the ops redactor unchanged — it was already safe", () => {
    // Second layer, different mechanism. A record that the redactor has to
    // change would mean the closed constructor had already failed.
    const rec = buildDeliveryLogRecord({
      kind: "recipient_proof",
      studioId: STUDIO.id,
      invitationId: INVITATION_ID,
      challengeId: CHALLENGE_ID,
      disposition: "ambiguous_timeout",
      providerMessageId: null,
    });
    expect(redactOpsAlertDetails({ ...rec })).toEqual({ ...rec });
  });
});

describe("the proof code never reaches the log", () => {
  it("is absent from the record of a successful send", async () => {
    const out = await sendWaitlistRecipientProofEmail({
      studio: STUDIO,
      invitationId: INVITATION_ID,
      challengeId: CHALLENGE_ID,
      recipientEmail: RECIPIENT,
      code: SECRET_CODE,
      expiresAt: new Date(Date.now() + 20 * 60_000),
      action: "book",
      transport: transportReturning(ACCEPTED),
    });
    const serialized = JSON.stringify(out.log);
    expect(serialized).not.toContain(SECRET_CODE);
    // Not in any derived form either.
    expect(serialized).not.toContain(SECRET_CODE.slice(0, 4));
    expect(serialized).not.toContain(SECRET_CODE.toLowerCase());
  });

  it("is absent when the provider refuses", async () => {
    const out = await sendWaitlistRecipientProofEmail({
      studio: STUDIO,
      invitationId: INVITATION_ID,
      challengeId: CHALLENGE_ID,
      recipientEmail: RECIPIENT,
      code: SECRET_CODE,
      expiresAt: new Date(Date.now() + 20 * 60_000),
      action: "book",
      transport: transportReturning({
        data: null,
        // A provider error message is exactly where a leak arrives in
        // practice — PR #285 found recordOpsAlert storing raw provider
        // messages. The disposition must be a bounded vocabulary, never this
        // free text.
        error: { name: "validation_error", message: `bad code ${SECRET_CODE}` },
      }),
    });
    const serialized = JSON.stringify(out.log);
    expect(serialized).not.toContain(SECRET_CODE);
    expect(out.log.disposition).toBe("rejected_validation_error");
  });

  it("is absent when the expiry is refused before any send", async () => {
    const out = await sendWaitlistRecipientProofEmail({
      studio: STUDIO,
      invitationId: INVITATION_ID,
      challengeId: CHALLENGE_ID,
      recipientEmail: RECIPIENT,
      code: SECRET_CODE,
      expiresAt: new Date(Date.now() + 99 * 60_000),
      action: "book",
      transport: transportReturning(ACCEPTED),
    });
    expect(JSON.stringify(out.log)).not.toContain(SECRET_CODE);
  });

  it("reaches the EMAIL BODY and nowhere else", async () => {
    // The positive half. A test that only proved absence would also pass if the
    // code were never rendered at all, which would be a broken feature rather
    // than a secure one.
    let sentText = "";
    await sendWaitlistRecipientProofEmail({
      studio: STUDIO,
      invitationId: INVITATION_ID,
      challengeId: CHALLENGE_ID,
      recipientEmail: RECIPIENT,
      code: SECRET_CODE,
      expiresAt: new Date(Date.now() + 20 * 60_000),
      action: "book",
      transport: {
        emails: {
          send: async (payload) => {
            sentText = payload.text;
            return ACCEPTED;
          },
        },
      },
    });
    expect(sentText).toContain(SECRET_CODE);
  });
});

describe("the invitation bearer token never reaches the log", () => {
  it("is absent from the record even though the URL was sent", async () => {
    let sentText = "";
    const out = await sendWaitlistInvitationEmail({
      studio: STUDIO,
      invitationId: INVITATION_ID,
      recipientEmail: RECIPIENT,
      invitationUrl: URL,
      expiresInPhrase: "3 days",
      transport: {
        emails: {
          send: async (payload) => {
            sentText = payload.text;
            return ACCEPTED;
          },
        },
      },
    });
    expect(sentText).toContain(RAW_TOKEN); // it did go in the email
    const serialized = JSON.stringify(out.log);
    expect(serialized).not.toContain(RAW_TOKEN);
    expect(serialized).not.toContain(URL);
  });
});

describe("no console sink receives a secret", () => {
  it("neither send path writes the code or the token to console", async () => {
    // Belt-and-braces over the structural guarantee: if a future edit adds a
    // stray console.log of the payload, this catches it.
    const seen: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        seen.push(args.map((a) => String(a)).join(" "));
      });
    }

    await sendWaitlistInvitationEmail({
      studio: STUDIO,
      invitationId: INVITATION_ID,
      recipientEmail: RECIPIENT,
      invitationUrl: URL,
      expiresInPhrase: "3 days",
      transport: transportReturning(ACCEPTED),
    });
    await sendWaitlistRecipientProofEmail({
      studio: STUDIO,
      invitationId: INVITATION_ID,
      challengeId: CHALLENGE_ID,
      recipientEmail: RECIPIENT,
      code: SECRET_CODE,
      expiresAt: new Date(Date.now() + 20 * 60_000),
      action: "decline",
      transport: transportReturning(ACCEPTED),
    });

    const all = seen.join("\n");
    expect(all).not.toContain(SECRET_CODE);
    expect(all).not.toContain(RAW_TOKEN);
  });
});
