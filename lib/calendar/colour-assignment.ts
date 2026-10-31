import { PRACTITIONER_COLORS, isPractitionerColor } from "@/lib/practitioner-colors";

// HON-48 / settings WS-C: the colour a practitioner is shown in everywhere (appointment swatch,
// sidebar checkbox, Day column accent) is practitioners.color. This file only DECIDES which token
// to suggest; it writes nothing and reads nothing. A write is always the caller's OWN colour
// through the governed 0178 command, so nothing here can recolour another practitioner.
//
// "neutral" is the column default every new practitioner starts on, so it never counts as taken:
// two people on the default are not a clash, and it is the last suggestion, never the first.

const DEFAULT_TOKEN = "neutral";

export type ColourHolder = { id: string; color: string | null | undefined };

function tokenOf(color: string | null | undefined): string | null {
  return isPractitionerColor(color) ? color : null;
}

// Tokens held by anyone other than `selfId`, excluding the default.
export function colourTokensTakenByOthers(holders: ReadonlyArray<ColourHolder>, selfId: string): Set<string> {
  const taken = new Set<string>();
  for (const h of holders) {
    if (h.id === selfId) continue;
    const t = tokenOf(h.color);
    if (t && t !== DEFAULT_TOKEN) taken.add(t);
  }
  return taken;
}

// Palette order, unused first. Everything stays offered: a taken colour is flagged, never removed.
export function colourOptions(
  holders: ReadonlyArray<ColourHolder>,
  selfId: string,
): Array<{ token: string; label: string; takenBy: number }> {
  const counts = new Map<string, number>();
  for (const h of holders) {
    if (h.id === selfId) continue;
    const t = tokenOf(h.color);
    if (t && t !== DEFAULT_TOKEN) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return PRACTITIONER_COLORS.map((c) => ({ token: c.token as string, label: c.label, takenBy: counts.get(c.token) ?? 0 }));
}

// The first palette colour nobody else holds, or null when the palette is exhausted.
export function suggestDistinctColour(holders: ReadonlyArray<ColourHolder>, selfId: string): string | null {
  const taken = colourTokensTakenByOthers(holders, selfId);
  const free = PRACTITIONER_COLORS.find((c) => c.token !== DEFAULT_TOKEN && !taken.has(c.token));
  return free ? free.token : null;
}

// A new practitioner is one still on the default. Existing choices (including a deliberate
// "neutral" when the palette is exhausted) are never touched by a suggestion: it is offered, not applied.
export function shouldSuggestColour(ownColor: string | null | undefined): boolean {
  return tokenOf(ownColor) === DEFAULT_TOKEN || tokenOf(ownColor) === null;
}

// Existing duplicates are information only. Saving any unrelated setting never consults this.
export function duplicateColourTokens(holders: ReadonlyArray<ColourHolder>): string[] {
  const seen = new Map<string, number>();
  for (const h of holders) {
    const t = tokenOf(h.color);
    if (t && t !== DEFAULT_TOKEN) seen.set(t, (seen.get(t) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([t]) => t);
}
