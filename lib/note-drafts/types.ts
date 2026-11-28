// HON-130: autosaved drafts for consultation, skin/hair analysis and budget notes.
// A draft is transient text on its way to the real record; it is NEVER the record (see migration 0399).

export const NOTE_DRAFT_KINDS = ["consultation", "skin_hair_analysis", "budget"] as const;
export type NoteDraftKind = (typeof NOTE_DRAFT_KINDS)[number];

/** Field values a draft carries. Notes: body + areas. Budget: budget_level + budget_notes. */
export type NoteDraftFields = {
  body?: string;
  areas?: string[];
  occurred_at?: string;
  budget_level?: string;
  budget_notes?: string;
};

/** The owner key beyond studio/practitioner (both come from the session): client + kind + target. */
export type NoteDraftKey = {
  clientId: string;
  kind: NoteDraftKind;
  /** "new", the id of the note being revised, or "current" (budget). */
  target: string;
};

export type NoteDraftSaveResult =
  | { status: "ok"; revision: number; savedAt: string }
  | { status: "conflict"; revision: number; fields: NoteDraftFields; savedAt: string }
  | { status: "gone" }
  | { status: "cleared" }
  | { status: "refused" }
  | { status: "disabled" }
  | { status: "invalid" }
  | { status: "error" };

export type StoredNoteDraft = {
  key: NoteDraftKey;
  fields: NoteDraftFields;
  revision: number;
  savedAt: string;
};

/** Fixed wording (Privacy condition 8). Draft text never appears in any message. */
export const DRAFT_COPY = {
  failure: "Couldn't save the draft. Your text is still here.",
  saving: "Saving draft…",
  unsaved: "Unsaved changes",
  conflict: "Another window changed this draft.",
  cleared: "This note was saved in another window. Your text is still here.",
  discard: "Discard draft",
} as const;

export function draftSavedLabel(hhmm: string): string {
  return `Draft saved ${hhmm}`;
}
export function draftRestoredLabel(hhmm: string): string {
  return `Draft restored (saved ${hhmm})`;
}

export function targetFor(kind: NoteDraftKind, supersedesNoteId: string | null): string {
  return kind === "budget" ? "current" : (supersedesNoteId ?? "new");
}
