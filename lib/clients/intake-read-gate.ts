// The directory reads client intake STATUS only for a viewer who may see it. The decision, kept pure so its truth table is testable:
// the owner, a holder of clin.view_intake_status (status only), or a holder of clin.view_intake (the answers) may read it; anyone else is
// RESTRICTED, which is not "no intake" (RO-1). Under I2 (0334) a status-only holder reads through the definer enum projection instead.
export function intakeReadAllowed(input: { isOwner: boolean; statusAllowed: boolean; answersAllowed: boolean }): boolean {
  return input.isOwner === true || input.statusAllowed === true || input.answersAllowed === true;
}
