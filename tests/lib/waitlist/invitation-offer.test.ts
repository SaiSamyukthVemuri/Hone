import { describe, expect, it } from "vitest";
import {
  deriveInvitationViewState,
  describeScopeWindow,
  filterSlotsToScope,
  isProofLapse,
  proofStageFromBegin,
  groupSlotsByDay,
  proofStageFromComplete,
  slotWithinScope,
  type OfferedSlot,
  type OfferPresentation,
  type RecipientContext,
} from "@/lib/waitlist/invitation-offer";
import type { InvitationScope } from "@/lib/booking/waitlist-invitation-scope";
import type { ResolvedInvitation } from "@/lib/booking/waitlist-invitation";

// WAIT-03 B3 bound to B2's accepted interface.
//
// THE BINDING CAUGHT A REAL DEFECT, and these assertions pin it. The pure slice
// modelled the window itself and read an EMPTY `allowedWeekdays` as "every
// day". B1's canonical rule is the opposite: NULL means every day, and an empty
// array authorises NOTHING. An offer carrying `[]` would have rendered every
// day while the server refused all of them.
//
// So the weekday numbering and the window rule are B2's, reached through B2's
// own `evaluateInvitationScope`. Nothing here restates either.

const TZ = "America/Toronto";

// Studio-local Mondays and Wednesdays. 0 = Sunday is `extract(dow)`, which is
// B1's stored convention -- quoted here, never decided here.
const MON = 1;
const WED = 3;

const SCOPE: InvitationScope = {
  serviceId: "svc-1",
  startDate: "2026-09-07", // Monday
  endDate: "2026-09-11",   // Friday
  allowedWeekdays: [MON, WED],
};

const PRESENTATION: OfferPresentation = {
  studioName: "Willow Electrolysis",
  serviceName: "Consultation",
  serviceDurationMinutes: 30,
  studioTimezone: TZ,
};

const INVITATION: ResolvedInvitation = {
  invitationId: "inv-1",
  studioId: "studio-1",
  entryId: "entry-1",
  scope: SCOPE,
  expiresAt: "2026-09-08T12:00:00.000Z",
  recipientContactHash: "hash",
};

/** 13:00Z is 09:00 in Toronto, so the studio-local date is unambiguous. */
function slot(localDate: string): OfferedSlot {
  return {
    start: `${localDate}T13:00:00.000Z`,
    end: `${localDate}T13:30:00.000Z`,
    startLabel: "9:00 AM",
  };
}

function ctx(over: Partial<RecipientContext> = {}): RecipientContext {
  return {
    resolve: { kind: "live", invitation: INVITATION },
    presentation: PRESENTATION,
    proof: { kind: "proven" },
    slots: [],
    booked: null,
    declined: false,
    ...over,
  };
}

describe("the window rule is B2's, not B3's", () => {
  it("admits a permitted weekday inside the range", () => {
    expect(slotWithinScope(SCOPE, TZ, slot("2026-09-07"))).toBe(true);
    expect(slotWithinScope(SCOPE, TZ, slot("2026-09-09"))).toBe(true);
  });

  it("refuses a non-permitted weekday inside the range", () => {
    expect(slotWithinScope(SCOPE, TZ, slot("2026-09-08"))).toBe(false);
  });

  it("refuses dates outside the range", () => {
    expect(slotWithinScope(SCOPE, TZ, slot("2026-09-06"))).toBe(false);
    expect(slotWithinScope(SCOPE, TZ, slot("2026-09-14"))).toBe(false);
  });

  it("NULL weekdays means every day in the range — B1's documented semantics", () => {
    const open = { ...SCOPE, allowedWeekdays: null };
    expect(slotWithinScope(open, TZ, slot("2026-09-08"))).toBe(true);
    expect(slotWithinScope(open, TZ, slot("2026-09-11"))).toBe(true);
    expect(slotWithinScope(open, TZ, slot("2026-09-12"))).toBe(false); // still bounded
  });

  it("an EMPTY weekday list authorises NOTHING — the inverse of the pure slice", () => {
    // The defect binding caught. `[]` must fail closed, not read as "any day".
    const none = { ...SCOPE, allowedWeekdays: [] as readonly number[] };
    for (const d of ["2026-09-07", "2026-09-08", "2026-09-09", "2026-09-11"]) {
      expect(slotWithinScope(none, TZ, slot(d)), `${d} was admitted by an empty list`).toBe(false);
    }
  });

  it("the weekday is studio-local, not UTC", () => {
    // 01:00Z Tuesday is still Monday evening in Toronto, so a Mondays-only
    // offer must admit it. A naive UTC read would refuse.
    const lateMonday: OfferedSlot = {
      start: "2026-09-08T01:00:00.000Z",
      end: "2026-09-08T01:30:00.000Z",
      startLabel: "9:00 PM",
    };
    expect(slotWithinScope(SCOPE, TZ, lateMonday)).toBe(true);
  });

  it("fails closed on an unreadable instant", () => {
    expect(slotWithinScope(SCOPE, TZ, { start: "nope", end: "nope", startLabel: "x" })).toBe(false);
  });

  it("filters a leaked out-of-scope slot even if the server sent it", () => {
    const leaked = [slot("2026-09-07"), slot("2026-09-08"), slot("2027-01-01")];
    expect(filterSlotsToScope(SCOPE, TZ, leaked)).toHaveLength(1);
  });
});

describe("the horizon in words", () => {
  it("names the permitted weekdays and the span", () => {
    const described = describeScopeWindow(SCOPE);
    expect(described).toContain("Mondays, Wednesdays");
    expect(described).toContain("Sep 7, 2026");
  });

  it("NULL weekdays describes only the span", () => {
    const described = describeScopeWindow({ ...SCOPE, allowedWeekdays: null });
    expect(described).not.toContain("Mondays");
    expect(described).toContain("Sep 7, 2026");
  });

  it("an EMPTY list says nothing is offered rather than implying everything", () => {
    expect(describeScopeWindow({ ...SCOPE, allowedWeekdays: [] })).toBe(
      "No days are currently offered",
    );
  });
});

describe("the view state maps B2's outcomes", () => {
  it("a null resolve is loading", () => {
    expect(deriveInvitationViewState(ctx({ resolve: null })).kind).toBe("loading");
  });

  it("possession alone shows the OFFER but no times", () => {
    const state = deriveInvitationViewState(
      ctx({ proof: { kind: "required" }, slots: [slot("2026-09-07")] }),
    );
    expect(state.kind).toBe("proof");
    // The slot list is not even constructed before proof.
    expect(JSON.stringify(state)).not.toContain("9:00 AM");
  });

  it("proof unlocks the times, already narrowed", () => {
    const state = deriveInvitationViewState(
      ctx({ slots: [slot("2026-09-07"), slot("2026-09-08")] }),
    );
    expect(state.kind).toBe("offer");
    if (state.kind === "offer") {
      expect(state.days).toHaveLength(1);
      expect(state.days[0].slots).toHaveLength(1);
    }
  });

  it("a live invitation with nothing bookable is EMPTY, not closed", () => {
    const state = deriveInvitationViewState(ctx({ slots: [] }));
    expect(state.kind).toBe("offer");
    // Emptiness is now structural: no days IS empty, with no flag to contradict.
    if (state.kind === "offer") expect(state.days).toEqual([]);
  });

  for (const [wire, shown] of [
    ["expired", "expired"],
    ["released", "revoked"],
    ["already_redeemed", "already_redeemed"],
    ["declined", "declined"],
  ] as const) {
    it(`B2's \`${wire}\` renders as the \`${shown}\` dead end`, () => {
      const state = deriveInvitationViewState(ctx({ resolve: { kind: wire } }));
      expect(state.kind).toBe("closed");
      if (state.kind === "closed") expect(state.reason).toBe(shown);
    });
  }

  it("invalid_token and unscoped are indistinguishable", () => {
    const a = deriveInvitationViewState(ctx({ resolve: { kind: "invalid_token" } }));
    const b = deriveInvitationViewState(ctx({ resolve: { kind: "unscoped" } }));
    expect(a).toEqual(b);
    expect(a).toEqual({ kind: "error", retryable: false });
  });

  it("B2's `unavailable` is retryable, because it means IN DOUBT", () => {
    expect(deriveInvitationViewState(ctx({ resolve: { kind: "unavailable" } }))).toEqual({
      kind: "error",
      retryable: true,
    });
  });

  it("a completed booking OUTRANKS the resolve verdict", () => {
    // The resolve after a successful redeem legitimately says already_redeemed.
    // Showing a dead end to someone who just booked would be a lie.
    const state = deriveInvitationViewState(
      ctx({
        resolve: { kind: "already_redeemed" },
        booked: { startLabel: "9:00 AM", dateLabel: "Mon, Sep 7" },
      }),
    );
    expect(state.kind).toBe("booked");
  });

  it("a completed decline outranks it too", () => {
    expect(
      deriveInvitationViewState(ctx({ resolve: { kind: "declined" }, declined: true })).kind,
    ).toBe("declined");
  });
});

describe("the proof exchange maps B1.5c's outcomes", () => {
  it("a challenge issued becomes the code entry stage, masked", () => {
    expect(
      proofStageFromBegin({
        kind: "challenge_issued",
        // Both server-only fields are present on the outcome and MUST NOT survive
        // into the view state -- that is exactly what this mapping asserts.
        proofChallengeId: "9f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f",
        rawChallenge: "c".repeat(64),
        expiresAt: "2026-09-07T13:00:00.000Z",
        deliveryContact: "someone@example.com",
        maskedContact: "s•••••@example.com",
      }),
    ).toEqual({
      kind: "sent",
      maskedContact: "s•••••@example.com",
      expiresAt: "2026-09-07T13:00:00.000Z",
    });
  });

  it("an unavailable begin is retryable; a refusal is not", () => {
    expect(proofStageFromBegin({ kind: "unavailable" })).toEqual({
      kind: "unavailable",
      retryable: true,
    });
    for (const kind of ["invalid_token", "not_live", "invalid_input"] as const) {
      expect(proofStageFromBegin({ kind })).toEqual({ kind: "unavailable", retryable: false });
    }
  });

  const prior = { maskedContact: "s•••••@example.com", expiresAt: "2026-09-07T13:00:00.000Z" };

  it("verified is proven", () => {
    expect(
      proofStageFromComplete(
        { kind: "verified", rawCapability: "cap", expiresAt: "x" },
        prior,
      ),
    ).toEqual({ kind: "proven" });
  });

  it("every recoverable failure keeps the recipient on the code screen", () => {
    for (const kind of [
      "wrong_challenge",
      "challenge_expired",
      "too_many_attempts",
      "no_challenge",
      "recipient_changed",
    ] as const) {
      const stage = proofStageFromComplete({ kind }, prior);
      expect(stage.kind).toBe("failed");
      if (stage.kind === "failed") expect(stage.reason).toBe(kind);
    }
  });
});

describe("a lapsed proof is recoverable, not a dead end", () => {
  it("recognises every proof lapse from redeem and decline", () => {
    for (const kind of ["proof_required", "proof_expired", "proof_invalid"] as const) {
      expect(isProofLapse({ kind })).toBe(true);
    }
  });

  it("does not treat a real refusal as a lapse", () => {
    expect(isProofLapse({ kind: "not_live" })).toBe(false);
    expect(isProofLapse({ kind: "invalid_token" })).toBe(false);
    expect(isProofLapse({ kind: "redeemed", studioId: "s", entryId: "e" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// REVIEW P1 — a multi-day offer must not render indistinguishable buttons.
//
// "Mondays and Wednesdays" is the ordinary shape, and both days can offer 9:00
// AM. A flat list renders that as two identical controls and the recipient
// books the wrong day. The window description gives the RANGE and cannot
// disambiguate an individual button, so the day travels with the slots.
// ---------------------------------------------------------------------------
describe("slots carry their studio-local day", () => {
  it("groups by day, chronologically, and names each one", () => {
    const days = groupSlotsByDay(TZ, [slot("2026-09-09"), slot("2026-09-07")]);
    expect(days.map((d) => d.date)).toEqual(["2026-09-07", "2026-09-09"]);
    expect(days[0].dateLabel).toContain("Sep 7");
    expect(days[0].dateLabel).toContain("Mon");
    expect(days[1].dateLabel).toContain("Wed");
  });

  it("keeps times ordered inside a day", () => {
    const early = { start: "2026-09-07T13:00:00.000Z", end: "x", startLabel: "9:00 AM" };
    const late = { start: "2026-09-07T18:00:00.000Z", end: "x", startLabel: "2:00 PM" };
    const days = groupSlotsByDay(TZ, [late, early]);
    expect(days[0].slots.map((s) => s.startLabel)).toEqual(["9:00 AM", "2:00 PM"]);
  });

  it("the day is STUDIO-local, not UTC", () => {
    // 01:00Z Tuesday is Monday evening in Toronto and must file under Monday.
    const lateMonday = { start: "2026-09-08T01:00:00.000Z", end: "x", startLabel: "9:00 PM" };
    expect(groupSlotsByDay(TZ, [lateMonday])[0].date).toBe("2026-09-07");
  });

  it("drops an unreadable instant rather than filing it under a guessed day", () => {
    expect(groupSlotsByDay(TZ, [{ start: "nope", end: "x", startLabel: "?" }])).toEqual([]);
  });

  it("the offer state exposes the grouped days", () => {
    const state = deriveInvitationViewState(
      ctx({ slots: [slot("2026-09-07"), slot("2026-09-09")] }),
    );
    expect(state.kind).toBe("offer");
    if (state.kind === "offer") {
      expect(state.days).toHaveLength(2);
      expect(state.days.flatMap((d) => d.slots)).toHaveLength(2);
    }
  });
});

// ---------------------------------------------------------------------------
// REVIEW P2 — a proof outcome that is terminal must not be rendered as
// recoverable. The catch-all sent `not_live` and `invalid_token` to the code
// form, which then said "no longer available" above a live Confirm and Resend.
// ---------------------------------------------------------------------------
describe("terminal proof outcomes are terminal", () => {
  const prior = { maskedContact: "s\u2022\u2022\u2022@example.com", expiresAt: "2026-09-07T13:00:00.000Z" };

  for (const kind of ["not_live", "invalid_token"] as const) {
    it(`${kind} is a dead end, not a retry`, () => {
      expect(proofStageFromComplete({ kind }, prior)).toEqual({
        kind: "unavailable",
        retryable: false,
      });
    });
  }

  it("genuinely recoverable failures still return to the code form", () => {
    for (const kind of ["wrong_challenge", "challenge_expired", "too_many_attempts"] as const) {
      expect(proofStageFromComplete({ kind }, prior).kind).toBe("failed");
    }
  });
});

// ---------------------------------------------------------------------------
// REVIEW P2 — the client boundary. The offer state carried B2's whole
// `ResolvedInvitation` into a `"use client"` component that never read it,
// shipping a hash of the recipient's email to the browser for nothing.
// ---------------------------------------------------------------------------
describe("no invitation authority crosses to the client", () => {
  it("the offer state carries no invitation field at all", () => {
    const state = deriveInvitationViewState(ctx({ slots: [slot("2026-09-07")] }));
    expect(state.kind).toBe("offer");
    if (state.kind !== "offer") return;
    // A narrower TYPE was not a boundary: structural assignability lets a
    // caller pass a whole ResolvedInvitation into a narrower slot, and React
    // serialises every key. A property that does not exist cannot leak.
    expect(Object.keys(state)).not.toContain("invitation");
  });

  it("nothing internal appears in the SERIALISED state", () => {
    const state = deriveInvitationViewState(ctx({ slots: [slot("2026-09-07")] }));
    const wire = JSON.stringify(state);
    for (const secret of ["hash", "entry-1", "studio-1", "allowedWeekdays", "inv-1"]) {
      expect(wire, `${secret} reached the client`).not.toContain(secret);
    }
  });
});

// ---------------------------------------------------------------------------
// REVIEW P2 — recovery is an explicit allowlist, so a future terminal outcome
// cannot become recoverable by omission.
// ---------------------------------------------------------------------------
describe("proof-failure recovery is opt-in", () => {
  const prior = { maskedContact: "s\u2022\u2022\u2022@example.com", expiresAt: "2026-09-07T13:00:00.000Z" };

  it("classifies every CompleteProofOutcome kind explicitly", () => {
    const terminal = ["not_live", "invalid_token"] as const;
    const recoverable = [
      "wrong_challenge",
      "no_challenge",
      "challenge_expired",
      "too_many_attempts",
      "recipient_changed",
      "invalid_input",
    ] as const;

    for (const kind of terminal) {
      expect(proofStageFromComplete({ kind }, prior)).toEqual({
        kind: "unavailable",
        retryable: false,
      });
    }
    for (const kind of recoverable) {
      expect(proofStageFromComplete({ kind }, prior).kind).toBe("failed");
    }
    expect(proofStageFromComplete({ kind: "unavailable" }, prior)).toEqual({
      kind: "unavailable",
      retryable: true,
    });
  });
});

// ---------------------------------------------------------------------------
// REVIEW P2 — an empty day is now unrepresentable, so `days.length === 0`
// genuinely means nothing is bookable.
// ---------------------------------------------------------------------------
describe("a day always carries at least one slot", () => {
  it("grouping never emits a day with no slots", () => {
    const days = groupSlotsByDay(TZ, [slot("2026-09-07"), slot("2026-09-09")]);
    expect(days.length).toBeGreaterThan(0);
    for (const day of days) expect(day.slots.length).toBeGreaterThan(0);
  });

  it("no slots at all yields no days, rather than an empty day", () => {
    expect(groupSlotsByDay(TZ, [])).toEqual([]);
  });

  it("an unreadable instant cannot create an empty day", () => {
    const days = groupSlotsByDay(TZ, [{ start: "nope", end: "x", startLabel: "?" }]);
    expect(days).toEqual([]);
  });
});
