// Restoring a removed practitioner (Team page). The locked command set_practitioner_active_locked (0150) already accepts p_active = true for an
// owner, and returns a text outcome; the only other refusal is a database CHECK from the receptionist membership guard (0216). This file is the
// ONE place that turns those into a code the page can show as a sentence, so a refusal never reaches the generic error boundary and never leaks
// database text.

export const RESTORE_OUTCOMES = [
  "restored",
  "not_found",
  "owner",
  "receptionist_conflict",
  "failed",
] as const;
export type RestoreOutcome = (typeof RESTORE_OUTCOMES)[number];

export function parseRestoreOutcome(value: unknown): RestoreOutcome | null {
  return typeof value === "string" && (RESTORE_OUTCOMES as readonly string[]).includes(value)
    ? (value as RestoreOutcome)
    : null;
}

/** Maps the command's text result (or its error) to an outcome. Anything unrecognised is "failed", never "restored". */
export function restoreOutcomeFromRpc(data: unknown, error: { message?: string | null } | null): RestoreOutcome {
  if (error) {
    return typeof error.message === "string" && error.message.includes("practitioner_is_active_receptionist")
      ? "receptionist_conflict"
      : "failed";
  }
  if (data === "ok") return "restored";
  if (data === "invalid_practitioner") return "not_found";
  if (data === "cannot_modify_owner") return "owner";
  return "failed";
}

export function restoreOutcomeCopy(outcome: RestoreOutcome): { tone: "ok" | "refused"; text: string } {
  switch (outcome) {
    case "restored":
      return { tone: "ok", text: "Restored. They can sign in again with the same role, and their records and appointments are as they were." };
    case "not_found":
      return { tone: "refused", text: "That person was not found in this studio, so nothing was changed." };
    case "owner":
      return { tone: "refused", text: "The studio owner cannot be removed or restored." };
    case "receptionist_conflict":
      return { tone: "refused", text: "This person is currently an active receptionist in this studio, and the same person cannot be a practitioner and a receptionist at once. Nothing was changed." };
    case "failed":
      return { tone: "refused", text: "Could not restore this person. Nothing was changed. Please try again." };
  }
}

export function restoreHref(outcome: RestoreOutcome): string {
  return `/settings/team?restore=${encodeURIComponent(outcome)}`;
}
