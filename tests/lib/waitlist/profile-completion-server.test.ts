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
    // questions. This slice answers only the first; `prospectMayReceiveSms`
    // still requires a verified destination and there is still no writer for
    // `mobile_verified_at`.
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

  it("never sends a verification instant — 0202 has no writer for one", async () => {
    await run({ patch: PATCH_CANDIDATE });
    const keys = Object.keys(h.calls[0].args).join(",");
    expect(keys).not.toMatch(/verified/i);
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
