// PR #320: the Stripe PaymentIntent `description` shown on the connected
// account's dashboard + client receipt. It MUST be accurate per charge_reason —
// fee rows have session_id = null, so the old `Session payment for session
// ${session_id}` produced "…for session null" for no-show / late-cancellation
// fees. Only the charge reason + an internal id (session/appointment UUID) is
// included; NEVER a client name, health/intake detail, note, or other PII, and
// never a literal "null".
//
// Pure + framework-free (no "server-only") so it can be unit-tested directly.

export function buildChargeDescription(row: {
  charge_reason: string | null;
  session_id: string | null;
  appointment_id: string | null;
}): string {
  switch (row.charge_reason) {
    case "no_show_fee":
      return row.appointment_id
        ? `No-show fee for appointment ${row.appointment_id}`
        : "No-show fee";
    case "late_cancellation_fee":
      return row.appointment_id
        ? `Late cancellation fee for appointment ${row.appointment_id}`
        : "Late cancellation fee";
    case "session_payment":
      return row.session_id
        ? `Session payment for session ${row.session_id}`
        : "Session payment";
    default:
      // Unknown/absent reason (charge_reason is enum-constrained in the DB, so
      // this is a defensive fallback): a generic label, never a null id.
      return "Studio payment";
  }
}
