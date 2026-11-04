// Read-only chart mode: a practitioner who may VIEW the records (clin.view_records) but not EDIT them (clin.edit_records) is told so in
// words that differ from the "cannot see this at all" refusal, so the message never claims the chart is hidden when it is only locked.
export const VIEW_REFUSAL = "Not available to your role.";
export const EDIT_RECORDS_REFUSAL = "You can view this chart but not change it.";

// Insurance I-5: a permission read that FAILED (the engine could not be asked) is not a "no". It gets its own words, never the read-only sentence,
// so someone who does hold the edit key is not told they cannot change a chart because of a transient fault. It still fails closed (nothing is allowed).
export const PERMISSION_CHECK_FAILED = "We couldn't check your permissions. Please try again.";
type RefusalDecision = { allowed: boolean; engine: boolean | null; engineAbsent?: boolean };
export function permissionCheckFailed(d: RefusalDecision): boolean {
  return !d.allowed && d.engine === null && !d.engineAbsent;
}
export function editRecordsRefusal(d: RefusalDecision): string {
  return permissionCheckFailed(d) ? PERMISSION_CHECK_FAILED : EDIT_RECORDS_REFUSAL;
}
