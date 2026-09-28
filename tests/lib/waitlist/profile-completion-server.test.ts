import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ProfileCompletionPatch } from "@/lib/waitlist/join-profile";

// ===========================================================================
// WAIT-04B — THE COMPLETION BINDING
// ===========================================================================
//
// The database decides validity, replay, expiry, revocation, lifecycle and the
// one-way mobile rule; 0202's DB suite proves all of that against a real
// database. What can only be proved HERE is what this module hands the command
// and what it hands back — specifically that a consent the system cannot honour
// never reaches the write, whatever the payload claims.

type Call = { fn: string; args: Record<string, unknown> };

const h: {
  calls: Call[];
  reply:
    | { kind: "data"; data: unknown }
    | { kind: "error" }
    | { kind: "throw" }
    | { kind: "construct_throw" };
} = { calls: [], reply: { kind: "data", data: "accepted" } };

vi.mock("@/lib/supabase/admin-server", () => ({
  // The factory itself can fail — that is the whole point of one of the cases
  // below, and it is the shape the module originally let escape.
  createAdminClient: () => {
    if (h.reply.kind === "construct_throw") {
      throw new Error("service-role key missing");
    }
    return {
      async rpc(fn: string, args: Record<string, unknown>) {
        h.calls.push({ fn, args });
        if (h.reply.kind === "throw") throw new Error("transport exploded");
        if (h.reply.kind !== "data") {
          return { data: null, error: { message: "boom" } };
        }
        return { data: h.reply.data, error: null };
      },
    };
  },
}));

const { completeWaitlistProfile, WAIT_04B_CAPABILITIES } = await import(
  "@/lib/waitlist/profile-completion-server"
);

const TOKEN = "tok_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const CORE = {
  firstName: "Ada",
  lastName: "Lovelace",
  treatmentAreaIds: ["chin", "neck"] as const,
  availabilityPreference: "weekdays" as const,
};

const PATCH_UNCHANGED: ProfileCompletionPatch = {
  ...CORE,
  treatmentAreaIds: [...CORE.treatmentAreaIds],
  mobileDisposition: "unchanged",
};

const PATCH_CANDIDATE: ProfileCompletionPatch = {
  ...CORE,
  treatmentAreaIds: [...CORE.treatmentAreaIds],
  mobileDisposition: "candidate_supplied",
  mobileCandidate: "647-555-1234",
};

const run = (over: Partial<Parameters<typeof completeWaitlistProfile>[0]> = {}) =>
  completeWaitlistProfile({
    capabilityToken: TOKEN,
    patch: PATCH_UNCHANGED,
    smsOperationalConsent: false,
    consentSource: "prospect_link",
    ...over,
  });

beforeEach(() => {
  h.calls = [];
  h.reply = { kind: "data", data: "accepted" };
});

describe("the capabilities this binding declares", () => {
  it("records SMS consent, because a STOP now reaches a waitlist entry", () => {
    // FLIPPED BY B2a, AND ONLY BY IT. The flag needs both halves: the six SMS
    // columns writable (0202) and an inbound STOP reaching the row. The second
    // arrived when `app/api/twilio/inbound-sms` began scanning
    // `waitlist_prospect_suppression_candidates()` and stamping through
    // `suppress_waitlist_prospects`.
    expect(WAIT_04B_CAPABILITIES.recordsSmsConsent).toBe(true);
  });

  it("still refuses to VERIFY a mobile, so sending stays closed", () => {
    // Recording consent honestly and being allowed to act on it are different
    // questions, and this slice answers only the first.
    //
    // THE REASON HAS MOVED, AND THE BEHAVIOUR HAS NOT. A writer for
    // `mobile_verified_at` DOES now exist in production -- 0203 was applied on
    // 2026-09-27 -- so "there is no writer" is no longer why this is false.
    // `prospectMayReceiveSms` still requires a verified destination, and no
    // possession proof can be obtained: the provider resolves FAIL-CLOSED by
    // default, the fake needs explicit injection, and no Verify Service exists.
    // A DB writer is not a verification mechanism.
    expect(WAIT_04B_CAPABILITIES.verifiesMobile).toBe(false);
  });

  it("verifies no mobile, so a candidate can never read as a destination", () => {
    expect(WAIT_04B_CAPABILITIES.verifiesMobile).toBe(false);
  });

  it("stores profile fields and supports the completion capability", () => {
    expect(WAIT_04B_CAPABILITIES.storesProfileFields).toBe(true);
    expect(WAIT_04B_CAPABILITIES.supportsCompletionCapability).toBe(true);
  });
});

describe("consent is forced, not forwarded", () => {
  it("forwards a true consent now that it can be honoured", async () => {
    await run({ smsOperationalConsent: true });
    expect(h.calls[0].args.p_sms_consent).toBe(true);
  });

  it("forwards a false consent as false", async () => {
    await run({ smsOperationalConsent: false });
    expect(h.calls[0].args.p_sms_consent).toBe(false);
  });

  it("is still GATED ON THE CAPABILITY, not hardcoded to forward", async () => {
    // THE LOAD-BEARING ASSERTION OF THIS FILE, AND IT SURVIVES THE FLIP.
    // While the capability was false this forced the argument false regardless
    // of payload, because the surface is client code and a consent rule must
    // not rest there. Now that it is true the same expression forwards — but
    // the expression must still BE a gate. Replacing it with a bare
    // `input.smsOperationalConsent` would pass every behavioural test above and
    // silently remove the protection the day the capability goes false again.
    const src = readFileSync(
      path.join(__dirname, "../../../lib/waitlist/profile-completion-server.ts"),
      "utf8",
    );
    expect(src).toMatch(
      /p_sms_consent:\s*WAIT_04B_CAPABILITIES\.recordsSmsConsent\s*\n?\s*\?\s*input\.smsOperationalConsent\s*\n?\s*:\s*false/,
    );
  });
});

describe("what reaches the command", () => {
  it("passes the token through and nothing derived from it", async () => {
    await run();
    const args = h.calls[0].args;
    expect(h.calls[0].fn).toBe("complete_waitlist_profile_by_grant");
    expect(args.p_raw_token).toBe(TOKEN);
    // No entry id, no email, no joined-at: the caller may not name the row, the
    // address or the queue position.
    for (const forbidden of ["p_entry_id", "p_email", "p_joined_at", "p_studio_id"]) {
      expect(args, forbidden).not.toHaveProperty(forbidden);
    }
  });

  it("sends a null candidate when the entry already holds a mobile", async () => {
    await run({ patch: PATCH_UNCHANGED });
    expect(h.calls[0].args.p_mobile_candidate).toBeNull();
  });

  it("sends the candidate only on the arm that carries one", async () => {
    await run({ patch: PATCH_CANDIDATE });
    expect(h.calls[0].args.p_mobile_candidate).toBe("647-555-1234");
  });

  it("sends NO verification parameter at all", async () => {
    // THE TITLE IS NOW TRUE BECAUSE THE ASSERTION WAS STRENGTHENED, not because it
    // was narrowed. Three revisions of this one test are worth recording:
    //
    //   1. "0202 has no writer for one" -- true until 0203 was applied.
    //   2. "the DATABASE supplies it" -- overclaimed; the test never checked where
    //      the instant came from.
    //   3. "sends NO verification parameter at all" -- STILL overclaimed against a
    //      `not.toMatch(/verified/i)` denylist, which `p_otp`, `p_proof` or
    //      `p_verification_code` would all sail through.
    //
    // A DENYLIST CANNOT SUPPORT A CLAIM ABOUT ABSENCE. So the argument set is
    // pinned exactly: any new parameter at all fails this, whatever it is called,
    // which is the only shape that makes "none" checkable. Where the verified
    // instant comes from remains a different property, proved against a real
    // database in tests/db/waitlist-mobile-verification-authority.db.test.ts.
    await run({ patch: PATCH_CANDIDATE });
    expect(Object.keys(h.calls[0].args).sort()).toEqual([
      "p_first_name",
      "p_last_name",
      "p_mobile_candidate",
      "p_preference",
      "p_raw_token",
      "p_sms_consent",
      "p_treatment_area_ids",
    ]);
  });
});

describe("result translation is closed and coarse", () => {
  it("accepted is the only success", async () => {
    h.reply = { kind: "data", data: "accepted" };
    expect(await run()).toEqual({ ok: true });
  });

  it("refused reports not_authorized, saying nothing about which failure it was", async () => {
    // Invalid, revoked, expired and already-redeemed all arrive here as
    // `refused`. Telling them apart would tell an anonymous holder that a token
    // was valid but spent, which is a disclosure about a named person.
    h.reply = { kind: "data", data: "refused" };
    expect(await run()).toEqual({ ok: false, code: "not_authorized" });
  });

  it("invalid_submission is distinct, because the person can fix it", async () => {
    h.reply = { kind: "data", data: "invalid_submission" };
    expect(await run()).toEqual({ ok: false, code: "invalid_submission" });
  });

  it("an UNRECOGNISED code is unavailable, never a refusal", async () => {
    // A code this module does not know means the module and the database
    // disagree. Rendering "not authorised" would accuse someone who may have
    // done nothing wrong, for a submission that may have committed.
    h.reply = { kind: "data", data: "some_new_code" };
    expect(await run()).toEqual({ ok: false, code: "unavailable" });
  });

  it("a transport error is IN DOUBT, not a refusal", async () => {
    h.reply = { kind: "error" };
    expect(await run()).toEqual({ ok: false, code: "unavailable" });
  });

  it("a thrown transport failure does not cross the boundary", async () => {
    h.reply = { kind: "throw" };
    await expect(run()).resolves.toEqual({ ok: false, code: "unavailable" });
  });

  it("a client that FAILS TO CONSTRUCT does not cross it either", async () => {
    // The admin client was built outside the try, so a missing service-role key
    // threw past every typed outcome in the module and out to the caller — on
    // the one path whose job is to report IN DOUBT rather than raise. The
    // construction is inside the boundary now, and this is what holds it there.
    h.reply = { kind: "construct_throw" };
    await expect(run()).resolves.toEqual({ ok: false, code: "unavailable" });
  });
});

describe("the capability token does not leak into the outcome", () => {
  it("no refusal or success value contains the token", async () => {
    for (const reply of [
      { kind: "data", data: "refused" },
      { kind: "data", data: "invalid_submission" },
      { kind: "data", data: "accepted" },
      { kind: "error" },
      { kind: "throw" },
    ] as const) {
      h.reply = reply;
      const out = await run();
      expect(JSON.stringify(out), JSON.stringify(reply)).not.toContain(TOKEN);
    }
  });
});
