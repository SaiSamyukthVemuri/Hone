import { beforeEach, describe, expect, it, vi } from "vitest";

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

const cookieJar = new Map<string, string>();
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

vi.mock("@/lib/rate-limit/public", () => ({
  limitPublicSlots: async () => ({ allowed: true }),
  RATE_LIMIT_MESSAGE: "rate limited",
}));

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      Object.assign(chain, {
        select: self, eq: self,
        maybeSingle: async () =>
          table === "studios"
            ? { data: { slug: "studio-a", name: "Studio A", timezone: "America/Toronto" }, error: null }
            : table === "services"
              ? { data: { name: "Consultation", default_duration_minutes: 45 }, error: null }
              : { data: { name: "Chloe", email: "chloe@example.test" }, error: null },
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
  cookieJar.clear();
  for (const m of [resolveInvitation, beginRecipientProof, completeRecipientProof,
                   declineInvitation, fetchPublicSlotsAction, publicBookAppointmentAction]) m.mockReset();
  resolveInvitation.mockResolvedValue(liveResolve());
  fetchPublicSlotsAction.mockResolvedValue({ ok: true, slots: [] });
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
    cookieJar.set("wl_proof_capability", CAPABILITY);
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
    cookieJar.set("wl_proof_capability", CAPABILITY);
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
    // The capability went to an httpOnly cookie instead.
    expect(cookieJar.get("wl_proof_capability")).toBe(CAPABILITY);
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

  it("the first paint carries no invitation identifiers at all", async () => {
    const strings = allStrings(await loadInvitationAction(TOKEN));
    for (const secret of ["d".repeat(64), ENTRY, STUDIO, "inv-1"]) {
      expect(strings, `${secret} must not reach the browser`).not.toContain(secret);
    }
  });
});

describe("out-of-scope slots are never serialised", () => {
  beforeEach(() => {
    cookieJar.set("wl_proof_capability", CAPABILITY);
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
  beforeEach(() => { cookieJar.set("wl_proof_capability", CAPABILITY); });

  it("a CONSUMED invitation becomes terminal, not a live offer", async () => {
    publicBookAppointmentAction.mockResolvedValue({
      ok: false, code: "invitation_consumed",
      error: "Your invitation has been used, but we couldn't finish the booking.",
    });
    const out = await bookInvitationSlotAction(TOKEN, "2026-10-07T14:00:00.000Z");
    expect(out.kind).toBe("closed");
    if (out.kind !== "closed") throw new Error("unreachable");
    expect(out.reason).toBe("already_redeemed");
    // The capability authorises nothing now and must not survive.
    expect(cookieJar.has("wl_proof_capability")).toBe(false);
  });

  it.each([
    ["slot_taken", "slot_taken"],
    ["invitation_refused", "not_permitted"],
  ])("a %s refusal keeps the offer AND states the reason", async (code, refusal) => {
    publicBookAppointmentAction.mockResolvedValue({ ok: false, code, error: "x" });
    const out = await bookInvitationSlotAction(TOKEN, "2026-10-07T14:00:00.000Z");
    expect(out.kind).toBe("offer");
    if (out.kind !== "offer") throw new Error("unreachable");
    expect(out.refusal).toBe(refusal);
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
