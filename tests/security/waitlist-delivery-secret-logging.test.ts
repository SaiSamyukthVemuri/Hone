import { describe, expect, it, vi, afterEach } from "vitest";
import { createHash } from "crypto";
import { buildWaitlistRecipientProofEmail } from "@/lib/email/templates/waitlist-recipient-proof";
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
      issuedAt: new Date(),
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
      issuedAt: new Date(),
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
      issuedAt: new Date(),
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
      issuedAt: new Date(),
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
      issuedAt: new Date("2026-09-07T12:00:00.000Z"),
      expiresAt: new Date("2026-09-10T12:00:00.000Z"),
      expiryTimezone: "America/Toronto",
      now: new Date("2026-09-07T12:01:00.000Z"),
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
      issuedAt: new Date("2026-09-07T12:00:00.000Z"),
      expiresAt: new Date("2026-09-10T12:00:00.000Z"),
      expiryTimezone: "America/Toronto",
      now: new Date("2026-09-07T12:01:00.000Z"),
      transport: transportReturning(ACCEPTED),
    });
    await sendWaitlistRecipientProofEmail({
      studio: STUDIO,
      invitationId: INVITATION_ID,
      challengeId: CHALLENGE_ID,
      recipientEmail: RECIPIENT,
      code: SECRET_CODE,
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 20 * 60_000),
      action: "decline",
      transport: transportReturning(ACCEPTED),
    });

    const all = seen.join("\n");
    expect(all).not.toContain(SECRET_CODE);
    expect(all).not.toContain(RAW_TOKEN);
  });
});

// ===========================================================================
// THE PROVIDER IDEMPOTENCY HEADER IS A SINK TOO
// ===========================================================================
//
// Found in review, and reproduced before it was fixed. `sendWaitlistEmailIdempotent`
// normally keys on SHA-256 of the exact payload — and the payload IS the email
// body, so the digest was computed over the proof code and then transmitted to
// the provider in the `Idempotency-Key` header, where it is retained.
//
// That digest is not opaque. Every other field (from, to, subject, template
// copy, the authorised window) is deterministic and knowable, so an attacker
// holding the header can enumerate a small code space offline — render, hash,
// compare — until it matches. The original reproduction recovered an
// eight-character code from the header alone.
//
// The fix is `payloadCarriesSecret`, which switches the proof send to a key
// derived from the challenge id with NO payload digest. These are the negative
// controls that keep it fixed: the first fails if the code ever re-enters the
// digest, the second is the actual attack and must find nothing.
describe("the proof code never reaches the provider idempotency header", () => {
  const NOW = new Date("2026-09-07T12:00:00.000Z");
  const EXP = new Date(NOW.getTime() + 20 * 60_000);

  async function keyFor(code: string): Promise<string> {
    let key = "";
    await sendWaitlistRecipientProofEmail({
      studio: STUDIO,
      invitationId: INVITATION_ID,
      challengeId: CHALLENGE_ID,
      recipientEmail: RECIPIENT,
      code,
      issuedAt: NOW,
      expiresAt: EXP,
      action: "book",
      now: NOW,
      transport: {
        emails: {
          send: async (_payload, options) => {
            key = options?.idempotencyKey ?? "";
            return ACCEPTED;
          },
        },
      },
    });
    return key;
  }

  it("the transmitted key is IDENTICAL for two different codes", async () => {
    // The direct inversion of the reproduction. Before the fix these differed,
    // which is precisely what made the header a verifier for the secret.
    const a = await keyFor("AAAAAAAA");
    const b = await keyFor("ZZZZ9999");
    expect(a).toBe(b);
    expect(a).not.toContain("AAAAAAAA");
    expect(a).not.toContain("ZZZZ9999");
  });

  it("the key is the challenge identity, and carries no payload digest", async () => {
    const key = await keyFor("H4K2QF7P");
    expect(key).toContain(CHALLENGE_ID);
    expect(key).toContain(STUDIO.id);
    // A payload-digest key ends in 64 hex characters. This one must not.
    expect(key).not.toMatch(/\/[0-9a-f]{64}$/);
  });

  it("THE ATTACK: a captured key cannot be brute-forced back to the code", async () => {
    // The reproduction, kept as a standing control. It renders every candidate
    // exactly as the send path does and hashes it the way the payload-digest
    // key would. Finding a match would mean the secret is recoverable from a
    // header the provider stores.
    const captured = await keyFor("CODE0007");
    const digest = captured.split("/").pop() ?? "";
    let recovered = "";
    for (let i = 0; i < 32; i++) {
      const guess = `CODE${String(i).padStart(4, "0")}`;
      const e = buildWaitlistRecipientProofEmail({
        studioName: STUDIO.name,
        code: guess,
        windowMinutes: 20,
        action: "book",
      });
      const fields = [
        "Willow Electrolysis via Hone <hello@hone.care>",
        RECIPIENT,
        e.subject,
        e.html,
        e.text,
        "hello@willow.test",
      ];
      const canon = fields.map((f) => `${f.length}:${f}`).join("");
      if (createHash("sha256").update(canon, "utf8").digest("hex") === digest) {
        recovered = guess;
        break;
      }
    }
    expect(recovered).toBe("");
  });

  it("refuses to send rather than fall back to hashing the secret", async () => {
    // FAIL CLOSED. A credential-bearing payload with no event scope has nothing
    // else to key on; silently reverting to the payload digest would reintroduce
    // the defect at exactly the call site that asked not to.
    const { sendWaitlistEmailIdempotent } = await import(
      "@/lib/email/new-client-waitlist-send"
    );
    const out = await sendWaitlistEmailIdempotent({
      namespace: "client",
      studioId: STUDIO.id,
      eventScope: null,
      payloadCarriesSecret: true,
      to: RECIPIENT,
      subject: "s",
      html: `<p>${SECRET_CODE}</p>`,
      text: SECRET_CODE,
      transport: transportReturning(ACCEPTED),
    });
    expect(out).toEqual({ status: "rejected", code: "missing_event_scope" });
  });
});

describe("the existing payload-digest key identity is unchanged", () => {
  it("a send without the flag still keys on the payload digest", async () => {
    // The new shape is OPT-IN. Every existing caller — the WAIT-02
    // notification path included — must keep its exact key, or honest
    // resubmissions start being refused as invalid_idempotent_request.
    const { sendWaitlistEmailIdempotent, waitlistIdempotencyKey } = await import(
      "@/lib/email/new-client-waitlist-send"
    );
    let key = "";
    await sendWaitlistEmailIdempotent({
      namespace: "studio",
      studioId: STUDIO.id,
      to: RECIPIENT,
      subject: "s",
      html: "<p>h</p>",
      text: "t",
      transport: {
        emails: {
          send: async (_p, o) => {
            key = o?.idempotencyKey ?? "";
            return ACCEPTED;
          },
        },
      },
    });
    expect(key).toBe(
      waitlistIdempotencyKey("studio", STUDIO.id, {
        from: "Hone <hello@hone.care>",
        to: RECIPIENT,
        subject: "s",
        html: "<p>h</p>",
        text: "t",
      }),
    );
    expect(key).toMatch(/\/[0-9a-f]{64}$/);
  });
});
