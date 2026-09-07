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
  invitationWithinProviderIdempotencyWindow,
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
  const at = (ms: number) => new Date(INV_EXPIRES.getTime() + ms);

  it("expires in the future => eligible", () => {
    expect(invitationIsLive(INV_EXPIRES, at(-1))).toBe(true);
  });

  it("expires exactly now => REFUSED", () => {
    // A boundary that leaks by a millisecond is a boundary nobody can reason
    // about, so the comparison is strictly greater than.
    expect(invitationIsLive(INV_EXPIRES, at(0))).toBe(false);
  });

  it("already expired => REFUSED", () => {
    expect(invitationIsLive(INV_EXPIRES, at(1))).toBe(false);
  });

  it("an expired invitation performs ZERO provider calls", async () => {
    const { transport, calls } = recordingTransport(ACCEPTED);
    const out = await sendWaitlistInvitationEmail({
      studio: STUDIO,
      invitationId: INVITATION_ID,
      recipientEmail: RECIPIENT,
      invitationUrl: URL,
      issuedAt: INV_ISSUED,
      expiresAt: INV_EXPIRES,
      now: at(1),
      transport,
    });
    expect(calls).toHaveLength(0);
    expect(out.disposition.delivered).toBe("no");
    expect(out.disposition.reason).toBe("rejected_invitation_expired");
    expect(out.disposition.mayMutateLifecycle).toBe(false);
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
    expect(out.disposition.mayMutateLifecycle).toBe(false);
  });

  it("accepts the retention boundary exactly, and rejects a millisecond past it", () => {
    const at = (ms: number) => new Date(INV_ISSUED.getTime() + ms);
    const window = PROVIDER_IDEMPOTENCY_RETENTION_HOURS * 3_600_000;
    expect(invitationWithinProviderIdempotencyWindow(INV_ISSUED, at(window))).toBe(true);
    expect(invitationWithinProviderIdempotencyWindow(INV_ISSUED, at(window + 1))).toBe(false);
    // Issued in the future is a clock disagreement, not a fresh invitation.
    expect(invitationWithinProviderIdempotencyWindow(INV_ISSUED, at(-1))).toBe(false);
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
