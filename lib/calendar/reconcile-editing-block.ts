// HON-48 — an open block drawer holds its own copy of the block, so a
// router.refresh() that brings in a colleague's change to that block updated
// the calendar behind the drawer but not the drawer: it kept showing the old
// values and kept submitting the old updated_at, so every later save or delete
// was refused as stale while the message said the latest version was shown.
//
// This picks what the drawer should hold after a refresh: the refreshed row
// with the same id, or nothing when the block is gone (deleted elsewhere).
// When nothing changed it returns the same object, so no re-render and no form
// reseed happens for a refresh that did not touch this block.

type Versioned = { id: string; updated_at: string };

export function reconcileEditingBlock<T extends Versioned>(editing: T | null, blocks: readonly T[]): T | null {
  if (!editing) return null;
  const fresh = blocks.find((b) => b.id === editing.id);
  if (!fresh) return null;
  return fresh.updated_at === editing.updated_at ? editing : fresh;
}
