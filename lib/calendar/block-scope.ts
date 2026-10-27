// Calendar block scope label (BLOCK-SCOPE F3). Pure and client-safe.
//
// Under practitioner capacity a timed block or recurring break is either
// studio-wide (practitioner_id NULL: it closes the time for EVERY practitioner,
// 0137 fans it out to one reservation each) or scoped to one practitioner. The
// calendar used to draw both the same, so a studio-wide block looked like one
// person's and a scoped one looked studio-wide. These labels say which.
//
// Same wording as the Settings scope label (lib/booking/scoped-unavailability.ts
// scopeLabel), which is server-only; a test pins that the two agree.
//
// Display only: it reads the practitioner_id already on each row and grants or
// changes nothing. Capacity OFF is one studio timeline, where every block is
// studio-wide by design, so callers pass no names there and no label renders.

export type BlockScopeNames = Readonly<Record<string, string>>;

export const ALL_PRACTITIONERS_LABEL = "All practitioners";

export function calendarBlockScopeLabel(
  practitionerId: string | null | undefined,
  names: BlockScopeNames,
): string {
  if (!practitionerId) return ALL_PRACTITIONERS_LABEL;
  const name = names[practitionerId];
  // Not in the active roster (deactivated or removed): a neutral label, never
  // a guessed name.
  return name ? `Only ${name}` : "A former practitioner";
}

// Names for the label, or undefined when the studio runs one timeline.
export function blockScopeNamesFor(
  capacityEnabled: boolean,
  activePractitioners: ReadonlyArray<{ id: string; display_name: string | null }>,
): BlockScopeNames | undefined {
  if (!capacityEnabled) return undefined;
  const names: Record<string, string> = {};
  for (const p of activePractitioners) names[p.id] = p.display_name?.trim() || "Practitioner";
  return names;
}
