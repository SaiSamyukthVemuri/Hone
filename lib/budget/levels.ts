// Canonical CLIENT BUDGET CONTEXT vocabulary.
//
// ONE source of truth for the three practitioner-selectable budget levels,
// shared by the UI chips, the server action's validation, the studio export
// and every test. A second hard-coded list anywhere is how a chip label and
// a stored value drift apart, so there is deliberately no other copy: the
// DB CHECK constraint in migration 0183 lists the same three values and
// `tests/lib/budget/levels.test.ts` pins the two together.
//
// This is practitioner-held CLIENT CONTEXT, not a clinical record and not a
// financial assessment. It is deliberately NOT:
//   * an affordability score      * a financial-risk rating
//   * income or socioeconomic data  * payment eligibility
// It never changes a price, a Final charge, a discount, Stripe, booking
// availability, appointment duration or treatment-plan cadence. It is
// documentation the practitioner reads while planning.
//
// "No stated limit" is deliberately NOT "Unlimited": it records what the
// practitioner was told, without claiming the client literally has
// unlimited resources.

export const CLIENT_BUDGET_LEVELS = [
  "no_stated_limit",
  "somewhat_limited",
  "severely_limited",
] as const;

export type ClientBudgetLevel = (typeof CLIENT_BUDGET_LEVELS)[number];

// Visible chip labels, in the order they render.
export const CLIENT_BUDGET_LEVEL_LABELS: Record<ClientBudgetLevel, string> = {
  no_stated_limit: "No stated limit",
  somewhat_limited: "Somewhat limited",
  severely_limited: "Severely limited",
};

// Matches the 20000-character ceiling used by client_personal_notes
// (migration 0035) and enforced again by the CHECK constraint on
// client_budget_context.budget_notes.
export const MAX_BUDGET_NOTE_LENGTH = 20000;

// NULL / absent is a legitimate state — "no broad level recorded" — and is
// NOT a fourth level. Anything else is rejected rather than coerced, so a
// tampered form cannot store a value the CHECK constraint would refuse.
export function parseClientBudgetLevel(
  value: unknown,
): ClientBudgetLevel | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return (CLIENT_BUDGET_LEVELS as readonly string[]).includes(trimmed)
    ? (trimmed as ClientBudgetLevel)
    : null;
}

export function isClientBudgetLevel(
  value: unknown,
): value is ClientBudgetLevel {
  return (
    typeof value === "string" &&
    (CLIENT_BUDGET_LEVELS as readonly string[]).includes(value)
  );
}
