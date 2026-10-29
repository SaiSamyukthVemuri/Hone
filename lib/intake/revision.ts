// PostgreSQL bigint revisions travel as canonical decimal strings, never a
// rounded JavaScript number. Missing revision is NOT legacy revision zero.
export function intakeRevision(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  }
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(value)) return null;
  return BigInt(value) <= BigInt("9223372036854775807") ? value : null;
}

export const INTAKE_CONFLICT =
  "This intake changed in another window. Your unsaved answers are still here. Review the saved version before trying again.";
export const INTAKE_TERMINAL =
  "This intake has already been submitted. Your new changes were not saved.";
