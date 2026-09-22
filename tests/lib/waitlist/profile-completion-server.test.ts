import { beforeEach, describe, expect, it, vi } from "vitest";
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
  it("records no SMS consent, because no STOP reaches a waitlist entry", () => {
    // The flag is not a preference. `app/api/twilio/inbound-sms` suppresses
    // `clients` and never touches `new_client_waitlist_entries`, so the
    // withdrawal half of consent does not exist for a prospect.
    expect(WAIT_04B_CAPABILITIES.recordsSmsConsent).toBe(false);
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
  it("sends p_sms_consent false even when the payload says true", async () => {
    // THE LOAD-BEARING ASSERTION OF THIS FILE. The surface already withholds
    // the question, but the surface is client code. If the guarantee rested
    // there, a forged post — or one future call site that forgot the prop —
    // would write consent evidence for an agreement the system cannot honour.
    await run({ smsOperationalConsent: true });
    expect(h.calls[0].args.p_sms_consent).toBe(false);
  });

  it("sends false when the payload says false", async () => {
    await run({ smsOperationalConsent: false });
    expect(h.calls[0].args.p_sms_consent).toBe(false);
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
