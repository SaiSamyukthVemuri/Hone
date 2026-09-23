import { beforeEach, describe, expect, it, vi } from "vitest";
import { WAIT_INVITATION_TTL_HOURS } from "@/lib/waitlist/invitation-window";

// ===========================================================================
// LEVEL 3 — A FIXED 48-HOUR OPPORTUNITY, PROVED AT THE WIRE
// ===========================================================================
//
// WHY THIS FILE EXISTS BESIDE THE SOURCE CENSUS. `invitation-window.test.ts`
// greps the call sites; a grep proves the argument is WRITTEN, not that 48 is
// what a command would RECEIVE. Both matter and they fail differently: a
// refactor that routes issuance through a helper keeps the census green while
// changing the value, and a behavioural test that only ever drives one path
// misses the other. So the census covers shape and this covers value, and both
// name BOTH issuance paths explicitly.
//
// #748 IS THE REASON THE BAR IS THIS HIGH. It shipped the right number as a
// DEFAULT and the product stayed wrong, because the composer went on offering
// 24/48/72/168/custom beside it. A default is not a policy.
// ===========================================================================

const rpc = vi.fn();
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({ rpc }),
}));

const getCurrentPractitionerWithStudio = vi.fn();
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: () => getCurrentPractitionerWithStudio(),
}));

const sessionActor = vi.fn();
vi.mock("@/lib/booking/session-actor", () => ({
  sessionActor: () => sessionActor(),
}));

const { admissionCommandAdapter } = await import("@/lib/waitlist/invite-to-book-adapter");
const { issueScopedInvitation, resolveInvitation } = await import(
  "@/lib/booking/waitlist-invitation"
);

beforeEach(() => {
  rpc.mockReset();
  getCurrentPractitionerWithStudio.mockReset();
  sessionActor.mockReset();
  getCurrentPractitionerWithStudio.mockResolvedValue({
    practitioner: { role: "owner", user_id: "user-1" },
    studio: { id: "studio-1", name: "Studio", timezone: "UTC", slug: "studio" },
  });
  sessionActor.mockResolvedValue({ studioId: "studio-1", actorUserId: "user-1" });
});

/** The argument object the module under test actually sent to PostgREST. */
function ttlSentTo(command: string): unknown {
  const call = rpc.mock.calls.find(([name]) => name === command);
  expect(call, `${command} was never called — the assertion below would be vacuous`).toBeTruthy();
  return (call![1] as Record<string, unknown>).p_ttl_hours;
}

describe("the window the product issues", () => {
  it("is 48, and that is the constant the module exports", () => {
    expect(WAIT_INVITATION_TTL_HOURS).toBe(48);
  });

  it("LIVE PATH — inviteToBook sends p_ttl_hours = 48", async () => {
    rpc.mockResolvedValue({ data: [{ result: "admitted", raw_token: "t".repeat(64) }], error: null });

    await admissionCommandAdapter.inviteToBook({
      entryId: "11111111-1111-4111-8111-111111111111",
      scope: { serviceId: "svc-1", windowDays: 14, allowedWeekdays: null },
    });

    expect(ttlSentTo("admit_new_client_waitlist_entry")).toBe(48);
  });

  it("DORMANT PATH — issueScopedInvitation sends p_ttl_hours = 48 too", async () => {
    // THE PATH NOBODY WOULD NOTICE. Nothing outside tests calls this today, so
    // a wrong window here is invisible until the surface that uses it ships —
    // and then two surfaces issue different opportunities with nothing
    // comparing them. It previously read `?? 72`, then `?? TTL_HOURS_DEFAULT`.
    rpc.mockResolvedValue({
      data: [{ result: "issued", raw_token: "t".repeat(64), invitation_id: "inv-1" }],
      error: null,
    });

    await issueScopedInvitation({
      entryId: "22222222-2222-4222-8222-222222222222",
      serviceId: "svc-1",
      startDate: "2026-09-22",
      endDate: "2026-10-06",
    });

    expect(ttlSentTo("issue_scoped_new_client_waitlist_invitation")).toBe(48);
  });

  it("NEITHER PATH ACCEPTS A CALLER-SUPPLIED WINDOW", async () => {
    // The strongest form available in TypeScript's absence at runtime: a caller
    // that forges the retired argument must still produce 48. If either
    // signature ever re-grows the parameter, this fails rather than silently
    // honouring it.
    rpc.mockResolvedValue({ data: [{ result: "admitted", raw_token: "t".repeat(64) }], error: null });
    await admissionCommandAdapter.inviteToBook({
      entryId: "33333333-3333-4333-8333-333333333333",
      scope: { serviceId: "svc-1", windowDays: 14, allowedWeekdays: null },
      // @ts-expect-error — the field is gone from the contract; forged on purpose.
      expiresInHours: 168,
    });
    expect(ttlSentTo("admit_new_client_waitlist_entry")).toBe(48);

    rpc.mockReset();
    rpc.mockResolvedValue({
      data: [{ result: "issued", raw_token: "t".repeat(64), invitation_id: "inv-1" }],
      error: null,
    });
    await issueScopedInvitation({
      entryId: "44444444-4444-4444-8444-444444444444",
      serviceId: "svc-1",
      startDate: "2026-09-22",
      endDate: "2026-10-06",
      // @ts-expect-error — the parameter is gone; forged on purpose.
      ttlHours: 1,
    });
    expect(ttlSentTo("issue_scoped_new_client_waitlist_invitation")).toBe(48);
  });
});

describe("AN ALREADY-ISSUED INVITATION KEEPS ITS OWN STORED EXPIRY", () => {
  it("resolve reports the stored expires_at verbatim, even when it is not 48h away", async () => {
    // THE MIGRATION-SHAPED RISK THIS SLICE MUST NOT TAKE. Invitations issued
    // before the policy carry 24, 72 or 168-hour windows in `expires_at`. The
    // fixed window governs ISSUANCE only; a live invitation is governed by the
    // row, and nothing in the application may recompute it.
    //
    // The date below is deliberately ~7 days out — a window this product can no
    // longer issue — so a recomputation to 48h would change the value and fail.
    const STORED = "2026-09-28T09:00:00Z";
    rpc.mockResolvedValue({
      data: [
        {
          result: "live",
          invitation_id: "inv-1",
          studio_id: "studio-1",
          entry_id: "entry-1",
          scope_service_id: "svc-1",
          scope_start_date: "2026-09-07",
          scope_end_date: "2026-09-20",
          scope_allowed_weekdays: null,
          expires_at: STORED,
          recipient_contact_hash: "f".repeat(64),
        },
      ],
      error: null,
    });

    const out = await resolveInvitation("a".repeat(64));
    expect(out.kind).toBe("live");
    if (out.kind !== "live") throw new Error("unreachable");
    expect(
      out.invitation.expiresAt,
      "a stored expiry was recomputed from the fixed window",
    ).toBe(STORED);

    // AND THE WINDOW IT IMPLIES IS ONE THIS PRODUCT CAN NO LONGER ISSUE, which
    // is what makes the assertion above load-bearing rather than incidental.
    const hours =
      (Date.parse(out.invitation.expiresAt) - Date.parse("2026-09-21T09:00:00Z")) / 3_600_000;
    expect(hours).toBeGreaterThan(WAIT_INVITATION_TTL_HOURS);
  });
});

describe("THE OTHER TWO CLOCKS ARE NOT THIS CLOCK", () => {
  // The brief's sharpest constraint: proof-challenge expiry and capability
  // expiry are SEPARATE and must not become 48 hours. They are measured in
  // MINUTES, so a unit slip would be far more damaging than a value slip.
  it("the proof challenge is still minutes, and is not the invitation window", async () => {
    rpc.mockResolvedValue({
      data: [{ result: "issued", raw_challenge: "c".repeat(64), challenge_id: "cid", expires_at: "2026-09-21T09:20:00Z" }],
      error: null,
    });
    const { beginRecipientProof } = await import("@/lib/booking/waitlist-invitation");
    await beginRecipientProof("a".repeat(64));

    const call = rpc.mock.calls.find(([n]) => n === "begin_waitlist_invitation_proof");
    expect(call, "the proof command was never called").toBeTruthy();
    const args = call![1] as Record<string, unknown>;
    // It takes MINUTES and must not have been handed the invitation's hours.
    expect(args.p_ttl_minutes).toBeTypeOf("number");
    expect(args.p_ttl_hours, "the proof clock grew an hours argument").toBeUndefined();
    expect(args.p_ttl_minutes).not.toBe(WAIT_INVITATION_TTL_HOURS);
    expect(args.p_ttl_minutes as number).toBeLessThanOrEqual(60);
  });

  it("the capability cookie is still 30 minutes in source, not 48 hours", async () => {
    // Read from source: the cookie's max-age is set inside a server action that
    // a unit test cannot drive without a request context, and the value is the
    // whole assertion.
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const file = path.resolve(
      __dirname,
      "../../../app/invitation/[token]/actions.ts",
    );
    const code = readFileSync(file, "utf8");
    expect(code, "the capability clock is not where this test thinks").toMatch(
      /CAPABILITY_COOKIE_MAX_AGE_SECONDS\s*=\s*30\s*\*\s*60/,
    );
    expect(code).not.toMatch(/CAPABILITY_COOKIE_MAX_AGE_SECONDS\s*=\s*48/);
    expect(code).not.toContain("WAIT_INVITATION_TTL_HOURS");
  });
});
