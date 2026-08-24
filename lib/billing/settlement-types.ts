// PAY-SETTLE. The vocabulary of a practitioner-ATTESTED appointment disposition,
// and the one place it is written down for the runtime.
//
// THE LINE THIS FILE DEFENDS. There are two kinds of money truth and they never
// become each other:
//
//   MONEY HONE VERIFIED          a Stripe charge that succeeded.
//                                payment_charge_attempts, and nowhere else.
//   DISPOSITION ATTESTED         what the practitioner says happened.
//                                appointment_settlements, and nowhere else.
//
// There is deliberately no "card" or "hone" member below, matching the CHECK
// constraint in migration 0187. A reader that wants Hone-verified money has
// exactly one place to look, so the two can never be summed together by
// accident.

/** The five recordable dispositions. Mirrors 0187's method CHECK exactly. */
export const SETTLEMENT_METHODS = [
  "paid_cash",
  "paid_e_transfer",
  "paid_other_external",
  "waived",
  "still_owes",
] as const;

export type SettlementMethod = (typeof SETTLEMENT_METHODS)[number];

/**
 * The four a Checkout-authorized practitioner may record directly.
 *
 * `waived` is absent BY AUTHORITY, not by oversight: a waiver changes what the
 * practice is entitled to rather than how the client paid, so it is owner-only
 * and goes through its own command. The database refuses it here too — this
 * list is the UI's copy of a rule the authority already enforces.
 */
export const PRACTITIONER_METHODS = [
  "paid_cash",
  "paid_e_transfer",
  "paid_other_external",
  "still_owes",
] as const;

export type PractitionerSettlementMethod = (typeof PRACTITIONER_METHODS)[number];

/** The three that mean money was COLLECTED, just not by Hone. */
export const EXTERNALLY_COLLECTED_METHODS = [
  "paid_cash",
  "paid_e_transfer",
  "paid_other_external",
] as const;

export function isSettlementMethod(value: unknown): value is SettlementMethod {
  return (
    typeof value === "string" &&
    (SETTLEMENT_METHODS as readonly string[]).includes(value)
  );
}

export function isPractitionerMethod(
  value: unknown,
): value is PractitionerSettlementMethod {
  return (
    typeof value === "string" &&
    (PRACTITIONER_METHODS as readonly string[]).includes(value)
  );
}

export function isExternallyCollected(method: SettlementMethod): boolean {
  return (EXTERNALLY_COLLECTED_METHODS as readonly string[]).includes(method);
}

/** Result codes the 0187 commands return. Closed; never a raw error string. */
export type SettlementResultCode =
  | "recorded"
  | "corrected"
  | "already_settled"
  | "stale_target"
  | "card_payment_exists"
  | "not_completed"
  | "not_found"
  | "not_owner"
  | "owner_only"
  | "invalid_input";

/** One recorded disposition, as the runtime reads it. */
export type AppointmentSettlement = {
  id: string;
  appointmentId: string;
  method: SettlementMethod;
  amountCents: number;
  quotedAmountCents: number | null;
  recordedAt: string;
  supersedesId: string | null;
};

// Practitioner-facing copy. Deliberately plain: "Paid cash" is what Chloe would
// say out loud, and the point of this release is that the software can finally
// say the same thing.
export const SETTLEMENT_ACTION_LABEL: Record<SettlementMethod, string> = {
  paid_cash: "Paid cash",
  paid_e_transfer: "Paid by e-transfer",
  paid_other_external: "Paid another way",
  waived: "Waive the fee",
  still_owes: "Client still owes",
};

// The badge on a settled appointment row.
//
// NONE of these says a bare "Paid". That word is reserved, throughout the
// product, for money Hone actually verified — see appointment-checkout-cell.
// An attested outcome always names HOW, so a glance at the dashboard cannot
// mistake a practitioner's word for a Stripe receipt.
export const SETTLEMENT_BADGE_LABEL: Record<SettlementMethod, string> = {
  paid_cash: "Paid · cash",
  paid_e_transfer: "Paid · e-transfer",
  paid_other_external: "Paid · other",
  waived: "Fee waived",
  still_owes: "Still owes",
};

/**
 * How a result code is explained to a practitioner. Safe, specific, and never
 * a raw database message.
 */
export const SETTLEMENT_RESULT_MESSAGE: Record<SettlementResultCode, string> = {
  recorded: "Recorded.",
  corrected: "Correction recorded.",
  already_settled:
    "This appointment already has a recorded outcome, so nothing was added.",
  stale_target:
    "This record was already corrected by someone else. Reload to see the current outcome.",
  card_payment_exists:
    "Hone has already taken card payment for this appointment. Refund it first if that is wrong.",
  not_completed: "Only a completed appointment can have an outcome recorded.",
  not_found: "Appointment not found in this studio.",
  not_owner: "Only the studio owner can do that.",
  owner_only: "Only the studio owner can waive a fee.",
  invalid_input: "That outcome could not be recorded. Check the amount and try again.",
};
