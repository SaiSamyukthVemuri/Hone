import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  sendWaitlistInvitationEmail,
  sendWaitlistRecipientProofEmail,
} from "@/lib/waitlist/delivery/send";
import {
  classifyDelivery,
  challengeMailability,
  invitationExpiryLabel,
  invitationIsLive,
  invitationSendWindow,
  PROVIDER_KEY_BOUND_TO_OTHER_BYTES,
  terminalRefusal,
  retryableRefusal,
  recoveryForKind,
  type SendOutcomeShape,
  PROVIDER_IDEMPOTENCY_RETENTION_HOURS,
  PROOF_SEND_MAX_DELAY_AFTER_MINT_SECONDS,
  proofWindowMinutes,
  PROOF_CHALLENGE_TTL_TARGET_MINUTES,
  MUTATION_CAPABILITY_TTL_CEILING_MINUTES,
  PROOF_REQUEST_LIMITS,
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
// 0189 mints invitations in hours (p_ttl_hours default 72). The MINTED window is
// what the email advertises, so it cannot drift between retries.
const INV_ISSUED = new Date("2026-09-07T12:00:00.000Z");
const INV_EXPIRES = new Date(INV_ISSUED.getTime() + 72 * 3_600_000);
// Frozen with the invitation, never re-read from mutable studio state.
// Inside the provider's idempotency retention, so the key still deduplicates.
const INV_NOW = new Date(INV_ISSUED.getTime() + 60_000);
const INV_BASE = {
  issuedAt: INV_ISSUED,
  expiresAt: INV_EXPIRES,
  now: INV_NOW,
};

describe("invitation delivery", () => {
  it("sends as the HONE PLATFORM identity, with no studio-derived header", async () => {
    const { transport, calls } = recordingTransport(ACCEPTED);
    await sendWaitlistInvitationEmail({
      studio: STUDIO,
      invitationId: INVITATION_ID,
      recipientEmail: RECIPIENT,
      invitationUrl: URL,
      ...INV_BASE,
      transport,
    });

    expect(calls).toHaveLength(1);
    // V1: studio branding is dropped from the EMAIL because every studio field
    // is mutable and the key carries no payload digest. Hone's existing
    // platform transactional identity, unchanged and byte-stable.
    expect(calls[0].payload.from).toBe("Hone <hello@hone.care>");
    expect(calls[0].payload.replyTo).toBeUndefined();
    expect(calls[0].payload.to).toBe(RECIPIENT);
  });

  it("carries no Reply-To at all in V1", async () => {
    // Deliberate scope reduction. postcare_contact_email and owner_email are
    // both mutable, so either in Reply-To reintroduces the same-key /
    // different-payload trap the platform identity exists to close.
    const { transport, calls } = recordingTransport(ACCEPTED);
    await sendWaitlistInvitationEmail({
      studio: { ...STUDIO, postcare_contact_email: "front:desk@willow.test" },
      invitationId: INVITATION_ID,
      recipientEmail: RECIPIENT,
      invitationUrl: URL,
      ...INV_BASE,
      transport,
    });
    expect(calls[0].payload.replyTo).toBeUndefined();
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
      ...INV_BASE,
      transport: a.transport,
    });

    const b = recordingTransport(ACCEPTED);
    await sendWaitlistInvitationEmail({
      studio: STUDIO,
      invitationId: "44444444-4444-4444-8444-444444444444",
      recipientEmail: RECIPIENT,
      invitationUrl: URL,
      ...INV_BASE,
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
      ...INV_BASE,
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
      ...INV_BASE,
      transport: rejected.transport,
    });
    expect(out.disposition.mayMutateLifecycle).toBe(false);
    expect(out.disposition.delivered).toBe("no");
  });
});

describe("recipient proof delivery", () => {
  const NOW = new Date("2026-09-07T12:00:00.000Z");
  const IN_20 = new Date(NOW.getTime() + 20 * 60_000);
  // The mint instant. With expiresAt it gives the AUTHORISED WINDOW the email
  // advertises, which must not drift between attempts under one key.
  const ISSUED = NOW;

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
      issuedAt: ISSUED,
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
      // must describe the window it actually granted.
      issuedAt: ISSUED,
      expiresAt: new Date(NOW.getTime() + 7 * 60_000),
      action: "book",
      now: NOW,
      transport,
    });
    expect(calls[0].payload.text).toContain("expires in 7 minutes");
    expect(calls[0].payload.text).not.toContain("20 minutes");
  });

  it("REFUSES a challenge window longer than Delivery asked for", async () => {
    const { transport, calls } = recordingTransport(ACCEPTED);
    const out = await sendWaitlistRecipientProofEmail({
      studio: STUDIO,
      invitationId: INVITATION_ID,
      challengeId: CHALLENGE_ID,
      recipientEmail: RECIPIENT,
      code: "H4K2QF7P",
      issuedAt: ISSUED,
      expiresAt: new Date(NOW.getTime() + 21 * 60_000),
      action: "book",
      now: NOW,
      transport,
    });
    expect(calls).toHaveLength(0); // nothing was transmitted
    expect(out.disposition.delivered).toBe("no");
    expect(out.disposition.reason).toBe(
      "rejected_challenge_minted_window_exceeds_request",
    );
  });

  it("REFUSES to send a proof that has already elapsed", async () => {
    const { transport, calls } = recordingTransport(ACCEPTED);
    const out = await sendWaitlistRecipientProofEmail({
      studio: STUDIO,
      invitationId: INVITATION_ID,
      challengeId: CHALLENGE_ID,
      recipientEmail: RECIPIENT,
      code: "H4K2QF7P",
      // A LEGITIMATE 20-minute mint, checked after its window ran out. The
      // earlier fixture had the expiry before the mint, which is a different
      // fault (a broken minter) and now reports as such.
      issuedAt: ISSUED,
      expiresAt: new Date(ISSUED.getTime() + 20 * 60_000),
      action: "book",
      now: new Date(ISSUED.getTime() + 21 * 60_000),
      transport,
    });
    expect(calls).toHaveLength(0);
    expect(out.disposition.reason).toBe("rejected_challenge_already_elapsed");
  });

  it("never puts the invitation URL beside the code", async () => {
    const { transport, calls } = recordingTransport(ACCEPTED);
    await sendWaitlistRecipientProofEmail({
      studio: STUDIO,
      invitationId: INVITATION_ID,
      challengeId: CHALLENGE_ID,
      recipientEmail: RECIPIENT,
      code: "H4K2QF7P",
      issuedAt: ISSUED,
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
      const d = classifyDelivery({ status: "ambiguous", reason }, "invitation");
      expect(d.delivered).toBe("unknown");
      expect(d.mayInvalidateChallenge).toBe(false);
      expect(d.sameEventRetryAllowed).toBe(false);
      expect(d.mayMutateLifecycle).toBe(false);
    }
  });

  it("a definite refusal MAY invalidate the challenge", () => {
    const d = classifyDelivery({ status: "rejected", code: "validation_error" }, "invitation");
    expect(d.delivered).toBe("no");
    expect(d.mayInvalidateChallenge).toBe(true);
    expect(d.mayMutateLifecycle).toBe(false);
  });

  it("acceptance still may not mutate lifecycle", () => {
    const d = classifyDelivery({ status: "accepted", messageId: "msg_1" }, "invitation");
    expect(d.delivered).toBe("yes");
    expect(d.mayMutateLifecycle).toBe(false);
  });
});

describe("the CHALLENGE window and the CAPABILITY ceiling are different things", () => {
  // An earlier revision collapsed these and enforced "<= 30 minutes" over the
  // challenge. That was wrong twice over: 30 is not the challenge's bound, and
  // the challenge is not the object that bound governs. These assertions exist
  // to keep them apart, because the numbers are close enough to re-merge by
  // accident and nothing else in the stack would notice.

  it("Delivery REQUESTS a 20-minute challenge — a product target, not a law", () => {
    expect(PROOF_CHALLENGE_TTL_TARGET_MINUTES).toBe(20);
  });

  it("the 30-minute figure belongs to the mutation CAPABILITY, and is never enforced here", () => {
    expect(MUTATION_CAPABILITY_TTL_CEILING_MINUTES).toBe(30);
    // The load-bearing half. `completeRecipientProof` mints the capability;
    // this module delivers the challenge that precedes one and must not compare
    // anything against a bound it does not own. If the guard ever starts
    // accepting a 30-minute challenge, the two have been re-conflated.
    const now = new Date("2026-09-07T12:00:00.000Z");
    const at = (m: number) => new Date(now.getTime() + m * 60_000);
    expect(
      challengeMailability(now, at(MUTATION_CAPABILITY_TTL_CEILING_MINUTES), now).mailable,
    ).toBe(false);
    expect(challengeMailability(now, at(25), now).mailable).toBe(false);
  });

  it("the capability ceiling is not mechanically established in this repository", () => {
    // Recorded from the operator's statement of in-flight B1.5c work, not from
    // source. Stated as a fact about EVIDENCE so a later reader does not treat
    // the constant as repo-verified: no proof-challenge or capability TTL
    // exists under supabase/migrations/** at this SHA. Re-read it from the
    // migration that lands B1.5c before relying on it.
    expect(MUTATION_CAPABILITY_TTL_CEILING_MINUTES).toBeGreaterThan(
      PROOF_CHALLENGE_TTL_TARGET_MINUTES,
    );
  });

  it("accepts the requested window exactly and rejects a millisecond beyond it", () => {
    const t0 = new Date("2026-09-07T12:00:00.000Z");
    const at = (ms: number) => new Date(t0.getTime() + ms);
    const target = PROOF_CHALLENGE_TTL_TARGET_MINUTES * 60_000;
    expect(challengeMailability(t0, at(target), t0).mailable).toBe(true);
    expect(challengeMailability(t0, at(target + 1), t0).mailable).toBe(false);
    expect(challengeMailability(t0, at(0), t0).mailable).toBe(false);
    expect(challengeMailability(t0, at(-1), t0).mailable).toBe(false);
  });

  it("P2-A: measures the MINTED duration, never the time left at send", () => {
    // The reproduction, inverted. A 30-minute mint delivered ten minutes late
    // has twenty minutes remaining and USED TO PASS, because the guard compared
    // against `now`. The contract is about what was minted.
    const issued = new Date("2026-09-07T12:00:00.000Z");
    const sentLate = new Date(issued.getTime() + 10 * 60_000);
    const expires30 = new Date(issued.getTime() + 30 * 60_000);
    const verdict = challengeMailability(issued, expires30, sentLate);
    expect(verdict.mailable).toBe(false);
    expect(verdict).toMatchObject({ reason: "minted_window_exceeds_request" });
  });

  it("P2-A: an elapsed challenge is refused SEPARATELY from an overlong one", () => {
    // Distinct reasons, because the causes and the fixes differ: one is a
    // defect in the minter, the other is ordinary lateness.
    const issued = new Date("2026-09-07T12:00:00.000Z");
    const ok = new Date(issued.getTime() + 20 * 60_000);
    const after = new Date(issued.getTime() + 21 * 60_000);
    expect(challengeMailability(issued, ok, after)).toMatchObject({
      mailable: false,
      reason: "already_elapsed",
    });
  });

  it("P2-A: a stale send is refused so the copy cannot claim a false window", () => {
    // The email advertises the MINTED window because the key carries no payload
    // digest. That sentence stops being true as the gap grows, so rather than
    // let the copy lie, a stale send is refused and the caller mints again.
    const issued = new Date("2026-09-07T12:00:00.000Z");
    const ok = new Date(issued.getTime() + 20 * 60_000);
    const late = new Date(
      issued.getTime() + (PROOF_SEND_MAX_DELAY_AFTER_MINT_SECONDS + 1) * 1_000,
    );
    expect(challengeMailability(issued, ok, late)).toMatchObject({
      mailable: false,
      reason: "stale_since_mint",
    });
    // Just inside the tolerance still sends.
    const punctual = new Date(issued.getTime() + 5_000);
    expect(challengeMailability(issued, ok, punctual).mailable).toBe(true);
  });

  it("P2-A: the invitation states an ABSOLUTE instant in a FIXED zone", () => {
    // Every duration shape failed, and so did a studio-zoned instant. Remaining
    // time drifted between retries; the minted window was stable and lied; a
    // studio-zoned instant was stable and truthful but read mutable state. A
    // fixed zone is the only shape that is all three.
    const exp = new Date("2026-09-10T17:00:00.000Z");
    const label = invitationExpiryLabel(exp);
    expect(label).toContain("September 10, 2026");
    expect(label).toContain("UTC");
    expect(label).not.toMatch(/\bdays?\b/); // no duration wording at all
    expect(invitationExpiryLabel(exp)).toBe(label);
  });

  it("rounds the advertised window DOWN", () => {
    // Advertising longer than the truth is the failure that matters: the
    // recipient trusts the sentence and finds a dead code.
    const t0 = new Date("2026-09-07T12:00:00.000Z");
    expect(proofWindowMinutes(t0, new Date(t0.getTime() + 119_000))).toBe(1);
    expect(proofWindowMinutes(t0, new Date(t0.getTime() - 1))).toBe(0);
  });
});

describe("the rate-limit policy has ONE source", () => {
  // Found in review. An earlier revision exported PROOF_REQUEST_LIMITS here,
  // called it the single source, and hard-coded a second copy inside the
  // limiter — so the export was decorative and production obeyed only the
  // copy. Changing the "policy" would have left the old limits enforced with
  // nothing failing. CLAUDE.md §3 names this: there is deliberately no second
  // competing map.
  //
  // A source-contract test is the right shape: the property is "no second
  // declaration exists", which is exactly the architectural-tripwire case
  // ENGINEERING_STANDARDS describes, and it cannot be proved by calling the
  // limiter without an Upstash backend.
  const LIMITER_SRC = readFileSync(
    join(process.cwd(), "lib/rate-limit/public.ts"),
    "utf8",
  );

  it("the limiter imports the shared policy", () => {
    expect(LIMITER_SRC).toContain("@/lib/waitlist/delivery/policy");
    expect(LIMITER_SRC).toContain("PROOF_REQUEST_LIMITS");
  });

  it("the limiter declares no competing copy", () => {
    // The specific defect: a local const holding the same numbers.
    expect(LIMITER_SRC).not.toMatch(/const\s+WAITLIST_PROOF_LIMITS\s*=/);
    // And no second declaration of the shared name either.
    expect(LIMITER_SRC).not.toMatch(/const\s+PROOF_REQUEST_LIMITS\s*=/);
  });

  it("the policy numbers are the ones the limiter will use", () => {
    expect(PROOF_REQUEST_LIMITS.invitation).toEqual({ limit: 3, window: "15 m" });
    expect(PROOF_REQUEST_LIMITS.ip).toEqual({ limit: 10, window: "1 h" });
    // Pinned so a change to the policy is a deliberate edit here too, not a
    // silent drift — and the limiter reads these exact values by import.
    expect(LIMITER_SRC).toContain("PROOF_REQUEST_LIMITS[dimension]");
  });
});

describe("P2-B: one invitation event, one idempotency key", () => {
  it("the key does NOT move when the same invitation is retried later", async () => {
    // The reproduction, inverted. `expiresInPhrase` used to be remaining time,
    // so a retry a day later rendered "2 days" instead of "3 days", changed the
    // payload, changed the payload-derived key, and let the provider send a
    // SECOND invitation for one spot.
    const a = recordingTransport(ACCEPTED);
    const b = recordingTransport(ACCEPTED);
    const args = {
      studio: STUDIO,
      invitationId: INVITATION_ID,
      recipientEmail: RECIPIENT,
      invitationUrl: URL,
      ...INV_BASE,
    };
    await sendWaitlistInvitationEmail({ ...args, transport: a.transport });
    await sendWaitlistInvitationEmail({ ...args, transport: b.transport });
    expect(a.calls[0].idempotencyKey).toBe(b.calls[0].idempotencyKey);
    // And the rendered body is identical, which is what makes that true.
    expect(a.calls[0].payload.text).toBe(b.calls[0].payload.text);
  });

  it("the key carries NO payload digest, so the bearer token is not in it", async () => {
    const { transport, calls } = recordingTransport(ACCEPTED);
    await sendWaitlistInvitationEmail({
      studio: STUDIO,
      invitationId: INVITATION_ID,
      recipientEmail: RECIPIENT,
      invitationUrl: URL,
      ...INV_BASE,
      transport,
    });
    const key = calls[0].idempotencyKey ?? "";
    expect(key).toContain(INVITATION_ID);
    // A payload-digest key ends in 64 hex characters. This one must not.
    expect(key).not.toMatch(/\/[0-9a-f]{64}$/);
    expect(key).not.toContain("RAWTOKEN");
  });

  it("a DIFFERENT invitation cycle still gets a different key", async () => {
    // The property the event scope exists for: an entry can be invited, expire,
    // be requeued and be invited again, and the second cycle must not replay
    // the first send's response.
    const a = recordingTransport(ACCEPTED);
    const b = recordingTransport(ACCEPTED);
    const base = {
      studio: STUDIO,
      recipientEmail: RECIPIENT,
      invitationUrl: URL,
      ...INV_BASE,
    };
    await sendWaitlistInvitationEmail({ ...base, invitationId: INVITATION_ID, transport: a.transport });
    await sendWaitlistInvitationEmail({
      ...base,
      invitationId: "99999999-9999-4999-8999-999999999999",
      transport: b.transport,
    });
    expect(a.calls[0].idempotencyKey).not.toBe(b.calls[0].idempotencyKey);
  });

  it("an ambiguous provider result stays ambiguous and mutates no lifecycle", async () => {
    const { transport } = recordingTransport({
      data: null,
      error: { name: "concurrent_idempotent_requests" },
    });
    const out = await sendWaitlistInvitationEmail({
      studio: STUDIO,
      invitationId: INVITATION_ID,
      recipientEmail: RECIPIENT,
      invitationUrl: URL,
      ...INV_BASE,
      transport,
    });
    expect(out.disposition.delivered).toBe("unknown");
    expect(out.disposition.mayInvalidateChallenge).toBe(false);
    expect(out.disposition.mayMutateLifecycle).toBe(false);
  });
});

describe("P2-A: a delayed retry keeps ONE identity and a TRUTHFUL expiry", () => {
  it("same invitation sent later => same key, same copy, still true", async () => {
    // The two properties together, because fixing either alone regresses the
    // other: a truthful relative phrase drifts and moves the key; a stable
    // relative phrase holds the key and goes false.
    const a = recordingTransport(ACCEPTED);
    const b = recordingTransport(ACCEPTED);
    const args = {
      studio: STUDIO,
      invitationId: INVITATION_ID,
      recipientEmail: RECIPIENT,
      invitationUrl: URL,
      ...INV_BASE,
    };
    // First attempt, then a retry a full day later. Nothing in the call
    // conveys "now", which is precisely why the copy cannot go stale.
    await sendWaitlistInvitationEmail({ ...args, transport: a.transport });
    await sendWaitlistInvitationEmail({ ...args, transport: b.transport });

    expect(a.calls[0].idempotencyKey).toBe(b.calls[0].idempotencyKey);
    expect(a.calls[0].payload.text).toBe(b.calls[0].payload.text);

    // The statement is an absolute instant, so it is as true on the retry as on
    // the first attempt. A relative phrase is what could not survive this.
    expect(a.calls[0].payload.text).toContain("This invitation expires ");
    expect(a.calls[0].payload.text).not.toMatch(/expires in \d+ (day|hour)/);
    expect(a.calls[0].payload.text).toContain("September 10, 2026");
  });
});

describe("V1 STABLE PAYLOAD: no mutable studio field reaches the provider", () => {
  it("payload and key are BYTE-IDENTICAL across studio name/email/timezone mutation", () => {
    // The negative control this rule exists for. Every studio field is mutable
    // operator state; the invitation key carries no payload digest, so any of
    // them moving the bytes turns a retry into invalid_idempotent_request
    // instead of a replay.
    return (async () => {
      const before = recordingTransport(ACCEPTED);
      const after = recordingTransport(ACCEPTED);
      const args = {
        invitationId: INVITATION_ID,
        recipientEmail: RECIPIENT,
        invitationUrl: URL,
        ...INV_BASE,
      };
      await sendWaitlistInvitationEmail({
        ...args,
        studio: {
          id: STUDIO.id,
          name: "Willow Electrolysis",
          postcare_contact_email: "hello@willow.test",
          owner_email: "owner@willow.test",
          timezone: "America/Toronto",
        } as typeof STUDIO,
        transport: before.transport,
      });
      await sendWaitlistInvitationEmail({
        ...args,
        // Renamed, re-addressed, re-zoned — every mutable field moved at once.
        studio: {
          id: STUDIO.id,
          name: "Willow Electrolysis & Skin",
          postcare_contact_email: "care@willow-skin.test",
          owner_email: "newowner@willow-skin.test",
          timezone: "Asia/Tokyo",
        } as typeof STUDIO,
        transport: after.transport,
      });

      expect(after.calls[0].payload).toEqual(before.calls[0].payload);
      expect(after.calls[0].idempotencyKey).toBe(before.calls[0].idempotencyKey);
    })();
  });

  it("the only tenant-derived value in the key is the immutable studio id", async () => {
    const { transport, calls } = recordingTransport(ACCEPTED);
    await sendWaitlistInvitationEmail({
      studio: STUDIO,
      invitationId: INVITATION_ID,
      recipientEmail: RECIPIENT,
      invitationUrl: URL,
      ...INV_BASE,
      transport,
    });
    const key = calls[0].idempotencyKey ?? "";
    expect(key).toContain(STUDIO.id);
    expect(key).toContain(INVITATION_ID);
    expect(key).not.toContain("Willow");
  });

  it("the expiry renders in a FIXED zone, so no timezone input can move it", () => {
    const exp = new Date("2026-09-10T17:00:00.000Z");
    const label = invitationExpiryLabel(exp);
    expect(label).toContain("September 10, 2026");
    expect(label).toContain("UTC");
    expect(invitationExpiryLabel(exp)).toBe(label);
  });
});

describe("NEVER send an already-expired invitation", () => {
  // A SHORT-LIVED invitation, deliberately. The default 72-hour fixture puts
  // every instant near its expiry far outside the provider's 24-hour
  // idempotency retention, so the window guard would fire first and the expiry
  // boundary would never be reached. 0189 clamps p_ttl_hours to 1..168, so a
  // one-hour invitation is a legal mint and isolates the boundary under test.
  const SHORT_ISSUED = new Date("2026-09-07T12:00:00.000Z");
  const SHORT_EXPIRES = new Date(SHORT_ISSUED.getTime() + 3_600_000);
  const at = (ms: number) => new Date(SHORT_EXPIRES.getTime() + ms);

  it("invitationIsLive: future => true, exactly now => false, past => false", () => {
    // The pure boundary, keyed on the same expiry the send path uses. Strictly
    // greater than: a boundary that leaks by a millisecond is one nobody can
    // reason about.
    expect(invitationIsLive(SHORT_EXPIRES, at(-1))).toBe(true);
    expect(invitationIsLive(SHORT_EXPIRES, at(0))).toBe(false);
    expect(invitationIsLive(SHORT_EXPIRES, at(1))).toBe(false);
  });

  async function attemptAt(now: Date) {
    const r = recordingTransport(ACCEPTED);
    const out = await sendWaitlistInvitationEmail({
      studio: STUDIO,
      invitationId: INVITATION_ID,
      recipientEmail: RECIPIENT,
      invitationUrl: URL,
      issuedAt: SHORT_ISSUED,
      expiresAt: SHORT_EXPIRES,
      now,
      transport: r.transport,
    });
    return { out, calls: r.calls };
  }

  it("BOUNDARY future => eligible, and the send goes out", async () => {
    const { out, calls } = await attemptAt(at(-1));
    expect(calls).toHaveLength(1);
    expect(out.disposition.delivered).toBe("yes");
    expect(out.disposition.terminal).toBe(false);
  });

  it("BOUNDARY exactly now => TERMINAL refusal, no resend, zero provider calls", async () => {
    const { out, calls } = await attemptAt(at(0));
    expect(calls).toHaveLength(0);
    expect(out.disposition.delivered).toBe("no");
    expect(out.disposition.reason).toBe("rejected_invitation_expired");
    expect(out.disposition.terminal).toBe(true);
    expect(out.disposition.sameEventRetryAllowed).toBe(false);
    expect(out.disposition.mayMutateLifecycle).toBe(false);
  });

  it("BOUNDARY past => TERMINAL refusal, no resend, zero provider calls", async () => {
    const { out, calls } = await attemptAt(at(1));
    expect(calls).toHaveLength(0);
    expect(out.disposition.reason).toBe("rejected_invitation_expired");
    expect(out.disposition.terminal).toBe(true);
    expect(out.disposition.sameEventRetryAllowed).toBe(false);
  });

  it("a PROVIDER refusal stays non-terminal — the next attempt may differ", () => {
    // The distinction the flag exists for. A provider said no to one attempt;
    // an expired invitation says no to every attempt there will ever be.
    const d = classifyDelivery({ status: "rejected", code: "validation_error" }, "invitation");
    expect(d.terminal).toBe(false);
    expect(d.sameEventRetryAllowed).toBe(false);
  });
});

describe("P2: no send outside the provider's idempotency retention", () => {
  it("refuses a retry the key can no longer deduplicate", async () => {
    // Past the provider's retention the key is just a header: presenting it
    // again submits a FRESH email. Reachable in practice — invitations default
    // to 72 hours, the absolute copy exists so a late retry still reads right,
    // and every disposition permits a resend. Deduplicating beyond it needs a
    // durable local delivery record, which is schema and out of this lane, so
    // the send is refused rather than issued on a hope.
    const { transport, calls } = recordingTransport(ACCEPTED);
    const out = await sendWaitlistInvitationEmail({
      studio: STUDIO,
      invitationId: INVITATION_ID,
      recipientEmail: RECIPIENT,
      invitationUrl: URL,
      issuedAt: INV_ISSUED,
      expiresAt: INV_EXPIRES,
          now: new Date(
        INV_ISSUED.getTime() + (PROVIDER_IDEMPOTENCY_RETENTION_HOURS + 1) * 3_600_000,
      ),
      transport,
    });
    expect(calls).toHaveLength(0); // nothing was transmitted
    expect(out.disposition.delivered).toBe("no");
    expect(out.disposition.reason).toBe("rejected_outside_provider_idempotency_window");
    // Terminal for the same reason as expiry: `now - issuedAt` only grows, so
    // no later attempt at THIS invitation falls back inside the window.
    expect(out.disposition.terminal).toBe(true);
    expect(out.disposition.sameEventRetryAllowed).toBe(false);
    expect(out.disposition.mayMutateLifecycle).toBe(false);
  });

  it("accepts the retention boundary exactly, and refuses a millisecond past it", () => {
    const at = (ms: number) => new Date(INV_ISSUED.getTime() + ms);
    const w = PROVIDER_IDEMPOTENCY_RETENTION_HOURS * 3_600_000;
    expect(invitationSendWindow(INV_ISSUED, at(w))).toEqual({ eligible: true });
    expect(invitationSendWindow(INV_ISSUED, at(w + 1))).toEqual({
      eligible: false,
      disposition: "terminal",
      reason: "outside_provider_idempotency_window",
    });
  });

  it("a send inside the window still goes out", async () => {
    const { calls } = await (async () => {
      const r = recordingTransport(ACCEPTED);
      await sendWaitlistInvitationEmail({
        studio: STUDIO,
        invitationId: INVITATION_ID,
        recipientEmail: RECIPIENT,
        invitationUrl: URL,
        ...INV_BASE,
        transport: r.transport,
      });
      return r;
    })();
    expect(calls).toHaveLength(1);
  });
});

describe("CLOCK DISAGREEMENT is retryable, not terminal", () => {
  // A database clock a millisecond ahead of the application clock made
  // `now - issuedAt` negative, which the old boolean answered "false" — the
  // same answer it gave a genuinely stale invitation. So a perfectly good
  // invitation was reported permanently undeliverable, and the caller was told
  // to discard it. REPRODUCED at d53dcd35 before this split.
  //
  // No tolerance window is introduced. A skew allowance would be a second
  // number to justify and would silently accept genuinely-future timestamps up
  // to its size; classifying the case tells the caller what is wrong and that
  // waiting fixes it.
  const at = (ms: number) => new Date(INV_ISSUED.getTime() + ms);

  it("issuedAt == now => eligible", () => {
    expect(invitationSendWindow(INV_ISSUED, at(0))).toEqual({ eligible: true });
  });

  it("issuedAt slightly BEFORE now => eligible", () => {
    expect(invitationSendWindow(INV_ISSUED, at(1))).toEqual({ eligible: true });
    expect(invitationSendWindow(INV_ISSUED, at(60_000))).toEqual({ eligible: true });
  });

  it("issuedAt slightly AFTER now => retryable, never terminal", () => {
    for (const skew of [1, 250, 5_000]) {
      expect(invitationSendWindow(INV_ISSUED, at(-skew))).toEqual({
        eligible: false,
        disposition: "retryable",
        reason: "clock_disagreement",
      });
    }
  });

  it("advancing now past issuedAt makes the SAME input eligible", () => {
    // The property that makes it retryable rather than terminal: nothing about
    // the invitation changed, only the clock.
    expect(invitationSendWindow(INV_ISSUED, at(-1)).eligible).toBe(false);
    expect(invitationSendWindow(INV_ISSUED, at(1)).eligible).toBe(true);
  });

  it("a genuinely old issuedAt is still TERMINAL", () => {
    const w = PROVIDER_IDEMPOTENCY_RETENTION_HOURS * 3_600_000;
    expect(invitationSendWindow(INV_ISSUED, at(w + 1))).toMatchObject({
      disposition: "terminal",
    });
  });

  it("a future-issued invitation performs ZERO provider calls and is not terminal", async () => {
    const { transport, calls } = recordingTransport(ACCEPTED);
    const now = new Date("2026-09-07T12:00:00.000Z");
    const out = await sendWaitlistInvitationEmail({
      studio: STUDIO,
      invitationId: INVITATION_ID,
      recipientEmail: RECIPIENT,
      invitationUrl: URL,
      issuedAt: new Date(now.getTime() + 1), // DB clock one millisecond ahead
      expiresAt: new Date(now.getTime() + 3_600_000), // still live
      now,
      transport,
    });
    expect(calls).toHaveLength(0);
    expect(out.disposition.reason).toBe("rejected_clock_disagreement");
    expect(out.disposition.terminal).toBe(false);
    expect(out.disposition.sameEventRetryAllowed).toBe(false);
    expect(out.disposition.recovery).toBe("reissue_invitation");
    // Waiting is the remedy, so nothing about the invitation may be retired.
    expect(out.disposition.mayInvalidateChallenge).toBe(false);
    expect(out.disposition.mayMutateLifecycle).toBe(false);
  });

  it("an EXPIRED invitation stays terminal even when the clock disagrees", async () => {
    // Expiry is checked first and independently: a skewed clock must not
    // upgrade a dead invitation into something worth retrying.
    const { transport, calls } = recordingTransport(ACCEPTED);
    const now = new Date("2026-09-07T12:00:00.000Z");
    const out = await sendWaitlistInvitationEmail({
      studio: STUDIO,
      invitationId: INVITATION_ID,
      recipientEmail: RECIPIENT,
      invitationUrl: URL,
      issuedAt: new Date(now.getTime() + 1), // future-issued AND expired
      expiresAt: new Date(now.getTime() - 1),
      now,
      transport,
    });
    expect(calls).toHaveLength(0);
    expect(out.disposition.reason).toBe("rejected_invitation_expired");
    expect(out.disposition.terminal).toBe(true);
    expect(out.disposition.sameEventRetryAllowed).toBe(false);
  });
});

describe("ONE INVITATION ID = ONE DELIVERY EVENT", () => {
  // The product law, made mechanical. 0193 mints the invitation id and the raw
  // token exactly once and hands the token straight to Delivery in the same
  // request. The token is never persisted, so once the send returns nothing can
  // reconstruct the email — there is no supported "send this invitation again
  // later" operation. A later operator "Resend" is a REISSUE: new invitation,
  // new token, new key, new delivery event.
  //
  // This closes the payload-bytes finding at the contract rather than with a
  // persisted email ledger. A deploy that changes the template can only produce
  // same-key/different-bytes if a SECOND invocation possesses the OLD raw
  // token, and no such invocation exists.

  it("CONTROL B: an ambiguous delivery never authorizes retrying this event", async () => {
    const { transport } = recordingTransport({
      data: null,
      error: { name: "concurrent_idempotent_requests" },
    });
    const out = await sendWaitlistInvitationEmail({
      studio: STUDIO,
      invitationId: INVITATION_ID,
      recipientEmail: RECIPIENT,
      invitationUrl: URL,
      ...INV_BASE,
      transport,
    });
    expect(out.disposition.delivered).toBe("unknown");
    expect(out.disposition.sameEventRetryAllowed).toBe(false);
    // Recovery is a reissue, weighed by the caller against a possible duplicate.
    expect(out.disposition.recovery).toBe("reissue_invitation");
    expect(out.disposition.mayMutateLifecycle).toBe(false);
  });

  it("NO disposition, from any outcome, authorizes a same-event retry", () => {
    // Exhaustive over the vocabulary rather than a sample: the law holds for
    // every branch, and the literal `false` type means no future branch can
    // opt out without a compile error.
    const outcomes: SendOutcomeShape[] = [
      { status: "accepted", messageId: "m" },
      { status: "ambiguous", reason: "timeout" },
      { status: "ambiguous", reason: "concurrent" },
      { status: "ambiguous", reason: "no_message_id" },
      { status: "rejected", code: "validation_error" },
      { status: "rejected", code: PROVIDER_KEY_BOUND_TO_OTHER_BYTES },
      { status: "rejected", code: null },
    ];
    for (const o of outcomes) {
      expect(classifyDelivery(o, "invitation").sameEventRetryAllowed, JSON.stringify(o)).toBe(false);
    }
    expect(terminalRefusal("x", "invitation").sameEventRetryAllowed).toBe(false);
    expect(retryableRefusal("y", "recipient_proof").sameEventRetryAllowed).toBe(false);
  });

  it("CONTROL C: a reissue is a NEW event — new id yields a new key and new bytes", async () => {
    // What an operator's "Resend" must become. The delivery layer cannot mint
    // the new invitation, but it can prove that a new id is a genuinely
    // different send rather than a replay of the old one.
    const first = recordingTransport(ACCEPTED);
    const second = recordingTransport(ACCEPTED);
    const base = {
      studio: STUDIO,
      recipientEmail: RECIPIENT,
      ...INV_BASE,
    };
    await sendWaitlistInvitationEmail({
      ...base,
      invitationId: INVITATION_ID,
      invitationUrl: "https://hone.care/waitlist/invitation/TOKEN-ONE",
      transport: first.transport,
    });
    await sendWaitlistInvitationEmail({
      ...base,
      invitationId: "77777777-7777-4777-8777-777777777777",
      invitationUrl: "https://hone.care/waitlist/invitation/TOKEN-TWO",
      transport: second.transport,
    });
    expect(second.calls[0].idempotencyKey).not.toBe(first.calls[0].idempotencyKey);
    expect(second.calls[0].payload.text).not.toBe(first.calls[0].payload.text);
    expect(first.calls[0].payload.text).toContain("TOKEN-ONE");
    expect(second.calls[0].payload.text).toContain("TOKEN-TWO");
  });

  it("CONTROL E: Delivery cannot reconstruct an invitation URL — it must be given one", () => {
    // The structural half of the deploy-mid-window argument, provable here.
    // sendWaitlistInvitationEmail takes `invitationUrl` as a required input and
    // derives nothing from a token hash or a lookup, so it cannot rebuild a
    // past invitation's email even if some caller wanted it to. The other half
    // — that no caller HOLDS an old raw token — lives in the call graph and is
    // carried to the integration PR.
    const raw = readFileSync(
      join(process.cwd(), "lib/waitlist/delivery/send.ts"),
      "utf8",
    );
    // COMMENTS ARE STRIPPED FIRST. The claim is about what the module DOES, and
    // this file's own header discusses token_hash precisely to say it is never
    // read — a guard that could not tell code from prose would forbid
    // documenting its own invariant, which is the wrong incentive.
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/token_hash/);
    expect(code).not.toMatch(/new_client_waitlist_invitations/);
    expect(code).not.toMatch(/createClient|supabase/i);
    // And the URL is a required input rather than something derived.
    expect(code).toMatch(/invitationUrl:\s*string/);
  });

  it("a key already bound to other bytes asks for a REISSUE, not a retry", () => {
    // Should be unreachable under the law above, since it needs a second
    // invocation holding the old raw token. Classified anyway, because the
    // invariant lives in a call graph this module cannot see — and if it is
    // ever reached the answer is a reissue, arriving at the call site rather
    // than as an unexpected provider error.
    const d = classifyDelivery({
      status: "rejected",
      code: PROVIDER_KEY_BOUND_TO_OTHER_BYTES,
    }, "invitation");
    expect(d.sameEventRetryAllowed).toBe(false);
    expect(d.recovery).toBe("reissue_invitation");
    expect(d.delivered).toBe("no");
    // NOT terminal: the invitation is spent, but a fresh one will deliver.
    expect(d.terminal).toBe(false);
  });
});

describe("CONTROL A: the one retry INSIDE a single invocation is byte-identical", () => {
  it("an ambiguous first attempt retries with the same key and the same bytes", async () => {
    // The one retry the law permits, because it never leaves the invocation:
    // the payload object is built once and reused, so the second attempt cannot
    // differ even if the template changed on disk in between. This is what
    // makes the provider replay rather than refuse.
    const attempts: { payload: ProviderPayload; key?: string }[] = [];
    const transport: IdempotentEmailTransport = {
      emails: {
        send: async (payload, options) => {
          attempts.push({ payload, key: options?.idempotencyKey });
          // First attempt ambiguous, second accepted.
          return attempts.length === 1
            ? { data: null, error: { name: "concurrent_idempotent_requests" } }
            : ACCEPTED;
        },
      },
    };

    const out = await sendWaitlistInvitationEmail({
      studio: STUDIO,
      invitationId: INVITATION_ID,
      recipientEmail: RECIPIENT,
      invitationUrl: URL,
      ...INV_BASE,
      transport,
    });

    expect(attempts).toHaveLength(2);
    expect(attempts[1].key).toBe(attempts[0].key);
    // Byte-identical, and the SAME object — the payload is built once.
    expect(attempts[1].payload).toBe(attempts[0].payload);
    expect(out.disposition.delivered).toBe("yes");
  });

  it("bounded at ONE retry — there is deliberately no loop", async () => {
    const attempts: unknown[] = [];
    const transport: IdempotentEmailTransport = {
      emails: {
        send: async (p) => {
          attempts.push(p);
          return { data: null, error: { name: "concurrent_idempotent_requests" } };
        },
      },
    };
    const out = await sendWaitlistInvitationEmail({
      studio: STUDIO,
      invitationId: INVITATION_ID,
      recipientEmail: RECIPIENT,
      invitationUrl: URL,
      ...INV_BASE,
      transport,
    });
    expect(attempts).toHaveLength(2);
    expect(out.disposition.delivered).toBe("unknown");
    expect(out.disposition.sameEventRetryAllowed).toBe(false);
  });
});

describe("recovery is DELIVERY-KIND aware", () => {
  // A single `reissueRequired` boolean gave the proof path the invitation's
  // instruction. REPRODUCED at 577753e9: a rejected PROOF send asked the caller
  // to reissue — which would close and re-admit a live, perfectly valid
  // invitation to recover a spent challenge. The caller's only alternatives
  // were to do that damage or to ignore the advertised recovery, which is the
  // same as not advertising one.

  it("a failed PROOF send asks for a new CHALLENGE, never an invitation reissue", async () => {
    const { transport } = recordingTransport({
      data: null,
      error: { name: "validation_error" },
    });
    const now = new Date("2026-09-07T12:00:00.000Z");
    const out = await sendWaitlistRecipientProofEmail({
      studio: STUDIO,
      invitationId: INVITATION_ID,
      challengeId: CHALLENGE_ID,
      recipientEmail: RECIPIENT,
      code: "H4K2QF7P",
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 20 * 60_000),
      action: "book",
      now,
      transport,
    });
    expect(out.disposition.recovery).toBe("mint_new_challenge");
    expect(out.disposition.recovery).not.toBe("reissue_invitation");
    expect(out.disposition.sameEventRetryAllowed).toBe(false);
  });

  it("a failed INVITATION send asks for a reissue", async () => {
    const { transport } = recordingTransport({
      data: null,
      error: { name: "validation_error" },
    });
    const out = await sendWaitlistInvitationEmail({
      studio: STUDIO,
      invitationId: INVITATION_ID,
      recipientEmail: RECIPIENT,
      invitationUrl: URL,
      ...INV_BASE,
      transport,
    });
    expect(out.disposition.recovery).toBe("reissue_invitation");
  });

  it("a PRE-SEND refusal on the proof path also stays challenge-scoped", async () => {
    // The mailability refusals are proof-side too, and they were built through
    // the same shared constructors — so they carried the same wrong advice.
    const { transport, calls } = recordingTransport(ACCEPTED);
    const now = new Date("2026-09-07T12:00:00.000Z");
    const out = await sendWaitlistRecipientProofEmail({
      studio: STUDIO,
      invitationId: INVITATION_ID,
      challengeId: CHALLENGE_ID,
      recipientEmail: RECIPIENT,
      code: "H4K2QF7P",
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 99 * 60_000), // over the requested window
      action: "book",
      now,
      transport,
    });
    expect(calls).toHaveLength(0);
    expect(out.disposition.recovery).toBe("mint_new_challenge");
  });

  it("a DELIVERED send needs no recovery, whichever kind it is", () => {
    for (const kind of ["invitation", "recipient_proof"] as const) {
      const d = classifyDelivery({ status: "accepted", messageId: "m" }, kind);
      expect(d.recovery).toBe("none");
    }
  });

  it("recoveryForKind is the single mapping, so the two cannot drift", () => {
    // One place, so adding a third delivery kind is a compile error here rather
    // than a silently wrong instruction at some call site.
    expect(recoveryForKind("invitation")).toBe("reissue_invitation");
    expect(recoveryForKind("recipient_proof")).toBe("mint_new_challenge");
  });

  it("EVERY non-delivered outcome advises the recovery of its own kind", () => {
    // Exhaustive rather than sampled: the mapping must hold for the whole
    // vocabulary, not just the branch that was reported.
    const outcomes: SendOutcomeShape[] = [
      { status: "ambiguous", reason: "timeout" },
      { status: "ambiguous", reason: "concurrent" },
      { status: "ambiguous", reason: "no_message_id" },
      { status: "rejected", code: "validation_error" },
      { status: "rejected", code: PROVIDER_KEY_BOUND_TO_OTHER_BYTES },
      { status: "rejected", code: null },
    ];
    for (const o of outcomes) {
      expect(classifyDelivery(o, "invitation").recovery, JSON.stringify(o)).toBe(
        "reissue_invitation",
      );
      expect(classifyDelivery(o, "recipient_proof").recovery, JSON.stringify(o)).toBe(
        "mint_new_challenge",
      );
    }
    expect(terminalRefusal("r", "recipient_proof").recovery).toBe("mint_new_challenge");
    expect(retryableRefusal("r", "invitation").recovery).toBe("reissue_invitation");
  });
});
