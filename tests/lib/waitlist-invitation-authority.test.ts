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
  beginRecipientProof,
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
const CHALLENGE_ID = "9f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
const ISSUED_AT = "2026-09-10T12:05:00Z";
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

// Codex P2. `undefined` was accepted alongside SQL NULL and normalised to
// `allowedWeekdays: null`, which means UNRESTRICTED. A row that never stated a
// weekday authority — a contract drift, a renamed column, a projection that
// forgot the field — therefore widened a restricted offer to every day, silently
// and precisely when the response was least trustworthy.
describe("resolve — a missing weekday authority is not an absent restriction", () => {
  it("explicit SQL NULL is accepted, and still means unrestricted", async () => {
    rpc.mockResolvedValue({ data: liveRow({ scope_allowed_weekdays: null }), error: null });
    const out = await resolveInvitation(TOKEN);
    if (out.kind !== "live") throw new Error(`expected live, got ${out.kind}`);
    expect(out.invitation.scope.allowedWeekdays).toBeNull();
  });

  it("a valid weekday array is accepted exactly", async () => {
    rpc.mockResolvedValue({ data: liveRow({ scope_allowed_weekdays: [1, 3] }), error: null });
    const out = await resolveInvitation(TOKEN);
    if (out.kind !== "live") throw new Error("unreachable");
    expect(out.invitation.scope.allowedWeekdays).toEqual([1, 3]);
  });

  it("an OMITTED scope_allowed_weekdays is unavailable, not unrestricted", async () => {
    const row = liveRow()[0] as Record<string, unknown>;
    delete row.scope_allowed_weekdays;
    expect("scope_allowed_weekdays" in row).toBe(false);
    rpc.mockResolvedValue({ data: [row], error: null });
    expect((await resolveInvitation(TOKEN)).kind).toBe("unavailable");
  });

  it("an explicit undefined is unavailable — absence is not SQL NULL", async () => {
    rpc.mockResolvedValue({
      data: liveRow({ scope_allowed_weekdays: undefined }),
      error: null,
    });
    expect((await resolveInvitation(TOKEN)).kind).toBe("unavailable");
  });

  it.each([
    ["a Postgres array literal string", "{1,3}"],
    ["a comma string", "1,3"],
    ["a bare number", 1],
    ["an object", { 0: 1 }],
    ["an array with a NULL element", [1, null]],
    ["an array with a boolean", [true]],
  ])("a malformed weekday authority (%s) is unavailable", async (_l, bad) => {
    rpc.mockResolvedValue({ data: liveRow({ scope_allowed_weekdays: bad }), error: null });
    expect((await resolveInvitation(TOKEN)).kind).toBe("unavailable");
  });

  // The defect stated as the property it violated.
  it("a RESTRICTED invitation cannot become unrestricted because the field vanished", async () => {
    // First: the restriction is real and is carried.
    rpc.mockResolvedValue({ data: liveRow({ scope_allowed_weekdays: [1] }), error: null });
    const restricted = await resolveInvitation(TOKEN);
    if (restricted.kind !== "live") throw new Error("unreachable");
    expect(restricted.invitation.scope.allowedWeekdays).toEqual([1]);

    // Now the same invitation, with the authority missing from the response.
    const row = liveRow()[0] as Record<string, unknown>;
    delete row.scope_allowed_weekdays;
    rpc.mockResolvedValue({ data: [row], error: null });
    const drifted = await resolveInvitation(TOKEN);

    // It must NOT come back live-and-unrestricted. Anything else is a widening.
    expect(drifted.kind).not.toBe("live");
    expect(JSON.stringify(drifted)).not.toContain("allowedWeekdays");
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

describe("begin proof — the code the delivery layer has to send", () => {
  // The accepted SQL has always returned raw_challenge; this wrapper used to
  // discard it, which left the delivery layer with a challenge it could not
  // send. Surfacing it is a TypeScript change only.
  function challengeRow(over: Record<string, unknown> = {}) {
    return [
      {
        result: "challenge_issued",
        raw_challenge: CHALLENGE,
        challenge_id: CHALLENGE_ID,
        issued_at: ISSUED_AT,
        delivery_contact: EMAIL,
        expires_at: "2026-09-10T12:20:00Z",
        ...over,
      },
    ];
  }

  it("surfaces the raw challenge to the caller", async () => {
    rpc.mockResolvedValue({ data: challengeRow(), error: null });
    const out = await beginRecipientProof(TOKEN);
    expect(out.kind).toBe("challenge_issued");
    if (out.kind !== "challenge_issued") throw new Error("unreachable");
    expect(out.rawChallenge).toBe(CHALLENGE);
  });

  it("carries the DB-owned expiry through untouched, never a recomputed one", async () => {
    rpc.mockResolvedValue({ data: challengeRow(), error: null });
    const out = await beginRecipientProof(TOKEN);
    if (out.kind !== "challenge_issued") throw new Error("unreachable");
    expect(out.expiresAt).toBe("2026-09-10T12:20:00Z");
  });

  it("returns the code EXACTLY ONCE — it is not copied into another field", async () => {
    rpc.mockResolvedValue({ data: challengeRow(), error: null });
    const out = await beginRecipientProof(TOKEN);
    if (out.kind !== "challenge_issued") throw new Error("unreachable");
    const occurrences = Object.entries(out).filter(([, v]) => v === CHALLENGE);
    expect(occurrences.map(([k]) => k)).toEqual(["rawChallenge"]);
    // And it must not have leaked into the masked contact shown to a browser.
    expect(out.maskedContact).not.toContain(CHALLENGE);
  });

  it("never writes the code, or anything derived from it, to a log", async () => {
    const lines: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((lvl) =>
      vi.spyOn(console, lvl).mockImplementation((...a: unknown[]) => {
        lines.push(a.map(String).join(" "));
      }),
    );
    rpc.mockResolvedValue({ data: challengeRow(), error: null });
    await beginRecipientProof(TOKEN);
    for (const sp of spies) sp.mockRestore();
    const joined = lines.join("\n");
    expect(joined).not.toContain(CHALLENGE);
    // The code space is small, so a hash or a prefix is an offline verifier,
    // not a redaction. Neither may appear either.
    expect(joined).not.toContain(createHash("sha256").update(CHALLENGE).digest("hex"));
    expect(joined).not.toContain(CHALLENGE.slice(0, 8));
  });

  // 0192 mints the challenge its own non-secret id. Delivery keys its proof-send
  // idempotency on THIS, so that nothing is ever derived from the code.
  it("surfaces the challenge's own non-secret id", async () => {
    rpc.mockResolvedValue({ data: challengeRow(), error: null });
    const out = await beginRecipientProof(TOKEN);
    if (out.kind !== "challenge_issued") throw new Error("unreachable");
    expect(out.proofChallengeId).toBe(CHALLENGE_ID);
  });

  it("keeps the id and the code as independent values", async () => {
    rpc.mockResolvedValue({ data: challengeRow(), error: null });
    const out = await beginRecipientProof(TOKEN);
    if (out.kind !== "challenge_issued") throw new Error("unreachable");
    // The identity must not BE the code, nor anything derived from it: a digest
    // over a small code space is an offline verifier, and a prefix is a head
    // start. This pins that the id is independent, not a transform.
    expect(out.proofChallengeId).not.toBe(out.rawChallenge);
    expect(out.proofChallengeId).not.toContain(out.rawChallenge.slice(0, 8));
    const digest = createHash("sha256").update(out.rawChallenge).digest("hex");
    expect(out.proofChallengeId).not.toBe(digest);
    expect(digest).not.toContain(out.proofChallengeId);
  });

  it("never leaks the id into the browser-facing projection", async () => {
    rpc.mockResolvedValue({ data: challengeRow(), error: null });
    const out = await beginRecipientProof(TOKEN);
    if (out.kind !== "challenge_issued") throw new Error("unreachable");
    // maskedContact is the ONLY field of this variant B3 renders.
    expect(out.maskedContact).not.toContain(out.proofChallengeId);
    expect(out.maskedContact).not.toContain(out.rawChallenge);
  });

  // 0192 now returns the instant it minted the challenge. B2 CONSUMES that value;
  // it must never reconstruct one.
  it("maps the database's issued_at onto issuedAt", async () => {
    rpc.mockResolvedValue({ data: challengeRow(), error: null });
    const out = await beginRecipientProof(TOKEN);
    if (out.kind !== "challenge_issued") throw new Error("unreachable");
    expect(out.issuedAt).toBe(ISSUED_AT);
  });

  it("takes it from the ROW, never derived from expiresAt", async () => {
    // A row whose issued_at is deliberately NOT expiresAt-minus-any-TTL. If the
    // wrapper were reconstructing the instant, it could not produce this value.
    rpc.mockResolvedValue({
      data: challengeRow({ issued_at: "2020-01-01T00:00:00Z" }),
      error: null,
    });
    const out = await beginRecipientProof(TOKEN);
    if (out.kind !== "challenge_issued") throw new Error("unreachable");
    expect(out.issuedAt).toBe("2020-01-01T00:00:00Z");
    expect(out.expiresAt).toBe("2026-09-10T12:20:00Z");
  });

  it("uses no application clock — a frozen system time changes nothing", async () => {
    const realNow = Date.now;
    Date.now = () => 0;
    try {
      rpc.mockResolvedValue({ data: challengeRow(), error: null });
      const out = await beginRecipientProof(TOKEN);
      if (out.kind !== "challenge_issued") throw new Error("unreachable");
      expect(out.issuedAt).toBe(ISSUED_AT);
    } finally {
      Date.now = realNow;
    }
  });

  it.each([null, undefined, 12345])(
    "is unavailable when issued_at is %s — never half-issued",
    async (bad) => {
      rpc.mockResolvedValue({
        data: challengeRow({ issued_at: bad }),
        error: null,
      });
      expect((await beginRecipientProof(TOKEN)).kind).toBe("unavailable");
    },
  );

  it("the new field is server-only: it is not the code and not the id", async () => {
    rpc.mockResolvedValue({ data: challengeRow(), error: null });
    const out = await beginRecipientProof(TOKEN);
    if (out.kind !== "challenge_issued") throw new Error("unreachable");
    // maskedContact is the ONLY field of this variant a browser is shown.
    expect(out.maskedContact).not.toContain(out.issuedAt);
    expect(out.maskedContact).not.toContain(out.rawChallenge);
    expect(out.maskedContact).not.toContain(out.proofChallengeId);
    // And the additions did not disturb the secrets' own separation.
    expect(out.rawChallenge).not.toBe(out.proofChallengeId);
    expect(out.issuedAt).not.toBe(out.rawChallenge);
  });

  // Codex P2. `str()` only proved the value was a STRING, so "not-a-date" passed
  // straight through and became `issuedAt: "not-a-date"` on a challenge_issued
  // outcome -- a fail-closed contract handing the delivery layer a mint time it
  // could not use.
  it("returns a valid instant EXACTLY as the database spelled it", async () => {
    // These are the forms OBSERVED from the local stack: to_json(timestamptz)
    // is what PostgREST emits, and it is always T-separated with seconds and an
    // explicit offset, with a microsecond fraction only when non-zero. Each must
    // survive byte for byte -- this module does not re-spell an instant.
    for (const raw of [
      "2026-09-08T17:28:32.375192+00:00",
      "2026-09-10T12:05:00+00:00",
      "2026-09-10T08:05:00-04:00",
      "2026-09-10T12:05:00Z",
      // The whole fraction range PostgreSQL can emit: none, and 1 through 6.
      "2026-09-10T12:05:00.1+00:00",
      "2026-09-10T12:05:00.12+00:00",
      "2026-09-10T12:05:00.123+00:00",
      "2026-09-10T12:05:00.1234+00:00",
      "2026-09-10T12:05:00.12345+00:00",
      "2026-09-10T12:05:00.123456+00:00",
    ]) {
      rpc.mockResolvedValue({ data: challengeRow({ issued_at: raw }), error: null });
      const out = await beginRecipientProof(TOKEN);
      if (out.kind !== "challenge_issued") throw new Error(`rejected a valid instant: ${raw}`);
      expect(out.issuedAt).toBe(raw);
    }
  });

  it.each([
    ["the first reported case", "not-a-date"],
    ["empty string", ""],
    ["whitespace only", "   "],
    ["a bare word", "yesterday"],
    ["a lone number as text", "0"],
    ["truncated", "2026-09-"],
    // Codex P2 #2: Date.parse NORMALISES these rather than refusing them.
    ["Feb 30 — a date that does not exist", "2026-02-30T12:00:00Z"],
    ["Feb 30 with a real offset", "2026-02-30T12:00:00+00:00"],
    ["Nov 31", "2026-11-31T12:00:00+00:00"],
    ["Feb 29 in a non-leap year", "2026-02-29T12:00:00+00:00"],
    ["month 13", "2026-13-01T12:00:00+00:00"],
    ["month 00", "2026-00-10T12:00:00+00:00"],
    ["day 00", "2026-09-00T12:00:00+00:00"],
    ["hour 99", "2026-09-10T99:05:00+00:00"],
    ["hour 24", "2026-09-10T24:00:00+00:00"],
    ["minute 60", "2026-09-10T12:60:00+00:00"],
    ["second 60", "2026-09-10T12:05:60+00:00"],
    // Incomplete serialisations a timestamptz never produces.
    ["no seconds", "2026-09-10T12:05"],
    ["no seconds, with offset", "2026-09-10T12:05+00:00"],
    ["no timezone", "2026-09-10T12:05:00"],
    ["date only", "2026-09-10"],
    ["space separator instead of T", "2026-09-10 12:05:00+00:00"],
    ["bare +00 offset, not +00:00", "2026-09-10T12:05:00+00"],
    ["two-digit year", "26-09-10T12:05:00+00:00"],
    // Codex P2 #3: an unbounded fraction let this through, because Date.parse
    // TRUNCATES excess precision instead of refusing it. PostgreSQL stores
    // microseconds, so seven digits is not a value this contract can carry.
    ["7 fractional digits", "2026-09-08T17:28:32.1234567+00:00"],
    ["9 fractional digits", "2026-09-08T17:28:32.123456789+00:00"],
    ["7 fractional digits with Z", "2026-09-08T17:28:32.1234567Z"],
    ["a trailing dot with no digits", "2026-09-08T17:28:32.+00:00"],
  ])("refuses a malformed issued_at (%s) as unavailable", async (_label, bad) => {
    rpc.mockResolvedValue({ data: challengeRow({ issued_at: bad }), error: null });
    expect((await beginRecipientProof(TOKEN)).kind).toBe("unavailable");
  });

  it("ACCEPTS Feb 29 in a real leap year — the calendar check is not a blanket ban", async () => {
    rpc.mockResolvedValue({
      data: challengeRow({ issued_at: "2028-02-29T12:00:00+00:00" }),
      error: null,
    });
    const out = await beginRecipientProof(TOKEN);
    if (out.kind !== "challenge_issued") throw new Error("a real leap day was rejected");
    expect(out.issuedAt).toBe("2028-02-29T12:00:00+00:00");
  });

  it("refuses a missing or non-string issued_at", async () => {
    for (const bad of [null, undefined, 12345, {}, []]) {
      rpc.mockResolvedValue({ data: challengeRow({ issued_at: bad }), error: null });
      expect((await beginRecipientProof(TOKEN)).kind).toBe("unavailable");
    }
  });

  it("does NOT substitute a clock when the value is malformed", async () => {
    // The refusal must be a refusal, not a silent repair.
    rpc.mockResolvedValue({ data: challengeRow({ issued_at: "not-a-date" }), error: null });
    const out = await beginRecipientProof(TOKEN);
    expect(out.kind).toBe("unavailable");
    expect(JSON.stringify(out)).not.toContain("20");
  });

  it("the validation left rawChallenge and proofChallengeId untouched", async () => {
    rpc.mockResolvedValue({ data: challengeRow(), error: null });
    const out = await beginRecipientProof(TOKEN);
    if (out.kind !== "challenge_issued") throw new Error("unreachable");
    expect(out.rawChallenge).toBe(CHALLENGE);
    expect(out.proofChallengeId).toBe(CHALLENGE_ID);
    // And a valid instant is still server-only.
    expect(out.maskedContact).not.toContain(out.issuedAt);
  });

  it("is unavailable when the row carries no challenge id", async () => {
    // Sending a challenge that cannot be keyed would leave the send
    // un-idempotent, so a row without an id is IN DOUBT, not half-issued.
    rpc.mockResolvedValue({ data: challengeRow({ challenge_id: null }), error: null });
    expect((await beginRecipientProof(TOKEN)).kind).toBe("unavailable");
  });

  it("is unavailable rather than half-issued when the row carries no code", async () => {
    rpc.mockResolvedValue({ data: challengeRow({ raw_challenge: null }), error: null });
    expect((await beginRecipientProof(TOKEN)).kind).toBe("unavailable");
  });

  it("is unavailable when the row carries no DB expiry", async () => {
    rpc.mockResolvedValue({ data: challengeRow({ expires_at: null }), error: null });
    expect((await beginRecipientProof(TOKEN)).kind).toBe("unavailable");
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

  // Codex P2-B. These are DOCUMENTED lifecycle refusals that `issue_scoped_`
  // passes through from the applied issue command (0192's `elsif v_issue.result
  // in (...)` branch), plus its own `already_declined_offer`. They were falling
  // through the default arm as `unavailable`, which means TRANSPORT FAILED / IN
  // DOUBT — the opposite of what happened. The database answered definitively,
  // and the answer is actionable.
  it.each([
    "already_declined_offer",
    "already_invited",
    "invalid_ttl",
    "not_claimed",
    "not_found",
  ])("preserves the documented refusal %s as its own kind", async (code) => {
    getCurrentPractitionerWithStudio.mockResolvedValue(session);
    rpc.mockResolvedValue({ data: [{ result: code }], error: null });
    const out = await issueScopedInvitation({
      entryId: "entry-1", serviceId: "svc-1",
      startDate: "2026-10-01", endDate: "2026-10-31",
    });
    expect(out.kind).toBe(code);
    expect(out.kind, `${code} must not be reported as in-doubt`).not.toBe("unavailable");
  });

  it("an UNRECOGNISED result is still unavailable", async () => {
    getCurrentPractitionerWithStudio.mockResolvedValue(session);
    rpc.mockResolvedValue({ data: [{ result: "something_new_entirely" }], error: null });
    const out = await issueScopedInvitation({
      entryId: "entry-1", serviceId: "svc-1",
      startDate: "2026-10-01", endDate: "2026-10-31",
    });
    expect(out.kind).toBe("unavailable");
  });

  it("a transport error is still unavailable", async () => {
    getCurrentPractitionerWithStudio.mockResolvedValue(session);
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    const out = await issueScopedInvitation({
      entryId: "entry-1", serviceId: "svc-1",
      startDate: "2026-10-01", endDate: "2026-10-31",
    });
    expect(out.kind).toBe("unavailable");
  });

  it("a successful issuance is unchanged", async () => {
    getCurrentPractitionerWithStudio.mockResolvedValue(session);
    rpc.mockResolvedValue({
      data: [{ result: "issued", raw_token: TOKEN, invitation_id: "inv-1" }],
      error: null,
    });
    const out = await issueScopedInvitation({
      entryId: "entry-1", serviceId: "svc-1",
      startDate: "2026-10-01", endDate: "2026-10-31",
    });
    expect(out).toEqual({ kind: "issued", invitationId: "inv-1", rawToken: TOKEN });
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
