import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, createHmac } from "node:crypto";

// WAIT-03 B3 — the recipient's server actions.
//
// The load-bearing claims:
//   * possession of the LINK alone never books or declines;
//   * no action return value can carry the proof code, the capability or the
//     proofChallengeId -- those are scanned for, not assumed absent;
//   * out-of-scope slots are never serialised to the browser at all.

const CODE = "c".repeat(64);
const CAPABILITY = "b".repeat(64);
const CHALLENGE_ID = "9f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
const TOKEN = "a".repeat(64);
const STUDIO = "22222222-2222-4222-8222-222222222222";
const SERVICE = "55555555-5555-4555-8555-555555555555";
const ENTRY = "44444444-4444-4444-8444-444444444444";

process.env.APPOINTMENT_SIGNING_SECRET =
  process.env.APPOINTMENT_SIGNING_SECRET ?? "test-signing-secret-at-least-32-bytes-long";

const cookieJar = new Map<string, string>();

/** The cookie value the action itself would write: capability + its binding. */
function signedCapability(
  token: string,
  capability: string,
  // Default well inside the database's 30 minutes; tests that care pass their own.
  expiresAt: string = new Date(Date.now() + 20 * 60_000).toISOString(),
): string {
  // Epoch millis, matching the action: an ISO string carries its own dot.
  const ms = String(Date.parse(expiresAt));
  const bound = [
    createHash("sha256").update(token, "utf8").digest("hex"),
    capability,
    ms,
  ].join(".");
  const sig = createHmac("sha256", process.env.APPOINTMENT_SIGNING_SECRET as string)
    .update(bound)
    .digest("hex");
  return `${capability}.${ms}.${sig}`;
}
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (k: string) => (cookieJar.has(k) ? { value: cookieJar.get(k) } : undefined),
    set: (k: string, v: string) => { if (v === "") cookieJar.delete(k); else cookieJar.set(k, v); },
  }),
  headers: async () => new Headers(),
}));

const resolveInvitation = vi.fn();
const beginRecipientProof = vi.fn();
const completeRecipientProof = vi.fn();
const declineInvitation = vi.fn();
vi.mock("@/lib/booking/waitlist-invitation", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    resolveInvitation: (...a: unknown[]) => resolveInvitation(...a),
    beginRecipientProof: (...a: unknown[]) => beginRecipientProof(...a),
    completeRecipientProof: (...a: unknown[]) => completeRecipientProof(...a),
    declineInvitation: (...a: unknown[]) => declineInvitation(...a),
  };
});

const fetchPublicSlotsAction = vi.fn();
const publicBookAppointmentAction = vi.fn();
vi.mock("@/app/book/[slug]/actions", () => ({
  fetchPublicSlotsAction: (...a: unknown[]) => fetchPublicSlotsAction(...a),
  publicBookAppointmentAction: (...a: unknown[]) => publicBookAppointmentAction(...a),
}));

/**
 * The RANGE helper, which is what the offer walk calls now.
 *
 * It replaced per-date `fetchPublicSlotsAction` calls precisely because that
 * action rate-limits itself: a window wider than the allowance drained its own
 * quota and the remaining days came back refused and were silently skipped.
 *
 * The shim keeps every existing per-date expectation working — tests still set
 * `fetchPublicSlotsAction` per date and still read its calls to see WHICH dates
 * were asked for — while the code under test exercises the real one-throttle
 * path. `dates` is what the walk decided to ask about, which is the thing those
 * assertions actually care about.
 */
const fetchPublicSlotsForDates = vi.fn(
  async ({ dates }: { dates: readonly string[] }) => {
    const slots: Array<{ start: string; end: string }> = [];
    for (const date of dates) {
      const res = await fetchPublicSlotsAction({ date });
      if (res?.ok) slots.push(...res.slots);
    }
    return { ok: true as const, slots, scanned: [...dates], skippedOutsideHorizon: [] };
  },
);
vi.mock("@/lib/booking/public-slot-range", () => ({
  fetchPublicSlotsForDates: (...a: unknown[]) =>
    (fetchPublicSlotsForDates as (...x: unknown[]) => unknown)(...a),
}));

vi.mock("@/lib/rate-limit/public", () => ({
  limitPublicSlots: async () => ({ allowed: true }),
  RATE_LIMIT_MESSAGE: "rate limited",
}));

/**
 * The invited entry's stored phone.
 *
 * A STRING BY DEFAULT, because that is the ordinary case and every pre-existing
 * test in this file assumes a booking can complete. `null` is the case the
 * public join form makes reachable — it labels the field "Phone (optional)" —
 * and it is exercised explicitly below.
 */
const entryFixture = { phone: "555 0100" as string | null };
// P2-D: the studio's zone is what the day filter must resolve against.
const studioFixture = { timezone: "America/Toronto" };

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      Object.assign(chain, {
        select: self, eq: self,
        maybeSingle: async () =>
          table === "studios"
            ? { data: { slug: "studio-a", name: "Studio A", timezone: studioFixture.timezone }, error: null }
            : table === "services"
              ? { data: { name: "Consultation", default_duration_minutes: 45 }, error: null }
              : {
                  data: {
                    name: "Chloe",
                    email: "chloe@example.test",
                    phone: entryFixture.phone,
                  },
                  error: null,
                },
      });
      return chain;
    },
  }),
}));

const {
  bookInvitationSlotAction,
  declineInvitationAction,
  loadInvitationAction,
  requestInvitationProofAction,
  submitInvitationProofAction,
} = await import("@/app/invitation/[token]/actions");

function liveResolve(weekdays: number[] | null = null) {
  return {
    kind: "live",
    invitation: {
      invitationId: "inv-1", studioId: STUDIO, entryId: ENTRY,
      expiresAt: "2026-10-31T12:00:00Z",
      recipientContactHash: "d".repeat(64),
      scope: {
        serviceId: SERVICE, startDate: "2026-10-01", endDate: "2026-10-31",
        allowedWeekdays: weekdays,
      },
    },
  };
}

/** Every string anywhere in the value, however deeply nested. */
function allStrings(v: unknown, acc: string[] = []): string[] {
  if (typeof v === "string") acc.push(v);
  else if (Array.isArray(v)) v.forEach((x) => allStrings(x, acc));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => allStrings(x, acc));
  return acc;
}

beforeEach(() => {
  studioFixture.timezone = "America/Toronto";
  cookieJar.clear();
  for (const m of [resolveInvitation, beginRecipientProof, completeRecipientProof,
                   declineInvitation, fetchPublicSlotsAction, publicBookAppointmentAction]) m.mockReset();
  // Calls only — `mockReset` would discard the shim's implementation, and a
  // test reading `mock.calls[0]` must see THIS test's first call, not a
  // previous one's.
  fetchPublicSlotsForDates.mockClear();
  resolveInvitation.mockResolvedValue(liveResolve());
  fetchPublicSlotsAction.mockResolvedValue({ ok: true, slots: [] });
  entryFixture.phone = "555 0100";
  studioFixture.timezone = "America/Toronto";
});

// ===========================================================================
// THE PHONE — the field that made every booking impossible
// ===========================================================================
//
// `publicBookAppointmentAction` rejects a new-client submission with no phone
// at an UNCONDITIONAL gate, before invitation authorization or redemption. This
// action sent name and email and nothing else, so every recipient booking
// stopped at "Please enter a phone number" — with no field anywhere on the
// invitation surface to enter one. The offer, the proof and the scope were all
// correct and the journey still could not complete.

describe("the booking carries a phone, because the engine requires one", () => {
  it("sends the entry's STORED phone", async () => {
    cookieJar.set("wl_proof_capability", signedCapability(TOKEN, CAPABILITY));
    publicBookAppointmentAction.mockResolvedValue({
      ok: true, appointmentId: "a1", manageUrl: "https://x/m", confirmationEmailStatus: "sent",
    });

    await bookInvitationSlotAction(TOKEN, "2026-10-07T14:00:00.000Z");

    expect(publicBookAppointmentAction).toHaveBeenCalledTimes(1);
    const fd = publicBookAppointmentAction.mock.calls[0][0] as FormData;
    expect(fd.get("phone")).toBe("555 0100");
    // NON-VACUITY: the engine's own gate is what this satisfies.
    expect(fd.get("client_type")).toBe("new");
  });

  it("PREFERS THE STORED NUMBER over anything the client sends", async () => {
    // Whoever holds the link must not be able to write a phone onto the client
    // record this booking creates when the studio already holds the real one.
    cookieJar.set("wl_proof_capability", signedCapability(TOKEN, CAPABILITY));
    publicBookAppointmentAction.mockResolvedValue({
      ok: true, appointmentId: "a1", manageUrl: "https://x/m", confirmationEmailStatus: "sent",
    });

    await bookInvitationSlotAction(TOKEN, "2026-10-07T14:00:00.000Z", "999 9999");

    const fd = publicBookAppointmentAction.mock.calls[0][0] as FormData;
    expect(fd.get("phone")).toBe("555 0100");
    expect(fd.get("phone")).not.toBe("999 9999");
  });

  it("uses a TYPED number only where the entry has none", async () => {
    // Joining a waitlist makes the phone optional, so this is an ordinary
    // entry rather than a broken one.
    entryFixture.phone = null;
    cookieJar.set("wl_proof_capability", signedCapability(TOKEN, CAPABILITY));
    publicBookAppointmentAction.mockResolvedValue({
      ok: true, appointmentId: "a1", manageUrl: "https://x/m", confirmationEmailStatus: "sent",
    });

    await bookInvitationSlotAction(TOKEN, "2026-10-07T14:00:00.000Z", "  416 555 0000  ");

    const fd = publicBookAppointmentAction.mock.calls[0][0] as FormData;
    expect(fd.get("phone")).toBe("416 555 0000");
  });

  it("NEVER REACHES THE ENGINE with no phone at all", async () => {
    // The old behaviour: the attempt went through and came back with the public
    // form's error for a field this surface never showed. Failing before the
    // call keeps the recipient on the offer they are looking at.
    entryFixture.phone = null;
    cookieJar.set("wl_proof_capability", signedCapability(TOKEN, CAPABILITY));

    const out = await bookInvitationSlotAction(TOKEN, "2026-10-07T14:00:00.000Z");

    expect(publicBookAppointmentAction).not.toHaveBeenCalled();
    expect(out.kind).toBe("offer");
  });

  it("a whitespace-only typed number is not a number", async () => {
    entryFixture.phone = null;
    cookieJar.set("wl_proof_capability", signedCapability(TOKEN, CAPABILITY));

    const out = await bookInvitationSlotAction(TOKEN, "2026-10-07T14:00:00.000Z", "   ");

    expect(publicBookAppointmentAction).not.toHaveBeenCalled();
    expect(out.kind).toBe("offer");
  });

  it("THE OFFER ASKS FOR IT — phoneRequired is set only where none is stored", async () => {
    cookieJar.set("wl_proof_capability", signedCapability(TOKEN, CAPABILITY));

    entryFixture.phone = null;
    const needs = await loadInvitationAction(TOKEN);
    expect(needs.kind).toBe("offer");
    expect((needs as { phoneRequired?: boolean }).phoneRequired).toBe(true);

    // NON-VACUITY, and the rule that matters: an entry that HAS a phone is
    // never asked for one.
    entryFixture.phone = "555 0100";
    const hasIt = await loadInvitationAction(TOKEN);
    expect(hasIt.kind).toBe("offer");
    expect((hasIt as { phoneRequired?: boolean }).phoneRequired).toBeUndefined();
  });
});

describe("the link alone is not authorisation", () => {
  it("cannot book without a proven capability, and never reaches the booking engine", async () => {
    const out = await bookInvitationSlotAction(TOKEN, "2026-10-07T14:00:00.000Z");
    expect(publicBookAppointmentAction).not.toHaveBeenCalled();
    expect(out.kind).toBe("proof");
  });

  it("cannot decline without a proven capability, and never reaches the command", async () => {
    const out = await declineInvitationAction(TOKEN);
    expect(declineInvitation).not.toHaveBeenCalled();
    expect(out.kind).toBe("proof");
  });

  it("books once a capability exists, through the SHARED booking engine", async () => {
    cookieJar.set("wl_proof_capability", signedCapability(TOKEN, CAPABILITY));
    publicBookAppointmentAction.mockResolvedValue({
      ok: true, appointmentId: "a1", manageUrl: "https://x/m", confirmationEmailStatus: "sent",
    });
    const out = await bookInvitationSlotAction(TOKEN, "2026-10-07T14:00:00.000Z");
    expect(publicBookAppointmentAction).toHaveBeenCalledTimes(1);
    const fd = publicBookAppointmentAction.mock.calls[0][0] as FormData;
    expect(fd.get("invitation_token")).toBe(TOKEN);
    expect(fd.get("invitation_capability")).toBe(CAPABILITY);
    // The invited identity is read server-side; the recipient types no address.
    expect(fd.get("email")).toBe("chloe@example.test");
    expect(fd.get("name")).toBe("Chloe");
    expect(out.kind).toBe("booked");
  });

  it("clears the capability once it has been spent", async () => {
    cookieJar.set("wl_proof_capability", signedCapability(TOKEN, CAPABILITY));
    publicBookAppointmentAction.mockResolvedValue({
      ok: true, appointmentId: "a1", manageUrl: "https://x/m", confirmationEmailStatus: "sent",
    });
    await bookInvitationSlotAction(TOKEN, "2026-10-07T14:00:00.000Z");
    expect(cookieJar.has("wl_proof_capability")).toBe(false);
  });
});

describe("secrets never cross the action boundary", () => {
  it("a verified proof returns no capability, code or challenge id", async () => {
    completeRecipientProof.mockResolvedValue({
      kind: "verified", rawCapability: CAPABILITY, expiresAt: "2026-10-07T12:30:00Z",
    });
    const out = await submitInvitationProofAction(TOKEN, CODE, { maskedContact: "c•••@e.test", expiresAt: "x" });
    const strings = allStrings(out);
    expect(strings).not.toContain(CAPABILITY);
    expect(strings).not.toContain(CODE);
    expect(strings).not.toContain(CHALLENGE_ID);
    // The capability went to an httpOnly cookie instead -- signed and bound to
    // this invitation, so the stored value is not the bare credential either.
    expect(cookieJar.get("wl_proof_capability")).toBe(
      // Signed over the DATABASE's expiry, which is what the command returned.
      signedCapability(TOKEN, CAPABILITY, "2026-10-07T12:30:00Z"),
    );
  });

  it("a requested code returns neither the code nor its challenge id", async () => {
    beginRecipientProof.mockResolvedValue({
      kind: "challenge_issued", proofChallengeId: CHALLENGE_ID, rawChallenge: CODE,
      expiresAt: "2026-10-07T12:20:00Z", deliveryContact: "chloe@example.test",
      maskedContact: "c•••@example.test",
    });
    const out = await requestInvitationProofAction(TOKEN);
    const strings = allStrings(out);
    expect(strings).not.toContain(CODE);
    expect(strings).not.toContain(CHALLENGE_ID);
    expect(strings).not.toContain("chloe@example.test");
  });

  it("REQUESTING A NEW CODE DROPS THE OLD COOKIE", async () => {
    // `begin_waitlist_invitation_proof` clears the database capability when it
    // mints a replacement, but the signed cookie is independent of that: its
    // HMAC binds a capability to a token and its expiry is the COOKIE's, not
    // the database's. Leaving it meant a later reload verified the signature,
    // saw a still-future expiry, and rendered `proven` against a capability the
    // database would already reject.
    //
    // Reachable without anything exotic: a second tab still on the proof form,
    // or the `decline_unavailable` path that returns the proof screen without
    // clearing its cookie. Asking for a fresh code is the ordinary move from
    // either.
    cookieJar.set(
      "wl_proof_capability",
      signedCapability(TOKEN, CAPABILITY, "2026-10-07T12:30:00Z"),
    );
    beginRecipientProof.mockResolvedValue({
      kind: "challenge_issued", proofChallengeId: CHALLENGE_ID, rawChallenge: CODE,
      expiresAt: "2026-10-07T12:20:00Z", deliveryContact: "chloe@example.test",
      maskedContact: "c•••@example.test",
    });

    await requestInvitationProofAction(TOKEN);

    expect(cookieJar.has("wl_proof_capability")).toBe(false);
  });

  it("NON-VACUITY — a failed begin leaves the cookie alone", async () => {
    // Only a REPLACEMENT invalidates the old capability. Clearing on every
    // outcome would log out a recipient whose request merely failed to send.
    cookieJar.set(
      "wl_proof_capability",
      signedCapability(TOKEN, CAPABILITY, "2026-10-07T12:30:00Z"),
    );
    beginRecipientProof.mockResolvedValue({ kind: "unavailable" });

    await requestInvitationProofAction(TOKEN);

    expect(cookieJar.has("wl_proof_capability")).toBe(true);
  });

  it("the first paint carries no invitation identifiers at all", async () => {
    const strings = allStrings(await loadInvitationAction(TOKEN));
    for (const secret of ["d".repeat(64), ENTRY, STUDIO, "inv-1"]) {
      expect(strings, `${secret} must not reach the browser`).not.toContain(secret);
    }
  });
});

describe("out-of-scope slots are never serialised", () => {
  beforeEach(() => {
    cookieJar.set("wl_proof_capability", signedCapability(TOKEN, CAPABILITY));
    // Two candidate instants: a Wednesday and a Sunday, in Toronto.
    fetchPublicSlotsAction.mockResolvedValue({
      ok: true,
      slots: [
        { start: "2026-10-07T14:00:00.000Z", end: "2026-10-07T14:45:00.000Z" },
        { start: "2026-10-04T14:00:00.000Z", end: "2026-10-04T14:45:00.000Z" },
      ],
    });
  });

  it("drops days the offer does not permit", async () => {
    resolveInvitation.mockResolvedValue(liveResolve([3])); // Wednesdays only
    const out = await loadInvitationAction(TOKEN);
    if (out.kind !== "offer") throw new Error(`expected offer, got ${out.kind}`);
    const dates = out.days.map((d) => d.date);
    expect(dates).toContain("2026-10-07");
    expect(dates, "a Sunday must not survive a Wednesdays-only offer").not.toContain("2026-10-04");
  });

  it("keeps both when the offer allows every day", async () => {
    resolveInvitation.mockResolvedValue(liveResolve(null));
    const out = await loadInvitationAction(TOKEN);
    if (out.kind !== "offer") throw new Error(`expected offer, got ${out.kind}`);
    expect(out.days.length).toBeGreaterThanOrEqual(2);
  });
});

describe("terminal states are explicit", () => {
  it.each([
    ["expired", "expired"],
    ["released", "revoked"],
    ["already_redeemed", "already_redeemed"],
    ["declined", "declined"],
  ])("a %s invitation closes with reason %s", async (resolved, reason) => {
    resolveInvitation.mockResolvedValue({ kind: resolved });
    const out = await loadInvitationAction(TOKEN);
    expect(out.kind).toBe("closed");
    if (out.kind !== "closed") throw new Error("unreachable");
    expect(out.reason).toBe(reason);
  });

  it("an unreadable link is an error, not a silent empty page", async () => {
    resolveInvitation.mockResolvedValue({ kind: "invalid_token" });
    expect((await loadInvitationAction(TOKEN)).kind).toBe("error");
  });
});

// P2-A. Every booking failure used to re-render the offer with no message and
// leave the capability in place, so a spent invitation showed live selectable
// times and an ordinary retry looked like the tap had done nothing.
describe("P2-A — a refused booking says what happened", () => {
  beforeEach(() => { cookieJar.set("wl_proof_capability", signedCapability(TOKEN, CAPABILITY)); });

  it("a CONSUMED invitation becomes terminal, not a live offer", async () => {
    publicBookAppointmentAction.mockResolvedValue({
      ok: false, code: "invitation_consumed",
      error: "Your invitation has been used, but we couldn't finish the booking.",
    });
    const out = await bookInvitationSlotAction(TOKEN, "2026-10-07T14:00:00.000Z");
    expect(out.kind).toBe("closed");
    if (out.kind !== "closed") throw new Error("unreachable");
    expect(out.reason).toBe("consumed_without_booking");
    // The capability authorises nothing now and must not survive.
    expect(cookieJar.has("wl_proof_capability")).toBe(false);
  });

  it("a slot_taken refusal keeps the offer AND states the reason", async () => {
    publicBookAppointmentAction.mockResolvedValue({ ok: false, code: "slot_taken", error: "x" });
    const out = await bookInvitationSlotAction(TOKEN, "2026-10-07T14:00:00.000Z");
    expect(out.kind).toBe("offer");
    if (out.kind !== "offer") throw new Error("unreachable");
    expect(out.refusal).toBe("slot_taken");
    // Still usable: the capability survives so the recipient can pick again.
    expect(cookieJar.has("wl_proof_capability")).toBe(true);
  });

  it("an unrecognised refusal is IN DOUBT, never a confident slot_taken", async () => {
    publicBookAppointmentAction.mockResolvedValue({ ok: false, error: "boom" });
    const out = await bookInvitationSlotAction(TOKEN, "2026-10-07T14:00:00.000Z");
    if (out.kind !== "offer") throw new Error("unreachable");
    expect(out.refusal).toBe("unavailable");
  });

  it("a SUCCESSFUL booking carries no refusal", async () => {
    publicBookAppointmentAction.mockResolvedValue({
      ok: true, appointmentId: "a1", manageUrl: "https://x/m", confirmationEmailStatus: "sent",
    });
    const out = await bookInvitationSlotAction(TOKEN, "2026-10-07T14:00:00.000Z");
    expect(out.kind).toBe("booked");
  });
});

// P3-A. The first render used to treat the PRESENCE of any 64-hex cookie as
// proof, so a hand-set value rendered the slot list without proving. The cookie
// is now signed and bound to one invitation, and verified before anything
// renders.
describe("P3-A — the render gate is the authority gate", () => {
  it("an unsigned bare capability does not unlock the times", async () => {
    cookieJar.set("wl_proof_capability", CAPABILITY);
    const out = await loadInvitationAction(TOKEN);
    expect(out.kind, "a bare value must not read as proven").toBe("proof");
  });

  it("a forged signature does not unlock the times", async () => {
    cookieJar.set("wl_proof_capability", `${CAPABILITY}.${"f".repeat(64)}`);
    expect((await loadInvitationAction(TOKEN)).kind).toBe("proof");
  });

  it("a capability signed for a DIFFERENT invitation does not unlock this one", async () => {
    cookieJar.set("wl_proof_capability", signedCapability("z".repeat(64), CAPABILITY));
    expect((await loadInvitationAction(TOKEN)).kind).toBe("proof");
  });

  it("the properly signed cookie this action writes does unlock them", async () => {
    cookieJar.set("wl_proof_capability", signedCapability(TOKEN, CAPABILITY));
    expect((await loadInvitationAction(TOKEN)).kind).toBe("offer");
  });

  it("a forged cookie cannot book either", async () => {
    cookieJar.set("wl_proof_capability", CAPABILITY);
    const out = await bookInvitationSlotAction(TOKEN, "2026-10-07T14:00:00.000Z");
    expect(publicBookAppointmentAction).not.toHaveBeenCalled();
    expect(out.kind).toBe("proof");
  });
});

// P3-B. A failed decline used to return the proof screen with no explanation.
describe("P3-B — a failed decline says why", () => {
  beforeEach(() => { cookieJar.set("wl_proof_capability", signedCapability(TOKEN, CAPABILITY)); });

  it.each(["proof_expired", "proof_invalid", "proof_required"])(
    "a %s decline explains the lapse and drops the dead capability",
    async (kind) => {
      declineInvitation.mockResolvedValue({ kind });
      const out = await declineInvitationAction(TOKEN);
      expect(out.kind).toBe("proof");
      if (out.kind !== "proof") throw new Error("unreachable");
      expect(out.notice).toBe("proof_lapsed");
      expect(cookieJar.has("wl_proof_capability")).toBe(false);
    },
  );

  it("an in-doubt decline says so, and KEEPS the capability", async () => {
    declineInvitation.mockResolvedValue({ kind: "unavailable" });
    const out = await declineInvitationAction(TOKEN);
    if (out.kind !== "proof") throw new Error("unreachable");
    expect(out.notice).toBe("decline_unavailable");
    // The request may still have landed; discarding the credential would strand
    // a recipient who is about to retry.
    expect(cookieJar.has("wl_proof_capability")).toBe(true);
  });

  it("a decline against a DEAD invitation shows the terminal state, not a notice", async () => {
    declineInvitation.mockResolvedValue({ kind: "not_live" });
    resolveInvitation.mockResolvedValue({ kind: "already_redeemed" });
    const out = await declineInvitationAction(TOKEN);
    expect(out.kind).toBe("closed");
  });

  it("a successful decline is still terminal", async () => {
    declineInvitation.mockResolvedValue({ kind: "declined", entryId: ENTRY });
    expect((await declineInvitationAction(TOKEN)).kind).toBe("declined");
  });
});

// P2-A. `invitation_refused` is ambiguous at this layer: the booking action
// emits it both for an out-of-scope slot and for a capability that failed the
// gate. Treating them alike told a recipient whose proof had lapsed to "choose
// one of the times shown" and left the dead cookie in place.
describe("P2-A — a lapsed capability restarts proof; a bad slot does not", () => {
  beforeEach(() => { cookieJar.set("wl_proof_capability", signedCapability(TOKEN, CAPABILITY)); });

  it("an IN-SCOPE slot refused means the proof lapsed: clear and re-prove", async () => {
    resolveInvitation.mockResolvedValue(liveResolve(null)); // every day offered
    publicBookAppointmentAction.mockResolvedValue({ ok: false, code: "invitation_refused", error: "x" });
    const out = await bookInvitationSlotAction(TOKEN, "2026-10-07T14:00:00.000Z");
    expect(out.kind).toBe("proof");
    if (out.kind !== "proof") throw new Error("unreachable");
    expect(out.notice).toBe("proof_lapsed");
    expect(cookieJar.has("wl_proof_capability"), "a dead capability must not survive").toBe(false);
  });

  it("an OUT-OF-SCOPE slot refused keeps the offer and the capability", async () => {
    resolveInvitation.mockResolvedValue(liveResolve([1])); // Mondays only
    publicBookAppointmentAction.mockResolvedValue({ ok: false, code: "invitation_refused", error: "x" });
    // 2026-10-07 is a Wednesday in Toronto.
    const out = await bookInvitationSlotAction(TOKEN, "2026-10-07T14:00:00.000Z");
    expect(out.kind).toBe("offer");
    if (out.kind !== "offer") throw new Error("unreachable");
    expect(out.refusal).toBe("not_permitted");
    expect(cookieJar.has("wl_proof_capability")).toBe(true);
  });
});

// P2-B. The day list used to stop after 21 days with no pagination and no
// signal, so a longer offer silently lost its tail.
describe("P2-B — the whole authorised window is reachable", () => {
  beforeEach(() => {
    cookieJar.set("wl_proof_capability", signedCapability(TOKEN, CAPABILITY));
    fetchPublicSlotsAction.mockImplementation(async ({ date }: { date: string }) => ({
      ok: true,
      slots: [{ start: `${date}T14:00:00.000Z`, end: `${date}T14:45:00.000Z` }],
    }));
  });

  function longOffer(weekdays: number[] | null) {
    const r = liveResolve(weekdays);
    r.invitation.scope.startDate = "2026-10-01";
    r.invitation.scope.endDate = "2026-12-15"; // 76 days: well past the old cap
    resolveInvitation.mockResolvedValue(r);
  }

  it("renders days far beyond the old 21-day cap", async () => {
    longOffer(null);
    const out = await loadInvitationAction(TOKEN);
    if (out.kind !== "offer") throw new Error(`expected offer, got ${out.kind}`);
    expect(out.days.length).toBeGreaterThan(21);
  });

  it("reaches the final day the studio can actually be BOOKED on", async () => {
    // NOT blindly `scope.endDate`. The scan is intersected with the studio's
    // own public booking horizon, because `fetchPublicSlotsAction` refuses a
    // date beyond it — so a scope reaching past the horizon names dates that
    // are unbookable by ANY route, and walking them would spend the whole
    // budget discovering that one refusal at a time.
    //
    // The fixture studio has no configured horizon, so it takes the default.
    // With a scope ending 2026-12-15 the walk therefore stops at the horizon,
    // and what matters is that it goes FAR past the old 21-day cap and stops
    // for an authoritative reason rather than an arbitrary constant.
    longOffer(null);
    const out = await loadInvitationAction(TOKEN);
    if (out.kind !== "offer") throw new Error("unreachable");

    const dates = out.days.map((d) => d.date);
    expect(dates.length).toBeGreaterThan(60);
    // Well beyond the old cap, and contiguous to the end of what it scanned.
    expect(dates).toContain("2026-11-30");
    // The last day scanned is the horizon's, not day 21 and not a magic number.
    const last = dates[dates.length - 1]!;
    expect(last > "2026-11-30").toBe(true);
    expect(last <= "2026-12-15").toBe(true);
  });

  it("STOPS AT THE HORIZON, and does not query past it", async () => {
    // The bound that makes a mistyped `9999-12-31` finite. Without it the walk
    // allocated every date in the range before the first fetch.
    longOffer(null);
    await loadInvitationAction(TOKEN);

    const asked = (fetchPublicSlotsForDates.mock.calls[0]![0] as { dates: string[] }).dates;
    expect(asked.length).toBeGreaterThan(60);
    // Bounded, and bounded by something far below the 76-day scope.
    expect(asked.length).toBeLessThan(76);
    for (const d of asked) expect(d <= "2026-12-15", d).toBe(true);
  });

  it("A THROTTLED READ IS AN ERROR, never an empty diary", async () => {
    // The rate limiter used to be applied PER DATE inside the action, so a wide
    // window drained its own quota and the refused days were silently skipped —
    // truncation again, this time environment-dependent and invisible to any
    // test without a configured limiter. The surface now gates once, and a
    // refusal is reported rather than rendered as "nothing is open".
    fetchPublicSlotsForDates.mockResolvedValueOnce({
      ok: false as const,
      error: "rate limited",
    } as never);
    longOffer(null);

    const out = await loadInvitationAction(TOKEN);
    expect(out.kind).not.toBe("offer");
  });

  it("a FAR-FUTURE endDate cannot explode the scan", async () => {
    // `0192` constrains the scope only to `start <= end`, so this is a legal
    // invitation. It used to allocate tens of thousands of dates before the
    // first fetch; `9999-12-31` could exhaust the invocation outright.
    const r = liveResolve(null);
    r.invitation.scope.startDate = "2026-10-01";
    r.invitation.scope.endDate = "9999-12-31";
    resolveInvitation.mockResolvedValue(r);

    const out = await loadInvitationAction(TOKEN);
    expect(out.kind).toBe("offer");
    const asked = (fetchPublicSlotsForDates.mock.calls[0]![0] as { dates: string[] }).dates;
    expect(asked.length).toBeLessThan(400);
  });

  it("returns nothing after endDate", async () => {
    longOffer(null);
    const out = await loadInvitationAction(TOKEN);
    if (out.kind !== "offer") throw new Error("unreachable");
    for (const d of out.days) expect(d.date <= "2026-12-15").toBe(true);
  });

  it("queries only the days the offer permits", async () => {
    longOffer([1]); // Mondays only
    const out = await loadInvitationAction(TOKEN);
    if (out.kind !== "offer") throw new Error("unreachable");
    // Every rendered day is a Monday, and the reads were not spent on the rest.
    for (const d of out.days) {
      expect(new Date(`${d.date}T12:00:00Z`).getUTCDay()).toBe(1);
    }
    expect(fetchPublicSlotsAction.mock.calls.length).toBeLessThan(20);
  });
});

// P2-D. The day filter used to build noon UTC and call it "noon in the studio's
// zone". For a studio at UTC+13/+14 that lands on the NEXT local day, so a
// Mondays-only offer queried Sundays, skipped Mondays, and rendered empty --
// silent unavailability, in the very loop rewritten to end silent truncation.
describe("P2-D — the day filter resolves against the studio's zone", () => {
  beforeEach(() => {
    cookieJar.set("wl_proof_capability", signedCapability(TOKEN, CAPABILITY));
    // 01:00Z on a given date is EARLY AFTERNOON the same day in Auckland, so a
    // slot returned for date D is genuinely on D in the studio's zone.
    fetchPublicSlotsAction.mockImplementation(async ({ date }: { date: string }) => ({
      ok: true,
      slots: [{ start: `${date}T01:00:00.000Z`, end: `${date}T01:45:00.000Z` }],
    }));
  });

  it("renders Mondays for a UTC+13 studio", async () => {
    studioFixture.timezone = "Pacific/Auckland";
    const r = liveResolve([1]); // Mondays only
    r.invitation.scope.startDate = "2026-10-01";
    r.invitation.scope.endDate = "2026-10-31";
    resolveInvitation.mockResolvedValue(r);

    const out = await loadInvitationAction(TOKEN);
    if (out.kind !== "offer") throw new Error(`expected offer, got ${out.kind}`);
    expect(out.days.length, "a Mondays-only Auckland offer must not render empty").toBeGreaterThan(0);
    // Every rendered day is a Monday IN AUCKLAND.
    for (const d of out.days) {
      const noonLocal = new Date(`${d.date}T01:00:00.000Z`);
      expect(
        noonLocal.toLocaleDateString("en-CA", { timeZone: "Pacific/Auckland", weekday: "short" }),
      ).toContain("Mon");
    }
  });

  it("still renders Mondays for a UTC-4 studio", async () => {
    studioFixture.timezone = "America/Toronto";
    const r = liveResolve([1]);
    r.invitation.scope.startDate = "2026-10-01";
    r.invitation.scope.endDate = "2026-10-31";
    resolveInvitation.mockResolvedValue(r);
    // Toronto: 14:00Z is mid-morning the same day.
    fetchPublicSlotsAction.mockImplementation(async ({ date }: { date: string }) => ({
      ok: true,
      slots: [{ start: `${date}T14:00:00.000Z`, end: `${date}T14:45:00.000Z` }],
    }));
    const out = await loadInvitationAction(TOKEN);
    if (out.kind !== "offer") throw new Error("unreachable");
    expect(out.days.length).toBeGreaterThan(0);
  });
});

// P3-A. A valid signature proves only that WE minted the cookie for THIS
// invitation. It said nothing about whether the capability was still live, so a
// reload inside the cookie's max-age rendered the slot list as proven after the
// capability had lapsed at the database.
describe("P3-A — a lapsed capability stops reading as proven", () => {
  it("an EXPIRED capability does not unlock the times", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    cookieJar.set("wl_proof_capability", signedCapability(TOKEN, CAPABILITY, past));
    expect((await loadInvitationAction(TOKEN)).kind).toBe("proof");
  });

  it("an expired capability cannot book either", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    cookieJar.set("wl_proof_capability", signedCapability(TOKEN, CAPABILITY, past));
    const out = await bookInvitationSlotAction(TOKEN, "2026-10-07T14:00:00.000Z");
    expect(publicBookAppointmentAction).not.toHaveBeenCalled();
    expect(out.kind).toBe("proof");
  });

  it("a live capability still works", async () => {
    cookieJar.set("wl_proof_capability", signedCapability(TOKEN, CAPABILITY));
    expect((await loadInvitationAction(TOKEN)).kind).toBe("offer");
  });

  it("the expiry is covered by the signature — editing it buys no time", async () => {
    const live = new Date(Date.now() + 20 * 60_000).toISOString();
    const future = new Date(Date.now() + 9_000_000).toISOString();
    const [cap, , sig] = signedCapability(TOKEN, CAPABILITY, live).split(".");
    // Same capability, same signature, a later expiry pasted in.
    cookieJar.set("wl_proof_capability", `${cap}.${future}.${sig}`);
    expect((await loadInvitationAction(TOKEN)).kind).toBe("proof");
  });

  it("an unreadable expiry is treated as lapsed, not as permission", async () => {
    // A signature over an unparseable expiry, assembled by hand.
    const badMs = "not-a-date";
    const bound = [createHash("sha256").update(TOKEN, "utf8").digest("hex"), CAPABILITY, badMs].join(".");
    const sig = createHmac("sha256", process.env.APPOINTMENT_SIGNING_SECRET as string).update(bound).digest("hex");
    cookieJar.set("wl_proof_capability", `${CAPABILITY}.${badMs}.${sig}`);
    expect((await loadInvitationAction(TOKEN)).kind).toBe("proof");
  });

  it("stores the database's own expiry, not one invented here", async () => {
    const dbExpiry = "2099-01-01T00:00:00.000Z";
    completeRecipientProof.mockResolvedValue({
      kind: "verified", rawCapability: CAPABILITY, expiresAt: dbExpiry,
    });
    await submitInvitationProofAction(TOKEN, CODE, { maskedContact: "c•••@e.test", expiresAt: "x" });
    // Stored as epoch millis, but it is the DATABASE's instant, not a local one.
    expect(cookieJar.get("wl_proof_capability")).toContain(String(Date.parse(dbExpiry)));
  });
});

// P3-B. Proof succeeded but the capability could not be kept; the action used to
// claim `proven` anyway and then refuse every Book for want of a cookie it had
// never written.
describe("P3-B — proof is not claimed when it cannot be retained", () => {
  const REAL = process.env.APPOINTMENT_SIGNING_SECRET;
  afterEach(() => { process.env.APPOINTMENT_SIGNING_SECRET = REAL; });

  it("says so instead of painting an unusable slot list", async () => {
    delete process.env.APPOINTMENT_SIGNING_SECRET;
    completeRecipientProof.mockResolvedValue({
      kind: "verified", rawCapability: CAPABILITY, expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    const out = await submitInvitationProofAction(TOKEN, CODE, { maskedContact: "c•••@e.test", expiresAt: "x" });
    expect(out.kind, "an unusable offer must not be rendered as proven").toBe("proof");
    if (out.kind !== "proof") throw new Error("unreachable");
    expect(out.notice).toBe("proof_not_retained");
    expect(cookieJar.has("wl_proof_capability")).toBe(false);
  });

  // P3-C. A cookie already in the jar must not survive the failure: `complete_`
  // has just overwritten the invitation's capability hash, so the old one is
  // dead at the database -- but its signature is still valid and its expiry has
  // not passed, so a reload would render it as proven and contradict the message
  // the recipient was just given.
  it("clears a cookie already in the jar rather than leaving a live-looking one", async () => {
    cookieJar.set("wl_proof_capability", signedCapability(TOKEN, CAPABILITY));
    delete process.env.APPOINTMENT_SIGNING_SECRET;
    completeRecipientProof.mockResolvedValue({
      kind: "verified", rawCapability: CAPABILITY, expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    const out = await submitInvitationProofAction(TOKEN, CODE, { maskedContact: "c•••@e.test", expiresAt: "x" });
    expect(out.kind).toBe("proof");
    expect(cookieJar.has("wl_proof_capability"), "a stale cookie must not survive").toBe(false);
  });

  it("with the secret present, proof still lands normally", async () => {
    completeRecipientProof.mockResolvedValue({
      kind: "verified", rawCapability: CAPABILITY, expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    const out = await submitInvitationProofAction(TOKEN, CODE, { maskedContact: "c•••@e.test", expiresAt: "x" });
    expect(out.kind).toBe("offer");
  });
});
