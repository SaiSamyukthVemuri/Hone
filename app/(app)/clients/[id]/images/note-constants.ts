// Plain (non-"use server") module so the constant can be shared by both the
// server action (actions.ts) and the client UI (TreatmentImagesManager.tsx) —
// a "use server" file may only export async functions.

// Maximum length of a per-photo practitioner note/caption (PR #307). A note,
// not an essay — bound it so a pasted blob can't bloat the row.
export const TREATMENT_NOTE_MAX_LENGTH = 1000;
