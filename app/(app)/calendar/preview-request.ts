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
