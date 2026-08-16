// What the appointment-notes editor should DISPLAY, between a successful write
// and the next authoritative read.
//
// A governed 0173 write returning ok is evidence that the note was saved. The
// editor must not need a second, fallible read to remember it.
//
// WHY THIS EXISTS. On the appointment detail page `notes` is a SERVER prop and
// router.refresh() updates it, so the editor could read the prop and be right.
// In the calendar preview drawer the same prop is a CLIENT-held copy that only
// changes when the drawer's lazy detail reload succeeds — and that reload can
// fail. When it did, the editor closed and went on rendering the PRE-SAVE text
// beside a load-error message while the database already held the new note.
// Worse, reopening Edit seeded that obsolete value, so the next save silently
// overwrote a change that had succeeded.
//
// THE DISTINCTION THAT MATTERS:
//
//   write failure                    nothing is committed; the old note stands
//   write success + refresh failure   the new note is committed locally and
//                                     stays visible; the refresh error is
//                                     reported separately, as itself
//
// SYNCHRONIZING WITHOUT CLOBBERING. `syncedFrom` records the prop value the
// committed text was last taken from, so a rerender carrying the SAME (stale)
// prop is a no-op — the parent re-renders for its own error state while still
// passing the pre-save value, and that must not undo a successful save. Only a
// genuinely CHANGED prop resynchronizes, which keeps router.refresh() and the
// drawer's successful reloads working normally.
//
// Deliberately NOT done here: any post-write read to populate local state, and
// any second opinion about storage normalization. The SQL command owns canonical
// storage; for the short window before an authoritative read lands, showing
// exactly what the practitioner submitted is the honest thing.
//
// Pure: no React, no clock, no I/O.

export type NotesCommitState = {
  // What the practitioner should see, and what Edit should seed from.
  committed: string | null;
  // The prop value `committed` was last synchronized from. Never the locally
  // committed text: it is how "has the server actually said something new?" is
  // answered.
  syncedFrom: string | null;
};

export function initialNotesCommit(prop: string | null): NotesCommitState {
  return { committed: prop, syncedFrom: prop };
}

// Called on every render with the incoming prop. Returns the SAME object when
// nothing changed, so the caller can set state only on a real transition rather
// than looping.
export function reconcileWithProp(
  state: NotesCommitState,
  incomingProp: string | null,
): NotesCommitState {
  if (incomingProp === state.syncedFrom) return state;
  return { committed: incomingProp, syncedFrom: incomingProp };
}

// Called ONLY after setAppointmentNotesAction returns ok.
//
// `syncedFrom` is deliberately left alone: it still describes the prop the
// parent is passing, so the stale rerender that follows a failed reload
// compares equal and changes nothing. When the server does eventually deliver a
// different value, that comparison differs and the server wins.
export function commitSavedNotes(
  state: NotesCommitState,
  submitted: string,
): NotesCommitState {
  // Empty — or only whitespace — is a CLEAR, which is what the editor's own
  // "leaving this empty clears the notes" already tells the practitioner. Any
  // other text is preserved exactly as typed.
  const cleared = submitted.trim().length === 0;
  return { committed: cleared ? null : submitted, syncedFrom: state.syncedFrom };
}
