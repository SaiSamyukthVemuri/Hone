// Paging for the Studio visit list. PURE: it slices a list it is given and reports where it is; it never decides what is in the list, so totals and counts
// elsewhere on the page can never depend on the page being viewed.
export const STUDIO_VISITS_PAGE_SIZE = 8;

/** A positive whole page number from a query value; anything else (missing, zero, negative, fractional, text, a list) is page 1. */
export function parsePageParam(raw: string | string[] | undefined): number {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === "string" && /^[1-9]\d{0,5}$/.test(v) ? Number(v) : 1;
}

/** Latest first, DETERMINISTIC: a start time that does not parse sorts last (never NaN into the comparison), and equal times break on the id. */
export function latestFirst(a: { startsAt: string; appointmentId: string }, b: { startsAt: string; appointmentId: string }): number {
  const ta = Date.parse(a.startsAt);
  const tb = Date.parse(b.startsAt);
  const fa = Number.isFinite(ta);
  const fb = Number.isFinite(tb);
  if (fa && fb && ta !== tb) return tb - ta;
  if (fa !== fb) return fa ? -1 : 1;
  return a.appointmentId < b.appointmentId ? -1 : a.appointmentId > b.appointmentId ? 1 : 0;
}

export type PageSlice<T> = { items: T[]; page: number; pages: number; from: number; to: number; total: number };

/** The requested page, clamped into range (a page past the end shows the last page; an empty list is one empty page). */
export function slicePage<T>(list: readonly T[], requested: number, size = STUDIO_VISITS_PAGE_SIZE): PageSlice<T> {
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const page = Math.min(Math.max(1, requested), pages);
  const start = (page - 1) * size;
  const items = list.slice(start, start + size);
  return { items, page, pages, from: total === 0 ? 0 : start + 1, to: start + items.length, total };
}
