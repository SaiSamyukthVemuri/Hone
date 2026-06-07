import type { SessionBlockSide } from "@/lib/types/database";

// PR #162. Single source of truth for the user-facing label that
// session_blocks.side renders as on every charting surface (the
// setup-form dropdown AND the read-only blocks view). The DB CHECK
// constraint from migration 0039 + the server validation in
// app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts
// pin the canonical lowercase enum values
// ("center" / "left" / "right" / "bilateral" / "n/a"); only the
// display label changes.
//
// Chloe asked specifically whether "Bilateral" meant "both sides"
// while charting a real session. Renaming the stored enum value
// would break every prior saved record. Re-labelling the display
// in this one helper means every charting surface picks up the
// new wording at the same time.

export const SESSION_BLOCK_SIDE_OPTIONS: ReadonlyArray<{
  value: SessionBlockSide;
  label: string;
}> = [
  { value: "center", label: "Center" },
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
  // PR #162. Display label only. The DB / TS / validation value
  // stays "bilateral". A saved record with side='bilateral'
  // continues to render correctly because every consumer goes
  // through sessionBlockSideLabel below.
  { value: "bilateral", label: "Both sides" },
  { value: "n/a", label: "n/a" },
];

// Map a stored side value to the practitioner-facing label.
// Returns null when the side is null/undefined so the caller can
// decide whether to render anything (e.g. session-blocks-view
// skips the "n/a" case via a separate predicate before calling).
export function sessionBlockSideLabel(
  side: SessionBlockSide | null | undefined,
): string | null {
  if (!side) return null;
  const option = SESSION_BLOCK_SIDE_OPTIONS.find((o) => o.value === side);
  return option ? option.label : side;
}
