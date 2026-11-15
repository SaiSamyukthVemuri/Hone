// 0319 — the "these times don't work" command is used only when this flag is on.
//
// OFF BY DEFAULT, and the off path is the existing decline, unchanged. The
// command is a migration: turning this on before 0319 is applied would make
// every such tap fail closed with an honest message, so enabling it is a
// release step that follows the apply, not a code change.
export function waitlistTimesFeedbackEnabled(): boolean {
  return process.env.WAITLIST_TIMES_FEEDBACK === "1";
}

/** The most text a recipient may leave; the database enforces the same cap. */
export const TIMES_FEEDBACK_NOTE_MAX = 500;
