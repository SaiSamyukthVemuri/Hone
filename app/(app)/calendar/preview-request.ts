// Stale-response rule for the appointment preview drawer's lazy detail load.
//
// The drawer loads its prep detail when it opens. A practitioner scanning a
// week clicks fast, so two loads can be in flight at once, and server actions
// carry no ordering guarantee: the response for appointment A can land AFTER
// the response for appointment B. Without a rule, A's late payload overwrites
// B's — the drawer then shows B's client name above A's last treatment, intake
// state and notes. That is a clinical mis-read, not a cosmetic glitch, so the
// decision is a named, tested function rather than an inline `if` inside an
// effect where it cannot be exercised directly.
//
// Two INDEPENDENT conditions must both hold. Either alone would be enough in
// the common case; keeping both means a single mistake does not silently
// re-open the hole:
//
//   1. Sequence. Every load takes the next sequence number. A response whose
//      sequence is not the newest issued is abandoned. This catches the
//      A-then-B race even when both requests are for the SAME appointment id
//      (re-open, or a refresh after a move).
//
//   2. Identity. The response carries the appointment id it describes, and it
//      must match the appointment the drawer has open RIGHT NOW. This is the
//      structural backstop: it holds even if the sequence bookkeeping is wrong,
//      and it is what makes a mismatched payload unrenderable rather than
//      merely unlikely.
//
// A closed drawer (openAppointmentId === null) applies nothing at all.
//
// Pure: no refs, no clock, no React. The drawer owns the mutable sequence
// counter and passes the two numbers in.

export type PreviewResponseDecision = {
  responseAppointmentId: string;
  // The sequence this response's request was issued with.
  requestSeq: number;
  // The newest sequence issued by the drawer so far.
  currentSeq: number;
  // The appointment the drawer has open now, or null when it is closed.
  openAppointmentId: string | null;
};

// FRESHNESS HAS A LIFETIME. It belongs to a successful CURRENT read generation,
// and it is not a property the retained detail object keeps for ever.
//
// The drawer refreshes itself after a notes save, and that refresh does not
// clear the detail already on screen — deliberately, so the panel does not blank
// out mid-edit. But the held copy stops being an assertion about NOW the moment
// a newer read is issued: while that read is in flight nobody has confirmed the
// row, and if it FAILS nobody has confirmed it at all. Treating "we read this
// successfully once" as "this is verified now" is how a failed refresh left
// Cancel and Reschedule on offer beside a load-error message, for an appointment
// that may have been cancelled or moved in between.
//
// The held detail may still be the best thing to SHOW — it is newer than the
// week grid. It may not AUTHORIZE anything.
export function detailRemainsCurrent(input: {
  // The generation that produced the detail now held, or null when none is.
  detailSeq: number | null;
  // The newest generation issued so far.
  issuedSeq: number;
}): boolean {
  if (input.detailSeq === null) return false;
  return input.detailSeq === input.issuedSeq;
}

// Whether a FAILURE should be allowed to change anything.
//
// The mirror of shouldApplyPreviewResponse, and load-bearing for the same
// reason: responses are not ordered. Generation N can fail after N+1 has already
// succeeded, and letting that late failure raise the error state would report a
// stale problem over a fresh, verified result — and would withdraw currency from
// a detail that genuinely has it.
export function shouldApplyPreviewFailure(input: {
  requestSeq: number;
  currentSeq: number;
}): boolean {
  return input.requestSeq === input.currentSeq;
}

export function shouldApplyPreviewResponse(
  input: PreviewResponseDecision,
): boolean {
  // Closed drawer: nothing to populate.
  if (input.openAppointmentId === null) return false;
  // Superseded by a newer request.
  if (input.requestSeq !== input.currentSeq) return false;
  // Describes a different appointment than the one on screen.
  if (input.responseAppointmentId !== input.openAppointmentId) return false;
  return true;
}
