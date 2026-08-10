// The Finish appointment workflow state, as one pure presenter.
//
// WHY THIS EXISTS
// ---------------
// Chloe finishes charting and sees a generic "Done charting" exit. The two
// consequential visit-closing actions — marking the appointment completed and
// sending postcare — live on the calendar appointment page, a different surface
// entirely. Payment is gated behind completion. So the visit ends with the
// record written but the appointment still open, and postcare never sent.
//
// This module decides WHAT TO SHOW. It decides nothing about what is ALLOWED:
//
//   * `mark_appointment_complete` (migration 0032, redefined by B6 / 0175)
//     remains the completion authority, including its START-time gate and its
//     audit row;
//   * `sendPostcareEmailAction` remains the postcare authority, including its
//     first-send claim, consultation attestation and studio configuration gate;
//   * `markAftercareExplainedAction` remains the only writer of the aftercare
//     stamp.
//
// A presenter that disagrees with those is a display bug, never an escalation:
// every state below is re-derived server-side before anything is written.
//
// PURE: no I/O, no provider knowledge, no mutation, and NO CLOCK — `nowMs` is
// injected so the start-time boundary is testable and so a server render and a
// client render cannot disagree.

export type FinishChartingState = "charted" | "empty";

export type FinishAftercareState = "recorded" | "not_marked";

export type FinishCompletionState =
  // No appointment is linked to this session at all.
  | { kind: "unlinked" }
  // Linked, confirmed, but the appointment has not STARTED yet.
  // B6: renamed from before_end — explicit completion waits for the START.
  | { kind: "before_start"; startsAt: string }
  // Linked, confirmed, and already STARTED — the completion action is offered.
  // It need not have ended: the practitioner decides treatment is finished.
  | { kind: "ready"; appointmentId: string; startsAt: string }
  | { kind: "completed" }
  | { kind: "cancelled" }
  | { kind: "no_show" };

export type FinishPostcareState =
  // No appointment → nothing to send.
  | { kind: "unlinked" }
  // The client has no email on file.
  | { kind: "no_client_email" }
  // The studio has not written its aftercare text yet.
  | { kind: "not_configured"; isOwner: boolean }
  // A fresh claim with no outcome yet.
  | { kind: "sending" }
  // Provider handed off. `sentAt` is the provider-confirmed timestamp.
  | { kind: "sent"; sentAt: string; attempts: number }
  // The last attempt failed. Retry is explicit.
  | { kind: "failed"; attempts: number }
  // Never sent, and sendable.
  | { kind: "not_sent"; requiresConsultationConfirmation: boolean };

export type FinishAppointmentInput = {
  // Live (non-deleted) charted passes on this session.
  chartedBlockCount: number;
  // sessions.aftercare_and_risks_explained_at
  aftercareExplainedAt: string | null;
  // sessions.appointment_id → the linked appointment, or null for a freeform
  // session. NEVER resolved by client id: a client can have several
  // appointments, and the wrong one would be completed.
  appointment: {
    id: string;
    status: string;
    // B6: explicit completion is keyed on startsAt. endsAt is retained because
    // it remains the clock for no-show and for the session-start auto-complete
    // path, neither of which moved.
    startsAt: string | null;
    endsAt: string | null;
  } | null;
  clientEmail: string | null;
  // The studio's configured aftercare text; absent = postcare not configured.
  postcareConfigured: boolean;
  isOwner: boolean;
  postcareSentAt: string | null;
  postcareFailedAt: string | null;
  postcareClaimedAt: string | null;
  postcareSendAttempts: number;
  serviceModality: string | null;
  // Injected clock. Never read from inside this module.
  nowMs: number;
};

export type FinishAppointmentState = {
  charting: FinishChartingState;
  aftercare: FinishAftercareState;
  completion: FinishCompletionState;
  postcare: FinishPostcareState;
  // True when there is no linked appointment: the surface still shows charting
  // and aftercare, and still offers the safe exit.
  isUnlinked: boolean;
};

// A claim older than this is stale — the sender died, so the row is not
// "sending" any more. Mirrors the calendar surface's existing window.
const STALE_CLAIM_MS = 5 * 60_000;

function resolveCompletion(
  input: FinishAppointmentInput,
): FinishCompletionState {
  const appt = input.appointment;
  if (!appt) return { kind: "unlinked" };
  switch (appt.status) {
    case "completed":
      return { kind: "completed" };
    case "cancelled":
      return { kind: "cancelled" };
    case "no_show":
      return { kind: "no_show" };
    default:
      break;
  }
  // EXPLICIT completion readiness is startsAt-keyed (B6). No-show eligibility
  // is a different question with a different clock and is not computed here.
  const startsAtMs = appt.startsAt ? new Date(appt.startsAt).getTime() : Number.NaN;
  // Unparseable start time: treat as not-yet-started. The server RPC is the real
  // gate; showing an enabled button we cannot justify would be worse.
  if (!Number.isFinite(startsAtMs) || startsAtMs > input.nowMs) {
    return { kind: "before_start", startsAt: appt.startsAt ?? "" };
  }
  return { kind: "ready", appointmentId: appt.id, startsAt: appt.startsAt ?? "" };
}

function resolvePostcare(input: FinishAppointmentInput): FinishPostcareState {
  if (!input.appointment) return { kind: "unlinked" };
  // SENT is decided ONLY by a provider-confirmed sent_at. A claim or an attempt
  // count is not a send: claiming means we started, not that anything left.
  if (input.postcareSentAt) {
    return {
      kind: "sent",
      sentAt: input.postcareSentAt,
      attempts: input.postcareSendAttempts,
    };
  }
  if (input.postcareFailedAt) {
    return { kind: "failed", attempts: input.postcareSendAttempts };
  }
  const claimedMs = input.postcareClaimedAt
    ? new Date(input.postcareClaimedAt).getTime()
    : Number.NaN;
  if (
    Number.isFinite(claimedMs) &&
    input.nowMs - claimedMs < STALE_CLAIM_MS
  ) {
    return { kind: "sending" };
  }
  // Not sent. Now the reasons it might not be sendable.
  if (!input.clientEmail || input.clientEmail.trim() === "") {
    return { kind: "no_client_email" };
  }
  if (!input.postcareConfigured) {
    return { kind: "not_configured", isOwner: input.isOwner };
  }
  return {
    kind: "not_sent",
    // A consultation may or may not have included a test treatment, so the
    // practitioner attests. The server re-checks the same boolean.
    requiresConsultationConfirmation: input.serviceModality === "consultation",
  };
}

export function resolveFinishAppointmentState(
  input: FinishAppointmentInput,
): FinishAppointmentState {
  return {
    charting: input.chartedBlockCount > 0 ? "charted" : "empty",
    aftercare: input.aftercareExplainedAt ? "recorded" : "not_marked",
    completion: resolveCompletion(input),
    postcare: resolvePostcare(input),
    isUnlinked: input.appointment == null,
  };
}

// Practitioner-facing labels. Kept beside the states so a label and the branch
// that produces it cannot drift.
export function chartingLabel(state: FinishChartingState): string {
  return state === "charted" ? "Charting recorded" : "No treatment charted yet";
}

export function aftercareLabel(state: FinishAftercareState): string {
  return state === "recorded" ? "Recorded" : "Not marked";
}

export function completionLabel(state: FinishCompletionState): string {
  switch (state.kind) {
    case "unlinked":
      return "No booked appointment linked";
    case "before_start":
      return "Available once the appointment has started";
    case "ready":
      return "Ready to mark completed";
    case "completed":
      return "Completed";
    case "cancelled":
      return "Cancelled";
    case "no_show":
      return "No-show";
  }
}

export function postcareLabel(state: FinishPostcareState): string {
  switch (state.kind) {
    case "unlinked":
      return "No booked appointment linked";
    case "no_client_email":
      return "Postcare unavailable — no client email";
    case "not_configured":
      return "Postcare email is not configured yet";
    case "sending":
      return "Sending…";
    case "sent":
      return "Postcare sent";
    case "failed":
      return "Postcare send failed";
    case "not_sent":
      return "Not sent yet";
  }
}
