import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  resolveFinishAppointmentState,
  chartingLabel,
  aftercareLabel,
  completionLabel,
  postcareLabel,
  type FinishAppointmentInput,
} from "@/lib/sessions/finish-appointment";

// Chloe finishes charting and the two visit-closing actions live on a different
// page, so they get forgotten. These prove the presenter that brings them into
// one workflow, and prove it decides only what to SHOW, never what is allowed.

const NOW = Date.parse("2026-07-31T15:00:00Z");
// B6: explicit completion is keyed on the appointment having STARTED. These
// fixtures are named for that, and every appointment carries BOTH clocks so a
// test can never accidentally prove the completion rule using ends_at.
const STARTED = "2026-07-31T14:30:00Z";
const NOT_STARTED = "2026-07-31T15:30:00Z";
const ENDED = "2026-07-31T14:45:00Z";

function input(over: Partial<FinishAppointmentInput> = {}): FinishAppointmentInput {
  return {
    chartedBlockCount: 1,
    aftercareExplainedAt: null,
    appointment: { id: "appt-1", status: "confirmed", startsAt: STARTED, endsAt: ENDED },
    clientEmail: "client@example.test",
    postcareConfigured: true,
    isOwner: true,
    postcareSentAt: null,
    postcareFailedAt: null,
    postcareClaimedAt: null,
    postcareSendAttempts: 0,
    serviceModality: "electrolysis",
    nowMs: NOW,
    ...over,
  };
}

describe("1-2. treatment chart state", () => {
  it("a session with live charted passes reads as charted", () => {
    expect(resolveFinishAppointmentState(input({ chartedBlockCount: 2 })).charting).toBe(
      "charted",
    );
    expect(chartingLabel("charted")).toBe("Charting recorded");
  });

  it("an empty session reads as empty, and is NOT blocked from completing", () => {
    const s = resolveFinishAppointmentState(input({ chartedBlockCount: 0 }));
    expect(s.charting).toBe("empty");
    expect(chartingLabel("empty")).toBe("No treatment charted yet");
    // Informational only: completion is still offered. Introducing a clinical
    // lock here would be a NEW restriction that does not exist today.
    expect(s.completion.kind).toBe("ready");
  });

  it("deleted/voided passes do not count (the caller passes LIVE blocks only)", () => {
    // The count is the live-block count by contract; zero live blocks reads as
    // empty even when the session once had passes.
    expect(resolveFinishAppointmentState(input({ chartedBlockCount: 0 })).charting).toBe(
      "empty",
    );
  });
});

describe("3. risks & aftercare explained", () => {
  it("recorded when the stamp exists, not marked otherwise", () => {
    expect(
      resolveFinishAppointmentState(input({ aftercareExplainedAt: "2026-07-31T14:00:00Z" }))
        .aftercare,
    ).toBe("recorded");
    expect(resolveFinishAppointmentState(input({ aftercareExplainedAt: null })).aftercare).toBe(
      "not_marked",
    );
    expect(aftercareLabel("recorded")).toBe("Recorded");
    expect(aftercareLabel("not_marked")).toBe("Not marked");
  });

  it("is never inferred from completion or from a postcare send", () => {
    const s = resolveFinishAppointmentState(
      input({
        aftercareExplainedAt: null,
        appointment: { id: "a", status: "completed", startsAt: STARTED, endsAt: ENDED },
        postcareSentAt: "2026-07-31T14:45:00Z",
      }),
    );
    // Completed AND postcare sent, and the stamp is still honestly unmarked.
    expect(s.aftercare).toBe("not_marked");
  });
});

describe("4-8. completion state, keyed to the appointment", () => {
  it("confirmed BEFORE the start time is not offerable", () => {
    const s = resolveFinishAppointmentState(
      input({ appointment: { id: "a", status: "confirmed", startsAt: NOT_STARTED, endsAt: NOT_STARTED } }),
    );
    expect(s.completion.kind).toBe("before_start");
    expect(completionLabel(s.completion)).toBe("Available once the appointment has started");
  });

  it("confirmed AFTER the start time is offerable, carrying the appointment id", () => {
    const s = resolveFinishAppointmentState(input());
    expect(s.completion).toEqual({ kind: "ready", appointmentId: "appt-1", startsAt: STARTED });
  });

  it("completed is terminal: no action", () => {
    const s = resolveFinishAppointmentState(
      input({ appointment: { id: "a", status: "completed", startsAt: STARTED, endsAt: ENDED } }),
    );
    expect(s.completion.kind).toBe("completed");
    expect(completionLabel(s.completion)).toBe("Completed");
  });

  it("cancelled is terminal: no action", () => {
    const s = resolveFinishAppointmentState(
      input({ appointment: { id: "a", status: "cancelled", startsAt: STARTED, endsAt: ENDED } }),
    );
    expect(s.completion.kind).toBe("cancelled");
  });

  it("no_show is terminal: no action", () => {
    const s = resolveFinishAppointmentState(
      input({ appointment: { id: "a", status: "no_show", startsAt: STARTED, endsAt: ENDED } }),
    );
    expect(s.completion.kind).toBe("no_show");
  });

  it("an unlinked session has no completion and no postcare, but still shows the rest", () => {
    const s = resolveFinishAppointmentState(input({ appointment: null }));
    expect(s.isUnlinked).toBe(true);
    expect(s.completion.kind).toBe("unlinked");
    expect(s.postcare.kind).toBe("unlinked");
    // Charting and aftercare remain meaningful without an appointment.
    expect(s.charting).toBe("charted");
    expect(s.aftercare).toBe("not_marked");
    expect(completionLabel(s.completion)).toBe("No booked appointment linked");
  });

  it("an unparseable end time fails CLOSED (not offerable)", () => {
    const s = resolveFinishAppointmentState(
      input({ appointment: { id: "a", status: "confirmed", startsAt: null, endsAt: null } }),
    );
    expect(s.completion.kind).toBe("before_start");
  });
});

describe("10-14. postcare state", () => {
  it("not sent, with everything configured", () => {
    const s = resolveFinishAppointmentState(input());
    expect(s.postcare).toEqual({
      kind: "not_sent",
      requiresConsultationConfirmation: false,
    });
    expect(postcareLabel(s.postcare)).toBe("Not sent yet");
  });

  it("sending = a FRESH claim with no outcome yet", () => {
    const s = resolveFinishAppointmentState(
      input({ postcareClaimedAt: new Date(NOW - 30_000).toISOString() }),
    );
    expect(s.postcare.kind).toBe("sending");
  });

  it("a STALE claim is not 'sending', the sender died", () => {
    const s = resolveFinishAppointmentState(
      input({ postcareClaimedAt: new Date(NOW - 6 * 60_000).toISOString() }),
    );
    expect(s.postcare.kind).toBe("not_sent");
  });

  it("failed carries the attempt count and allows explicit retry", () => {
    const s = resolveFinishAppointmentState(
      input({ postcareFailedAt: "2026-07-31T14:50:00Z", postcareSendAttempts: 2 }),
    );
    expect(s.postcare).toEqual({ kind: "failed", attempts: 2 });
    expect(postcareLabel(s.postcare)).toBe("Postcare send failed");
  });

  it("sent requires a provider-confirmed sent_at, a claim alone is NOT sent", () => {
    const claimedOnly = resolveFinishAppointmentState(
      input({ postcareClaimedAt: new Date(NOW - 10_000).toISOString(), postcareSendAttempts: 1 }),
    );
    expect(claimedOnly.postcare.kind).not.toBe("sent");
    const sent = resolveFinishAppointmentState(
      input({ postcareSentAt: "2026-07-31T14:45:00Z", postcareSendAttempts: 1 }),
    );
    expect(sent.postcare).toEqual({
      kind: "sent",
      sentAt: "2026-07-31T14:45:00Z",
      attempts: 1,
    });
  });

  it("sent WINS over a later failed resend, the client did receive one", () => {
    const s = resolveFinishAppointmentState(
      input({
        postcareSentAt: "2026-07-31T14:45:00Z",
        postcareFailedAt: "2026-07-31T14:55:00Z",
        postcareSendAttempts: 2,
      }),
    );
    expect(s.postcare.kind).toBe("sent");
  });
});

describe("15-17. postcare unavailability and consultation", () => {
  it("no client email → an explicit unavailable state, not a send button", () => {
    for (const email of [null, "", "   "]) {
      const s = resolveFinishAppointmentState(input({ clientEmail: email }));
      expect(s.postcare.kind).toBe("no_client_email");
      expect(postcareLabel(s.postcare)).toBe("Postcare unavailable: no client email");
    }
  });

  it("postcare not configured → owner and non-owner get different guidance", () => {
    const owner = resolveFinishAppointmentState(
      input({ postcareConfigured: false, isOwner: true }),
    );
    expect(owner.postcare).toEqual({ kind: "not_configured", isOwner: true });
    const member = resolveFinishAppointmentState(
      input({ postcareConfigured: false, isOwner: false }),
    );
    expect(member.postcare).toEqual({ kind: "not_configured", isOwner: false });
  });

  it("a consultation requires the treatment-performed confirmation", () => {
    const s = resolveFinishAppointmentState(input({ serviceModality: "consultation" }));
    expect(s.postcare).toEqual({
      kind: "not_sent",
      requiresConsultationConfirmation: true,
    });
  });

  it("an ALREADY SENT postcare is still 'sent' even with no client email now", () => {
    // The email left; deleting the address later cannot un-send it.
    const s = resolveFinishAppointmentState(
      input({ clientEmail: null, postcareSentAt: "2026-07-31T14:45:00Z" }),
    );
    expect(s.postcare.kind).toBe("sent");
  });
});

describe("18-19. purity and the injected clock", () => {
  it("does not mutate its input", () => {
    const one = input();
    const snapshot = JSON.parse(JSON.stringify(one));
    resolveFinishAppointmentState(one);
    expect(JSON.parse(JSON.stringify(one))).toEqual(snapshot);
  });

  it("is deterministic for the same input", () => {
    const one = input();
    expect(JSON.stringify(resolveFinishAppointmentState(one))).toBe(
      JSON.stringify(resolveFinishAppointmentState(one)),
    );
  });

  // B6: the boundary moved from ends_at to starts_at, and stayed INCLUSIVE.
  // Exactly starts_at is ready; one millisecond earlier is not. This mirrors
  // mark_appointment_complete's `starts_at > now()` refusal, so the presenter
  // cannot offer a button the database would reject.
  it("the boundary AT starts_at counts as started (inclusive)", () => {
    const startsAt = "2026-07-31T15:00:00Z";
    const endsAt = "2026-07-31T16:00:00Z";
    const exactly = resolveFinishAppointmentState(
      input({
        appointment: { id: "a", status: "confirmed", startsAt, endsAt },
        nowMs: Date.parse(startsAt),
      }),
    );
    expect(exactly.completion.kind).toBe("ready");
    const oneMsBefore = resolveFinishAppointmentState(
      input({
        appointment: { id: "a", status: "confirmed", startsAt, endsAt },
        nowMs: Date.parse(startsAt) - 1,
      }),
    );
    expect(oneMsBefore.completion.kind).toBe("before_start");
  });

  // The rule that makes B6 safe: a visit that has begun but NOT ended is
  // explicitly completable. Under the old ends_at rule this was "before_end".
  it("MID-VISIT: started but not ended is READY (the whole point of B6)", () => {
    const s = resolveFinishAppointmentState(
      input({
        appointment: {
          id: "a",
          status: "confirmed",
          startsAt: "2026-07-31T14:30:00Z",
          endsAt: "2026-07-31T15:30:00Z",
        },
        nowMs: Date.parse("2026-07-31T15:00:00Z"),
      }),
    );
    expect(s.completion.kind).toBe("ready");
  });

  it("reads no clock of its own", () => {
    const SRC = readFileSync(
      join(process.cwd(), "lib/sessions/finish-appointment.ts"),
      "utf8",
    );
    expect(SRC).not.toContain("Date.now");
    expect(SRC).not.toMatch(/new Date\(\)/);
  });
});

describe("20. the presenter is NOT authorization", () => {
  it("performs no I/O, imports nothing, and writes nothing", () => {
    const SRC = readFileSync(
      join(process.cwd(), "lib/sessions/finish-appointment.ts"),
      "utf8",
    );
    for (const forbidden of [
      "import ",
      "supabase",
      "fetch(",
      "await ",
      "insert",
      "update(",
      "createClient",
      "Action(",
    ]) {
      expect(SRC, `must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("documents that the server actions and RPCs stay authoritative", () => {
    const SRC = readFileSync(
      join(process.cwd(), "lib/sessions/finish-appointment.ts"),
      "utf8",
    );
    expect(SRC).toMatch(/mark_appointment_complete[\s\S]{0,200}authority/);
    expect(SRC).toMatch(/re-derived server-side/);
  });

  it("never returns a permission/allowed flag that a caller could treat as a grant", () => {
    const s = resolveFinishAppointmentState(input());
    const json = JSON.stringify(s);
    expect(json).not.toMatch(/"(canComplete|allowed|authorized|permitted)"/);
  });
});
