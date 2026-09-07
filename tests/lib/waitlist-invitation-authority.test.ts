import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

// WAIT-03B B2 server authority. These prove the TRANSLATION layer: every closed
// database code maps to the right typed outcome, an UNRECOGNISED code fails
// closed rather than reading as success, and the bindings B2 owns (tenancy,
// recipient, scope) refuse before anything is consumed.

const rpc = vi.fn();
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({ rpc }),
}));

const getCurrentPractitionerWithStudio = vi.fn();
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: () => getCurrentPractitionerWithStudio(),
}));

const {
  authorizeInvitationForBooking,
  completeRecipientProof,
  consumeInvitationForBooking,
  contactHash,
  declineInvitation,
  expireInvitation,
  issueScopedInvitation,
  resolveInvitation,
  revokeInvitation,
} = await import("@/lib/booking/waitlist-invitation");

const TOKEN = "a".repeat(64);
const CAP = "b".repeat(64);
const CHALLENGE = "c".repeat(64);
const EMAIL = "chloe@example.test";
// Computed independently of the module under test, the way the accepted
// resolve_ command computes it: sha256(lower(btrim(email))).
const EMAIL_HASH = createHash("sha256").update(EMAIL, "utf8").digest("hex");

function liveRow(over: Record<string, unknown> = {}) {
  return [
    {
      result: "live",
      invitation_id: "inv-1",
      studio_id: "studio-1",
      entry_id: "entry-1",
      scope_service_id: "svc-1",
      scope_start_date: "2026-09-07",
      scope_end_date: "2026-09-20",
      scope_allowed_weekdays: null,
      expires_at: "2026-09-20T12:00:00Z",
      recipient_contact_hash: EMAIL_HASH,
      ...over,
    },
  ];
}

const AUTHORIZE_INPUT = {
  rawToken: TOKEN,
  studioId: "studio-1",
  studioTimezone: "America/Toronto",
  requestedServiceId: "svc-1",
  requestedStartsAt: new Date("2026-09-10T14:00:00Z"),
  submittedEmail: EMAIL,
};

beforeEach(() => {
  rpc.mockReset();
  getCurrentPractitionerWithStudio.mockReset();
});

describe("contact hashing matches the database's own derivation", () => {
  it("normalises case and surrounding whitespace before hashing", () => {
    expect(contactHash(`  ${EMAIL.toUpperCase()}  `)).toBe(EMAIL_HASH);
  });
  it("returns null for an absent or empty contact", () => {
    expect(contactHash(null)).toBeNull();
    expect(contactHash("   ")).toBeNull();
  });
});

describe("resolve — closed codes map, everything else is IN DOUBT", () => {
  it.each([
    "invalid_token",
    "already_redeemed",
    "declined",
    "released",
    "expired",
    "unscoped",
  ])("maps %s", async (code) => {
    rpc.mockResolvedValue({ data: [{ result: code }], error: null });
    expect((await resolveInvitation(TOKEN)).kind).toBe(code);
  });

  it("maps live to a fully-typed invitation", async () => {
    rpc.mockResolvedValue({ data: liveRow(), error: null });
    const out = await resolveInvitation(TOKEN);
    expect(out.kind).toBe("live");
    if (out.kind !== "live") throw new Error("unreachable");
    expect(out.invitation.studioId).toBe("studio-1");
    expect(out.invitation.scope.serviceId).toBe("svc-1");
    expect(out.invitation.scope.allowedWeekdays).toBeNull();
  });

  it("reads a weekday array back as numbers", async () => {
    rpc.mockResolvedValue({ data: liveRow({ scope_allowed_weekdays: ["1", "3"] }), error: null });
    const out = await resolveInvitation(TOKEN);
    if (out.kind !== "live") throw new Error("unreachable");
    expect(out.invitation.scope.allowedWeekdays).toEqual([1, 3]);
  });

  // A code this layer does not recognise must never be rendered as a refusal a
  // caller could act on, nor as a success.
  it("treats an unrecognised code as unavailable", async () => {
    rpc.mockResolvedValue({ data: [{ result: "something_new" }], error: null });
    expect((await resolveInvitation(TOKEN)).kind).toBe("unavailable");
  });

  it("treats a transport error as unavailable, not as invalid", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    expect((await resolveInvitation(TOKEN)).kind).toBe("unavailable");
  });

  it("refuses a malformed token without calling the database at all", async () => {
    expect((await resolveInvitation("nope")).kind).toBe("invalid_token");
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("booking authorisation — the bindings B2 owns", () => {
  it("authorises an in-scope request from the invited recipient", async () => {
    rpc.mockResolvedValue({ data: liveRow(), error: null });
    expect((await authorizeInvitationForBooking(AUTHORIZE_INPUT)).kind).toBe("authorized");
  });

  it("refuses an invitation belonging to another studio", async () => {
    rpc.mockResolvedValue({ data: liveRow({ studio_id: "studio-2" }), error: null });
    expect((await authorizeInvitationForBooking(AUTHORIZE_INPUT)).kind).toBe("wrong_studio");
  });

  // A browser-supplied email is NOT identity authority. It is accepted only when
  // it hashes to the stored invited contact.
  it("refuses a substituted email on an otherwise valid invitation", async () => {
    rpc.mockResolvedValue({ data: liveRow(), error: null });
    const out = await authorizeInvitationForBooking({
      ...AUTHORIZE_INPUT,
      submittedEmail: "someone.else@example.test",
    });
    expect(out.kind).toBe("recipient_mismatch");
  });

  it("accepts the invited address in a different case or with whitespace", async () => {
    rpc.mockResolvedValue({ data: liveRow(), error: null });
    const out = await authorizeInvitationForBooking({
      ...AUTHORIZE_INPUT,
      submittedEmail: `  ${EMAIL.toUpperCase()} `,
    });
    expect(out.kind).toBe("authorized");
  });

  it("refuses a service the offer does not cover", async () => {
    rpc.mockResolvedValue({ data: liveRow(), error: null });
    const out = await authorizeInvitationForBooking({
      ...AUTHORIZE_INPUT,
      requestedServiceId: "svc-2",
    });
    expect(out).toEqual({ kind: "scope_refused", reason: "service_not_in_scope" });
  });

  it("refuses a date outside the offer", async () => {
    rpc.mockResolvedValue({ data: liveRow(), error: null });
    const out = await authorizeInvitationForBooking({
      ...AUTHORIZE_INPUT,
      requestedStartsAt: new Date("2026-10-01T14:00:00Z"),
    });
    expect(out).toEqual({ kind: "scope_refused", reason: "date_after_scope" });
  });

  it.each(["already_redeemed", "declined", "released", "expired"])(
    "refuses a %s invitation and reports which lifecycle state it was in",
    async (code) => {
      rpc.mockResolvedValue({ data: [{ result: code }], error: null });
      expect(await authorizeInvitationForBooking(AUTHORIZE_INPUT)).toEqual({
        kind: "not_live",
        detail: code,
      });
    },
  );

  it("propagates in-doubt rather than converting it to a refusal", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    expect((await authorizeInvitationForBooking(AUTHORIZE_INPUT)).kind).toBe("unavailable");
  });

  // Authorisation must NOT consume anything: resolve_ is the only call it makes.
  it("consumes nothing — it calls only the read-only resolver", async () => {
    rpc.mockResolvedValue({ data: liveRow(), error: null });
    await authorizeInvitationForBooking(AUTHORIZE_INPUT);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][0]).toBe("resolve_new_client_waitlist_invitation");
  });
});

// P2-1. Consume can no longer be called with loose strings: it requires the
// BRANDED authorisation that only authorizeInvitationForBooking can mint, so the
// compiler enforces AUTHORISE -> THEN CONSUME. This fixture is therefore the only
// way to reach it, which is the point.
async function authorized() {
  rpc.mockResolvedValueOnce({ data: liveRow(), error: null });
  const out = await authorizeInvitationForBooking(AUTHORIZE_INPUT);
  if (out.kind !== "authorized") throw new Error("fixture: authorisation failed");
  return out;
}

describe("redeem — reachable only through authorisation", () => {
  it("carries the token AUTHORISATION validated, not a second caller-supplied one", async () => {
    const auth = await authorized();
    rpc.mockResolvedValue({
      data: [{ result: "redeemed", studio_id: "studio-1", entry_id: "entry-1" }],
      error: null,
    });
    await consumeInvitationForBooking(auth, CAP);
    const redeemCall = rpc.mock.calls.find(
      (c) => c[0] === "redeem_new_client_waitlist_invitation_verified",
    );
    expect(redeemCall?.[1]).toEqual({ p_raw_token: TOKEN, p_raw_capability: CAP });
  });

  it("refuses a missing capability without calling the redeem command", async () => {
    const auth = await authorized();
    rpc.mockClear();
    expect((await consumeInvitationForBooking(auth, "")).kind).toBe("proof_invalid");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses a malformed capability without calling the redeem command", async () => {
    const auth = await authorized();
    rpc.mockClear();
    expect((await consumeInvitationForBooking(auth, "short")).kind).toBe("proof_invalid");
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each(["proof_required", "proof_expired", "proof_invalid", "not_live", "invalid_token"])(
    "passes the database's %s through unchanged",
    async (code) => {
      const auth = await authorized();
      rpc.mockResolvedValue({ data: [{ result: code }], error: null });
      expect((await consumeInvitationForBooking(auth, CAP)).kind).toBe(code);
    },
  );

  it("maps a successful redemption", async () => {
    const auth = await authorized();
    rpc.mockResolvedValue({
      data: [{ result: "redeemed", studio_id: "studio-1", entry_id: "entry-1" }],
      error: null,
    });
    expect(await consumeInvitationForBooking(auth, CAP)).toEqual({
      kind: "redeemed",
      studioId: "studio-1",
      entryId: "entry-1",
    });
  });

  it("never reports a redemption for an unrecognised code", async () => {
    const auth = await authorized();
    rpc.mockResolvedValue({ data: [{ result: "surprise" }], error: null });
    expect((await consumeInvitationForBooking(auth, CAP)).kind).toBe("unavailable");
  });

  it("never reports a redemption when the row is missing its identifiers", async () => {
    const auth = await authorized();
    rpc.mockResolvedValue({ data: [{ result: "redeemed" }], error: null });
    expect((await consumeInvitationForBooking(auth, CAP)).kind).toBe("unavailable");
  });
});

describe("redeem — the ordering is enforced by the COMPILER, not by convention", () => {
  // These are type-level assertions. `npm run typecheck` covers tests, so if
  // consume ever accepts loose inputs again -- the exact shape P2-1 flagged --
  // the @ts-expect-error directives below become unused and TYPECHECK FAILS.
  // That makes this a real guard rather than a comment.
  it("rejects loose token/capability inputs at compile time", async () => {
    const auth = await authorized();
    rpc.mockResolvedValue({ data: [{ result: "not_live" }], error: null });

    // @ts-expect-error consume must not accept the old loose-object shape
    await consumeInvitationForBooking({ rawToken: TOKEN, rawCapability: CAP });

    // @ts-expect-error consume must not accept a hand-built "authorized" object
    await consumeInvitationForBooking({ kind: "authorized", invitation: null, rawToken: TOKEN }, CAP);

    // @ts-expect-error the capability is required, not optional
    await consumeInvitationForBooking(auth);

    // The branded value is the ONLY accepted first argument.
    expect((await consumeInvitationForBooking(auth, CAP)).kind).toBe("not_live");
  });
});

describe("decline — the same gate as redeem", () => {
  it("refuses without a capability, without calling the database", async () => {
    expect((await declineInvitation({ rawToken: TOKEN, rawCapability: "" })).kind).toBe(
      "proof_invalid",
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it("sends the capability to the two-argument command", async () => {
    rpc.mockResolvedValue({ data: [{ result: "declined", entry_id: "entry-1" }], error: null });
    await declineInvitation({ rawToken: TOKEN, rawCapability: CAP });
    expect(rpc).toHaveBeenCalledWith("decline_new_client_waitlist_invitation", {
      p_raw_token: TOKEN,
      p_raw_capability: CAP,
    });
  });
});

describe("capability acquisition — the TTL is the database's, not the caller's", () => {
  // B1.5c removed caller authority over the capability TTL. This layer must not
  // re-introduce it by quietly passing one.
  it("sends exactly two arguments to complete_, with no TTL among them", async () => {
    rpc.mockResolvedValue({
      data: [{ result: "verified", raw_capability: CAP, expires_at: "2026-09-10T12:30:00Z" }],
      error: null,
    });
    await completeRecipientProof(TOKEN, CHALLENGE);
    const [name, args] = rpc.mock.calls[0];
    expect(name).toBe("complete_waitlist_invitation_proof");
    expect(Object.keys(args as object).sort()).toEqual(["p_raw_challenge", "p_raw_token"]);
  });

  it.each(["wrong_challenge", "no_challenge", "challenge_expired", "too_many_attempts", "recipient_changed"])(
    "passes %s through",
    async (code) => {
      rpc.mockResolvedValue({ data: [{ result: code }], error: null });
      expect((await completeRecipientProof(TOKEN, CHALLENGE)).kind).toBe(code);
    },
  );

  it("refuses a malformed challenge without calling the database", async () => {
    expect((await completeRecipientProof(TOKEN, "nope")).kind).toBe("invalid_input");
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("issue / revoke / expire — studio and actor come from the session", () => {
  const session = {
    studio: { id: "studio-1" },
    practitioner: { user_id: "user-1" },
  };

  it("refuses to issue with no practitioner session, without calling the database", async () => {
    getCurrentPractitionerWithStudio.mockRejectedValue(new Error("no session"));
    expect(
      (
        await issueScopedInvitation({
          entryId: "entry-1",
          serviceId: "svc-1",
          startDate: "2026-09-07",
          endDate: "2026-09-20",
        })
      ).kind,
    ).toBe("not_authorized");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("passes the SESSION's studio and actor, which no caller can override", async () => {
    getCurrentPractitionerWithStudio.mockResolvedValue(session);
    rpc.mockResolvedValue({
      data: [{ result: "issued", raw_token: TOKEN, invitation_id: "inv-1" }],
      error: null,
    });
    await issueScopedInvitation({
      entryId: "entry-1",
      serviceId: "svc-1",
      startDate: "2026-09-07",
      endDate: "2026-09-20",
      allowedWeekdays: [1, 3],
    });
    const args = rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(args.p_studio_id).toBe("studio-1");
    expect(args.p_actor_user_id).toBe("user-1");
    expect(args.p_allowed_weekdays).toEqual([1, 3]);
  });

  it.each(["no_round_open", "round_full", "invalid_service", "invalid_weekdays", "invalid_scope_dates"])(
    "maps the issue refusal %s",
    async (code) => {
      getCurrentPractitionerWithStudio.mockResolvedValue(session);
      rpc.mockResolvedValue({ data: [{ result: code }], error: null });
      expect(
        (
          await issueScopedInvitation({
            entryId: "entry-1",
            serviceId: "svc-1",
            startDate: "2026-09-07",
            endDate: "2026-09-20",
          })
        ).kind,
      ).toBe(code);
    },
  );

  // Revoke and expire return a SCALAR text code, not a row.
  it.each([
    ["released", "released"],
    ["already_redeemed", "already_redeemed"],
    ["not_releasable", "not_releasable"],
  ])("maps the scalar revoke code %s", async (code, expected) => {
    getCurrentPractitionerWithStudio.mockResolvedValue(session);
    rpc.mockResolvedValue({ data: code, error: null });
    expect((await revokeInvitation({ entryId: "entry-1" })).kind).toBe(expected);
  });

  it("routes revoke to release_new_client_waitlist_entry — there is no revoke command", async () => {
    getCurrentPractitionerWithStudio.mockResolvedValue(session);
    rpc.mockResolvedValue({ data: "released", error: null });
    await revokeInvitation({ entryId: "entry-1" });
    expect(rpc.mock.calls[0][0]).toBe("release_new_client_waitlist_entry");
  });

  // not_expired is a CORRECT answer, not an error: the command refuses to expire
  // anything early, which is what stops it becoming a second revoke.
  it("preserves not_expired rather than treating it as a failure", async () => {
    getCurrentPractitionerWithStudio.mockResolvedValue(session);
    rpc.mockResolvedValue({ data: "not_expired", error: null });
    expect((await expireInvitation({ entryId: "entry-1" })).kind).toBe("not_expired");
  });

  it("treats an unrecognised lifecycle code as unavailable", async () => {
    getCurrentPractitionerWithStudio.mockResolvedValue(session);
    rpc.mockResolvedValue({ data: "who_knows", error: null });
    expect((await expireInvitation({ entryId: "entry-1" })).kind).toBe("unavailable");
  });
});
