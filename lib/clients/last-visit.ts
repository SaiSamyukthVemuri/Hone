// CLIENTS DIRECTORY: LAST VISIT, behind ONE function (OPS R2, Insurance
// CLIENTS-LAST-VISIT).
//
// DEFINITION: the LATER of
//   (a) the newest session with deleted_at IS NULL, record_status <> 'void' and
//       started_at <= now, and
//   (b) the newest appointment with status = 'completed' and starts_at <= now.
// Cancelled, no-show and still-confirmed past appointments never count. A draft or
// empty session counts (a draft is a charting state, not evidence that no
// treatment occurred). Both sources are needed: a walk-in or legacy session has no
// appointment, and a completed appointment with no chart is a visit whose record
// is missing.
//
// To change the definition, replace `readLastVisits` and keep its signature;
// nothing else in the directory changes.
//
// BATCHED FOR THE VISIBLE PAGE, AND BOUNDED (Insurance K4): the page's client ids
// only (no per-row query), in two windows. Phase 1 reads the last RECENT_WINDOW_DAYS
// for the whole page, so an active client's several hundred old sessions are never
// scanned; a client with a hit there is final, because the newest visit is in the
// window. Phase 2 reads OLDER history only for the page's clients that had no hit,
// who are by definition the inactive ones. Each phase is capped at MAX_BLOCKS blocks
// of BLOCK rows per source, so the worst case is 4 x MAX_BLOCKS requests, and a cap
// overflow is reported as unavailable, never as a partial answer. Every ordered read
// ends with an id tie-break so offset paging cannot skip or repeat a row (K2).
// It is displayed, never filtered or sorted on. No clinical content is selected:
// only a client id and a timestamp. A failed read is `{ ok: false }`, shown as
// "Unavailable", never as "no visit".

export const LAST_VISIT_DEFINITION =
  "the later of the newest live non-void session start and the newest completed appointment start, both not in the future";

type Row = Record<string, string>;
type Builder = {
  eq: (c: string, v: string) => Builder;
  neq: (c: string, v: string) => Builder;
  lte: (c: string, v: string) => Builder;
  gte: (c: string, v: string) => Builder;
  lt: (c: string, v: string) => Builder;
  is: (c: string, v: null) => Builder;
  in: (c: string, v: string[]) => Builder;
  order: (c: string, o: { ascending: boolean }) => Builder;
  range: (a: number, b: number) => PromiseLike<{ data: Row[] | null; error: unknown }>;
};
export type LastVisitSupabase = { from: (t: string) => { select: (cols: string) => Builder } };

const BLOCK = 1000;
const MAX_BLOCKS = 10;
export const RECENT_WINDOW_DAYS = 365;

export type LastVisitResult = { ok: true; value: Map<string, string> } | { ok: false };

/** Latest timestamp per client from one source, or null when its read failed or exceeded the bound. */
async function newestPerClient(
  page: (from: number, to: number) => PromiseLike<{ data: Row[] | null; error: unknown }>,
  timeColumn: string,
): Promise<Map<string, string> | null> {
  const out = new Map<string, string>();
  for (let block = 0; block < MAX_BLOCKS; block += 1) {
    const { data, error } = await page(block * BLOCK, block * BLOCK + BLOCK - 1);
    if (error) return null;
    const rows = data ?? [];
    for (const r of rows) {
      const cur = out.get(r.client_id);
      if (cur === undefined || r[timeColumn] > cur) out.set(r.client_id, r[timeColumn]);
    }
    if (rows.length < BLOCK) return out;
  }
  // More rows than the bound: never report a partial answer as the truth.
  return null;
}

type Window = { from: string | null; before: string | null };

/** The later of the two sources, per client, inside one window; null when either read failed or overflowed. */
async function newestInWindow(
  supabase: LastVisitSupabase,
  studioId: string,
  ids: readonly string[],
  nowIso: string,
  w: Window,
): Promise<Map<string, string> | null> {
  const [sessions, appointments] = await Promise.all([
    newestPerClient(
      (from, to) => {
        let q = supabase
          .from("sessions")
          .select("client_id, started_at")
          .eq("studio_id", studioId)
          .in("client_id", [...ids])
          .is("deleted_at", null)
          .neq("record_status", "void")
          .lte("started_at", nowIso);
        if (w.from) q = q.gte("started_at", w.from);
        if (w.before) q = q.lt("started_at", w.before);
        return q.order("started_at", { ascending: false }).order("id", { ascending: true }).range(from, to);
      },
      "started_at",
    ),
    newestPerClient(
      (from, to) => {
        let q = supabase
          .from("appointments")
          .select("client_id, starts_at")
          .eq("studio_id", studioId)
          .in("client_id", [...ids])
          .eq("status", "completed")
          .lte("starts_at", nowIso);
        if (w.from) q = q.gte("starts_at", w.from);
        if (w.before) q = q.lt("starts_at", w.before);
        return q.order("starts_at", { ascending: false }).order("id", { ascending: true }).range(from, to);
      },
      "starts_at",
    ),
  ]);
  // Either source failing makes the whole answer unavailable: the later of the
  // two cannot be known from one.
  if (sessions === null || appointments === null) return null;
  const out = new Map<string, string>();
  for (const m of [sessions, appointments]) {
    for (const [id, at] of m) {
      const cur = out.get(id);
      if (cur === undefined || at > cur) out.set(id, at);
    }
  }
  return out;
}

export async function readLastVisits(
  supabase: LastVisitSupabase,
  studioId: string,
  clientIds: readonly string[],
  nowIso: string,
): Promise<LastVisitResult> {
  const ids = [...new Set(clientIds)];
  if (ids.length === 0) return { ok: true, value: new Map() };

  const windowStart = new Date(Date.parse(nowIso) - RECENT_WINDOW_DAYS * 86_400_000).toISOString();
  const recent = await newestInWindow(supabase, studioId, ids, nowIso, { from: windowStart, before: null });
  if (recent === null) return { ok: false };
  const missing = ids.filter((id) => !recent.has(id));
  if (missing.length === 0) return { ok: true, value: recent };

  const older = await newestInWindow(supabase, studioId, missing, nowIso, { from: null, before: windowStart });
  if (older === null) return { ok: false };
  for (const [id, at] of older) recent.set(id, at);
  return { ok: true, value: recent };
}

/**
 * A date in the STUDIO's timezone, formatted on the server so it is never blank
 * before hydration and never differs by the viewer's device (Insurance K3).
 */
export function formatStudioDate(iso: string, timeZone: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" };
  try {
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone }).format(at);
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" }).format(at);
  }
}

/** A date and time in the STUDIO's timezone, server-rendered: the next-appointment cell, so both
 *  clocks on a row are the studio's (Insurance M4). The en-US format stays for now. */
export function formatStudioDateTime(iso: string, timeZone: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const opts: Intl.DateTimeFormatOptions = {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  };
  try {
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone }).format(at);
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" }).format(at);
  }
}
