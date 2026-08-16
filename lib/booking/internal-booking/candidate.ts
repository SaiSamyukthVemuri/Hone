// THE ONE CANDIDATE MODEL for authenticated internal booking.
//
// WHY THIS EXISTS
// ---------------
// The client-profile Book form and the calendar Quick Book drawer were two
// independent implementations of the same booking semantics. Five review rounds
// in a row found the same defect in one surface after it was fixed in the
// other, or a rule applied to the cases a finding named rather than to every
// site the rule governs. The duplication was generating the findings.
//
// So the identity, the transitions and the decisions live here once. The two
// React components become adapters that render this model; they may look
// different, they may not think differently.

/** Every fact that changes what a loaded internal booking candidate MEANS. */
export type InternalBookingCandidateIdentity = {
  // Slots and windows do not vary by client -- but a buffer EXCEPTION does,
  // because it is an assertion about one appointment. Carried here so there is
  // one candidate model; projected out of the availability key below.
  clientId: string | null;
  serviceId: string | null;
  date: string | null;
  // The practitioner whose calendar is read: the selected target when a
  // selector is shown, otherwise the acting practitioner.
  targetPractitionerId: string | null;
  // Not an argument to anything, but the server reads it and it decides WHICH
  // window is authoritative.
  capacityMode: boolean;
  // Decides what the date MEANS and what instants come back.
  timezone: string;
};

// Derived by folding over every key, so a field added to the type joins the
// identity automatically and omission becomes a type error rather than a
// silent gap. This property is what four hand-listed identities failed at.
//
// Exported because the INTERVAL identity is derived the same way and must be
// derived by the same code: two folds that agree today are two folds that can
// disagree later.
export function fold(input: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(input)
      .sort()
      .map((k) => [k, input[k] ?? null]),
  );
}

/** Identity of the whole candidate: governs approvals and submission. */
export function candidateKey(id: InternalBookingCandidateIdentity): string {
  return fold(id);
}

// Identity of the AVAILABILITY question only. The client is projected out
// because slots and windows genuinely do not depend on it, and invalidating on
// a dimension that cannot change the answer would force pointless refetches.
// Everything else participates.
export function availabilityKey(id: InternalBookingCandidateIdentity): string {
  const rest: Record<string, unknown> = { ...id };
  delete rest.clientId;
  return fold(rest);
}

/** True when the candidate is complete enough to ask the availability question. */
export function isAvailabilityAskable(
  id: InternalBookingCandidateIdentity,
): boolean {
  return Boolean(id.serviceId && id.date && id.timezone);
}
