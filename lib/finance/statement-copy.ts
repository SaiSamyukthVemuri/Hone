// HON-64 Slice A: the sentences this statement is allowed to say, as constants so a test can pin them (same reason as financial-copy.ts).

export const STATEMENT_FRAMING =
  "A statement of the money Hone has recorded for visits in this month. It is not revenue accounting, not a claim, and not a bill.";

export const STATEMENT_PRACTITIONER_RULE =
  "Money is counted under the practitioner of the appointment it belongs to. Money on an appointment with no practitioner is shown as Unattributed.";

export const STATEMENT_OUTSIDE_SCOPE =
  "Money that is not linked to a visit in this month (for example a payment taken for a session with no appointment) is not in this statement.";

export const STATEMENT_ADJUSTMENTS_NOTE =
  "Waived amounts and full refunds are shown as adjustments. A fully refunded charge is already absent from Collected, and a waived amount was never collected, so nothing is subtracted twice.";

export const STATEMENT_WRITE_OFFS_NOTE = "Write-offs are not recorded separately in Hone, so none are shown.";

export const STATEMENT_PARTIAL_REFUND_NOTE =
  "Partial refunds are not supported yet. A charge with a refund that cannot be proven in full is shown under Unresolved and is not counted as collected.";

export const STATEMENT_UNRESOLVED_NOTE =
  "Unresolved money may or may not have moved. It is counted and listed, and never added to Collected.";

export const STATEMENT_METHOD_LABELS = {
  collected_card_session: "Card (Hone-verified): session payments",
  collected_card_fee: "Card (Hone-verified): cancellation and no-show fees",
  collected_cash: "Cash (recorded by the owner)",
  collected_e_transfer: "E-transfer (recorded by the owner)",
  collected_other_external: "Other method (recorded by the owner)",
  refunded_card_session: "Refunded in full: session payments",
  refunded_card_fee: "Refunded in full: fees",
  waived: "Waived (owner-attested as forgiven)",
  still_owes_note: "Marked still owing (a note, not an amount)",
  unresolved: "Unresolved",
  other_currency: "In another currency (not summed)",
  excluded: "Not collected money (pending, failed or test mode)",
  unreadable: "Could not be read",
} as const;

/** "Not recorded" is the ONLY thing the insurer block ever says. The labels come from lib/clinical-records/insurer-field-gaps.ts. */
export const INSURER_NOT_RECORDED = "Not recorded";

export const INSURER_BLOCK_NOTE =
  "Hone does not record these fields yet. They are shown as not recorded and are never inferred from a visit, a payment or a name.";

export const UNREADABLE_FALLBACK_KIND = "another kind of payment record";

/**
 * The limitation line, built from the money forms Hone cannot read from an owner session (so it cannot drift from MONEY_FORMS), in plain words.
 * The plain-word name of each kind lives on its MONEY_FORMS entry (`plain`), so this file never names those tables.
 */
export function unreadableFormsLine(forms: ReadonlyArray<{ table: string; form: string; handling: string; plain?: string }>): string {
  const unreadable = forms.filter((f) => f.handling === "not_checked");
  const kinds = [...new Set(unreadable.map((f) => f.plain ?? UNREADABLE_FALLBACK_KIND))];
  if (kinds.length === 0) return "This statement shows the money Hone can see.";
  return `This statement shows the money Hone can see. It cannot see these kinds of payment record yet, so any money in them is not included: ${kinds.join("; ")}.`;
}

/** Shown instead of an amount for every line that is counted but never totalled. */
export const STATEMENT_NO_TOTAL = "no amount";

/** A practitioner whose name could not be read. The id is never shown. */
export const STATEMENT_UNNAMED_PRACTITIONER = "Practitioner (name not available)";
