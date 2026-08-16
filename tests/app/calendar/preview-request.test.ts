import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  shouldApplyPreviewResponse,
  detailRemainsCurrent,
  shouldApplyPreviewFailure,
  shouldStartPreviewLoad,
  currentPreviewDetail,
} from "@/app/(app)/calendar/preview-request";

// The A -> B race. A practitioner scanning a week clicks fast; server actions
// carry no ordering guarantee, so appointment A's response can land after
// appointment B's. If it were applied, the drawer would show B's client name
// above A's last treatment, intake state and notes.
//
// NC5 ("remove stale-request protection") turns the guarded cases below red.

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("shouldApplyPreviewResponse — the happy path is genuinely reachable", () => {
  it("the newest response for the open appointment IS applied", () => {
    // The positive control. Without it every guard below could be satisfied by
    // a function that always returns false.
    expect(
      shouldApplyPreviewResponse({
        responseAppointmentId: A,
        requestedAppointmentId: A,
        requestSeq: 7,
        currentSeq: 7,
        openAppointmentId: A,
      }),
    ).toBe(true);
  });
});

describe("shouldApplyPreviewResponse — sequence", () => {
  it("A's late response is dropped once B has been requested", () => {
    // Click A (seq 1), click B (seq 2), A resolves last.
    expect(
      shouldApplyPreviewResponse({
        responseAppointmentId: A,
        requestedAppointmentId: A,
        requestSeq: 1,
        currentSeq: 2,
        openAppointmentId: B,
      }),
    ).toBe(false);
  });

  it("a superseded response for the SAME appointment is still dropped", () => {
    // Re-opening A, or reloading after a save, issues a new sequence. The older
    // in-flight response for the same id must not overwrite the newer one.
    // Identity alone would not catch this; the sequence is what does.
    expect(
      shouldApplyPreviewResponse({
        responseAppointmentId: A,
        requestedAppointmentId: A,
        requestSeq: 3,
        currentSeq: 4,
        openAppointmentId: A,
      }),
    ).toBe(false);
  });
});

describe("shouldApplyPreviewResponse — identity", () => {
  it("a response describing a DIFFERENT appointment is dropped even when the sequence matches", () => {
    // The structural backstop: this holds even if the sequence bookkeeping is
    // wrong, which is exactly when it matters.
    expect(
      shouldApplyPreviewResponse({
        responseAppointmentId: A,
        requestedAppointmentId: A,
        requestSeq: 5,
        currentSeq: 5,
        openAppointmentId: B,
      }),
    ).toBe(false);
  });
});

describe("shouldApplyPreviewResponse — closed drawer", () => {
  it("nothing is applied to a closed drawer", () => {
    expect(
      shouldApplyPreviewResponse({
        responseAppointmentId: A,
        requestedAppointmentId: A,
        requestSeq: 9,
        currentSeq: 9,
        openAppointmentId: null,
      }),
    ).toBe(false);
  });
});

describe("the drawer actually uses the rule", () => {
  const DRAWER = readFileSync(
    path.resolve(__dirname, "../../../app/(app)/calendar/AppointmentPreviewDrawer.tsx"),
    "utf8",
  );

  it("routes every successful response through shouldApplyPreviewResponse", () => {
    expect(DRAWER).toMatch(/shouldApplyPreviewResponse\(\{/);
    expect(DRAWER).toMatch(/responseAppointmentId: res\.detail\.appointmentId/);
    // NOT `openAppointmentId: id`. That spelling was the defect: it compares the
    // response to the id the CALLER captured, which for a late callback from a
    // closed appointment compares A to A and agrees. The open appointment must
    // be read live, from the ref.
    expect(DRAWER).toMatch(/openAppointmentId: openIdRef\.current/);
    expect(DRAWER).toMatch(/requestedAppointmentId: id/);
    expect(DRAWER).not.toMatch(/openAppointmentId: id,/);
  });

  it("takes a fresh sequence per request and closing invalidates in-flight work", () => {
    expect(DRAWER).toMatch(/const seq = \+\+requestSeq\.current/);
    // Closing bumps the sequence too, so a response still in flight is
    // abandoned rather than populating a drawer that is no longer open. It is
    // asserted as "the counter advances", not as one particular increment
    // spelling — the close path now also has to publish the new generation.
    expect(DRAWER).toMatch(/\+\+requestSeq\.current;\s*\n\s*setIssuedSeq\(seq\);\s*\n\s*setDetail\(null\)/);
  });

  it("publishes the issued generation into state so RENDER can see it", () => {
    // A ref read during render would not re-render when it changes, so the
    // currency check would go stale exactly when it matters.
    expect(DRAWER).toMatch(/setIssuedSeq\(seq\)/);
    expect(DRAWER).toMatch(/detailRemainsCurrent\(\{/);
    expect(DRAWER).toMatch(/issuedSeq,/);
  });

  it("routes BOTH failure paths through shouldApplyPreviewFailure", () => {
    // The !ok branch and the rejection branch. Either one applying a superseded
    // failure would report a stale error over a newer verified read.
    const matches = DRAWER.match(/shouldApplyPreviewFailure\(\{/g) ?? [];
    expect(matches.length).toBe(2);
  });

  it("holds the detail WITH the generation that produced it", () => {
    expect(DRAWER).toMatch(/setDetail\(\{ value: res\.detail, seq \}\)/);
  });

  it("refuses to START a load for an appointment that is not the open one", () => {
    expect(DRAWER).toMatch(/shouldStartPreviewLoad\(\{/);
    const body = DRAWER.slice(DRAWER.indexOf("const load = useCallback"));
    const guardAt = body.indexOf("shouldStartPreviewLoad");
    const seqAt = body.indexOf("++requestSeq.current");
    expect(guardAt).toBeGreaterThan(-1);
    expect(seqAt).toBeGreaterThan(-1);
    // ORDER IS THE POINT. Bailing out AFTER taking a sequence would still bump
    // the generation and strip the open appointment of its currency, so a
    // no-op callback would silently disable Cancel/Reschedule on someone else.
    expect(guardAt).toBeLessThan(seqAt);
  });

  it("publishes the open appointment id before the load that reads it", () => {
    const eff = DRAWER.slice(DRAWER.indexOf("openIdRef.current = appointmentId"));
    expect(eff).toMatch(/openIdRef\.current = appointmentId/);
    expect(eff.indexOf("load(appointmentId)")).toBeGreaterThan(0);
  });

  it("binds EVERY decision to the appointment actually open", () => {
    const matches = DRAWER.match(/openAppointmentId: openIdRef\.current/g) ?? [];
    // Four decisions read it live: the start guard, the !ok failure branch, the
    // success commit, and the rejection branch. A single one of them falling
    // back to the captured `id` reopens the cross-identity race.
    expect(matches.length).toBe(4);
  });

  it("gates the whole rendered block on currentPreviewDetail, never raw detail", () => {
    expect(DRAWER).toMatch(/currentPreviewDetail\(\{/);
    expect(DRAWER).toMatch(/renderedAppointmentId: a\.id/);
    // The rendered block and every appointment-scoped clinical field read the
    // GATED value. A single `detail.value.` left behind would paint the previous
    // client's data under this one's name for the transition render.
    expect(DRAWER).not.toMatch(/\bdetail\.value\./);
    expect(DRAWER).not.toMatch(/\bdetail\?\.value\./);
    expect(DRAWER).toMatch(/\{currentDetail && \(/);
  });

  it("derives currentDetail during RENDER, not inside an effect", () => {
    // The defect is a single render that happens BEFORE any effect runs, so a
    // fix that lives in an effect cannot reach it.
    const body = DRAWER.slice(DRAWER.indexOf("const a = appointment;"));
    const gateAt = body.indexOf("currentPreviewDetail({");
    const firstEffectAt = body.indexOf("useEffect(");
    expect(gateAt).toBeGreaterThan(-1);
    // Either there is no effect after it, or the gate comes first.
    expect(firstEffectAt === -1 || gateAt < firstEffectAt).toBe(true);
  });

  it("asks identity BEFORE freshness", () => {
    const body = DRAWER.slice(DRAWER.indexOf("const a = appointment;"));
    expect(body.indexOf("currentPreviewDetail({")).toBeLessThan(
      body.indexOf("detailRemainsCurrent({"),
    );
    // And freshness is asked of the GATED detail, never the raw one.
    expect(DRAWER).toMatch(/detailSeq: currentDetail\?\.seq \?\? null/);
  });

  it("clears the previous appointment's detail before loading the next", () => {
    // Without this the drawer would render A's prep under B's header for the
    // duration of B's load — a stale read that looks authoritative.
    expect(DRAWER).toMatch(/setDetail\(null\);\s*\n\s*load\(appointmentId\)/);
  });
});

// FRESHNESS HAS A LIFETIME, AND IT BELONGS TO A READ GENERATION.
//
// The drawer refreshes itself after a notes save. That refresh does not clear
// the detail it already holds, so a FAILED refresh used to leave the previous
// detail in place still marked current — and the drawer went on offering Cancel
// and Reschedule, on a schedule that may have changed, next to a load-error
// message. "Verified" is a statement about the newest read, not a property the
// retained object keeps forever.
//
// These are the sequence halves of that rule, kept pure for the same reason
// shouldApplyPreviewResponse is.
describe("detail currency is scoped to the newest read generation", () => {
  it("a detail from the newest issued generation IS current", () => {
    expect(detailRemainsCurrent({ detailSeq: 3, issuedSeq: 3 })).toBe(true);
  });

  it("STARTING a refresh immediately withdraws currency from the held detail", () => {
    // Requirement 1. Nothing has failed yet — the mere existence of a newer
    // in-flight generation means the held copy is no longer being asserted.
    expect(detailRemainsCurrent({ detailSeq: 1, issuedSeq: 2 })).toBe(false);
  });

  it("a FAILED current refresh leaves the held detail non-current", () => {
    // Requirement 2. Failure does not advance the detail, so the generation gap
    // persists and the drawer cannot call the old copy verified.
    expect(detailRemainsCurrent({ detailSeq: 1, issuedSeq: 2 })).toBe(false);
  });

  it("no detail at all is never current", () => {
    expect(detailRemainsCurrent({ detailSeq: null, issuedSeq: 1 })).toBe(false);
  });

  it("a RETRY that succeeds restores currency", () => {
    // Requirement 6.
    expect(detailRemainsCurrent({ detailSeq: 3, issuedSeq: 3 })).toBe(true);
  });
});

describe("a superseded failure may not disturb a newer success", () => {
  it("applies a failure only when it belongs to the newest generation", () => {
    expect(
      shouldApplyPreviewFailure({
        requestSeq: 2,
        currentSeq: 2,
        requestedAppointmentId: A,
        openAppointmentId: A,
      }),
    ).toBe(true);
  });

  it("IGNORES generation N's failure once N+1 has been issued", () => {
    // Requirement 5. N+1 may already have succeeded; N arriving late and
    // errorless-ly clearing state would undo a verified newer read.
    expect(
      shouldApplyPreviewFailure({
        requestSeq: 1,
        currentSeq: 2,
        requestedAppointmentId: A,
        openAppointmentId: A,
      }),
    ).toBe(false);
  });
});

// A RESULT BELONGS TO AN APPOINTMENT, NOT JUST TO A GENERATION.
//
// THE RACE. Notes are saved for A; before that save resolves the practitioner
// closes A and opens B; B loads and is current. Then A's save completes and its
// onSaved fires `load(A)` — which, being issued LAST, takes the NEWEST
// generation. Sequence alone therefore endorses it, and comparing the response
// to the id captured when load was called compares A to A and agrees. A's
// detail commits while B is on screen.
//
// The drawer's header comes from the appointment PROP (B) while everything
// inside the loaded block comes from the detail (A), so the result is B's name
// above A's allergies, A's treatment memory, A's notes, A's intake state and A's
// schedule — and lifecycle controls targeting B gated on A's actionability.
// That is a cross-client clinical mis-attribution, which is why identity has to
// be re-read at COMMIT time from what is actually open, never from what the
// caller remembered.
describe("a result may only commit to the appointment that is STILL open", () => {
  it("CASE A — the save/close/switch race: A's late refresh never starts", () => {
    // A's onSaved fires after B is open. The request must not even be issued:
    // issuing it would bump the generation and strip B of its currency.
    expect(
      shouldStartPreviewLoad({ requestedAppointmentId: "A", openAppointmentId: "B" }),
    ).toBe(false);
  });

  it("CASE B — a callback firing while the drawer is CLOSED is inert", () => {
    expect(
      shouldStartPreviewLoad({ requestedAppointmentId: "A", openAppointmentId: null }),
    ).toBe(false);
  });

  it("CASE E — the appointment still open may refresh itself (positive control)", () => {
    // Without this the rule could satisfy every case above by refusing
    // everything, which would silently break the notes-save refresh.
    expect(
      shouldStartPreviewLoad({ requestedAppointmentId: "B", openAppointmentId: "B" }),
    ).toBe(true);
  });

  it("CASE C — A's response is refused even when it OWNS the newest generation", () => {
    // The heart of it. Generation is satisfied here; only identity refuses.
    expect(
      shouldApplyPreviewResponse({
        responseAppointmentId: "A",
        requestedAppointmentId: "A",
        requestSeq: 2,
        currentSeq: 2,
        openAppointmentId: "B",
      }),
    ).toBe(false);
  });

  it("CASE C — and refused when it is merely superseded", () => {
    expect(
      shouldApplyPreviewResponse({
        responseAppointmentId: "A",
        requestedAppointmentId: "A",
        requestSeq: 1,
        currentSeq: 2,
        openAppointmentId: "B",
      }),
    ).toBe(false);
  });

  it("commits when response, request and the OPEN appointment all agree", () => {
    expect(
      shouldApplyPreviewResponse({
        responseAppointmentId: "B",
        requestedAppointmentId: "B",
        requestSeq: 2,
        currentSeq: 2,
        openAppointmentId: "B",
      }),
    ).toBe(true);
  });

  it("refuses a response describing an appointment nobody requested", () => {
    // Structural backstop: the server echoing a different row than we asked for
    // is unrenderable regardless of what is open.
    expect(
      shouldApplyPreviewResponse({
        responseAppointmentId: "C",
        requestedAppointmentId: "B",
        requestSeq: 2,
        currentSeq: 2,
        openAppointmentId: "B",
      }),
    ).toBe(false);
  });
});

describe("CASE D — a late failure may not damage the appointment now open", () => {
  it("A's failure does not put B into error, even owning the newest generation", () => {
    expect(
      shouldApplyPreviewFailure({
        requestSeq: 2,
        currentSeq: 2,
        requestedAppointmentId: "A",
        openAppointmentId: "B",
      }),
    ).toBe(false);
  });

  it("a failure arriving after the drawer closed is inert", () => {
    expect(
      shouldApplyPreviewFailure({
        requestSeq: 2,
        currentSeq: 2,
        requestedAppointmentId: "A",
        openAppointmentId: null,
      }),
    ).toBe(false);
  });

  it("B's OWN current failure is still reported (positive control)", () => {
    expect(
      shouldApplyPreviewFailure({
        requestSeq: 2,
        currentSeq: 2,
        requestedAppointmentId: "B",
        openAppointmentId: "B",
      }),
    ).toBe(true);
  });
});

// IDENTITY IS A RENDER-TIME QUESTION, NOT ONLY A CALLBACK ONE.
//
// The drawer is not remounted when the practitioner switches appointments —
// DayColumn renders <AppointmentPreviewDrawer appointment={preview}> with no
// key — so `detail` and `issuedSeq` survive the prop change. React therefore
// renders ONCE with appointment = B and detail = A before the passive effect
// clears it.
//
// On that render the sequence check still passes (nothing has been issued yet),
// so a sequence-only rule calls A's row current: B's header and B's ids appear
// over A's allergies, A's prep, A's intake, A's notes and A's schedule, and
// lifecycle controls targeting B are mounted under A's authority. No stale
// response is involved, which is why binding the RESPONSE to the open
// appointment cannot reach it.
//
// So identity gates the detail before freshness is even asked.
describe("a held detail is renderable only for the appointment being rendered", () => {
  const heldA = { value: { appointmentId: A }, seq: 4 };

  it("A's detail is NOT renderable while B is the rendered appointment", () => {
    expect(currentPreviewDetail({ held: heldA, renderedAppointmentId: B })).toBeNull();
  });

  it("A's detail IS renderable for A (positive control)", () => {
    expect(currentPreviewDetail({ held: heldA, renderedAppointmentId: A })).toBe(heldA);
  });

  it("nothing held is nothing to render", () => {
    expect(currentPreviewDetail({ held: null, renderedAppointmentId: A })).toBeNull();
  });

  it("identity is asked BEFORE freshness — a current sequence cannot rescue it", () => {
    // The exact render-transition state: the sequence that produced A's detail
    // is still the newest issued, so every generation check agrees. Only
    // identity refuses, and it must.
    expect(detailRemainsCurrent({ detailSeq: 4, issuedSeq: 4 })).toBe(true);
    expect(currentPreviewDetail({ held: heldA, renderedAppointmentId: B })).toBeNull();
  });
});

// THE REFRESH-FAILURE LAW, stated as behaviour rather than as a code comment.
//
// Codex re-raised "clear stale detail when a refresh read fails" at a head that
// already implements the currency rule. These are the two scenarios that decide
// whether that finding is live. If both hold, a failed refresh cannot leave a
// supposedly verified version behind, and clearing the detail outright would be
// a change made for review optics rather than for behaviour.
describe("REFRESH-FAILURE P2 — the intended law, proved", () => {
  it("a refresh WITHDRAWS freshness at start, before the await", () => {
    // Generation N produced the held detail; issuing N+1 is what advances the
    // issued generation, and it happens synchronously at the top of load().
    expect(detailRemainsCurrent({ detailSeq: 1, issuedSeq: 1 })).toBe(true);
    expect(detailRemainsCurrent({ detailSeq: 1, issuedSeq: 2 })).toBe(false);
  });

  it("a FAILED current refresh leaves the held detail non-fresh, so nothing is authorized", () => {
    // Failure does not advance the detail, so the gap persists. The drawer gates
    // Cancel/Reschedule and the move expected-version payload on `fresh`.
    expect(detailRemainsCurrent({ detailSeq: 1, issuedSeq: 2 })).toBe(false);
    expect(
      shouldApplyPreviewFailure({
        requestSeq: 2,
        currentSeq: 2,
        requestedAppointmentId: A,
        openAppointmentId: A,
      }),
    ).toBe(true);
  });

  it("an OLDER failure cannot invalidate a newer successful read", () => {
    // N starts, N+1 succeeds and becomes the held detail, then N fails.
    expect(
      shouldApplyPreviewFailure({
        requestSeq: 1,
        currentSeq: 2,
        requestedAppointmentId: A,
        openAppointmentId: A,
      }),
    ).toBe(false);
    expect(detailRemainsCurrent({ detailSeq: 2, issuedSeq: 2 })).toBe(true);
  });
});
