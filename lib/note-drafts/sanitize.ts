import type { NoteDraftFields, NoteDraftKind } from "./types";

const MAX_TEXT = 20000;
const MAX_AREAS = 40;

/** Keep only the known fields, with the final note's own ceilings. Returns null when the shape is wrong. */
export function sanitizeDraftFields(kind: NoteDraftKind, input: unknown): NoteDraftFields | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const o = input as Record<string, unknown>;
  const out: NoteDraftFields = {};
  const text = (v: unknown, max: number): string | null | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== "string" || v.length > max) return null;
    return v;
  };
  if (kind === "budget") {
    const level = text(o.budget_level, 40);
    const notes = text(o.budget_notes, MAX_TEXT);
    if (level === null || notes === null) return null;
    if (level !== undefined) out.budget_level = level;
    if (notes !== undefined) out.budget_notes = notes;
    return out;
  }
  const body = text(o.body, MAX_TEXT);
  if (body === null) return null;
  if (body !== undefined) out.body = body;
  if (o.areas !== undefined) {
    if (!Array.isArray(o.areas) || o.areas.length > MAX_AREAS || o.areas.some((a) => typeof a !== "string" || a.length > 200)) return null;
    out.areas = o.areas as string[];
  }
  const occurred = text(o.occurred_at, 10);
  if (occurred === null) return null;
  if (occurred !== undefined) out.occurred_at = occurred;
  return out;
}
