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
// BATCHED FOR THE VISIBLE PAGE: two reads for the page's client ids (no per-row
// query). It is displayed, never filtered or sorted on. No clinical content is
// selected: only a client id and a timestamp. A failed read is `{ ok: false }`,
// shown as "Unavailable", never as "no visit".

export const LAST_VISIT_DEFINITION =
  "the later of the newest live non-void session start and the newest completed appointment start, both not in the future";

type Row = Record<string, string>;
type Builder = {
  eq: (c: string, v: string) => Builder;
  neq: (c: string, v: string) => Builder;
  lte: (c: string, v: string) => Builder;
  is: (c: string, v: null) => Builder;
  in: (c: string, v: string[]) => Builder;
  order: (c: string, o: { ascending: boolean }) => Builder;
  range: (a: number, b: number) => PromiseLike<{ data: Row[] | null; error: unknown }>;
};
export type LastVisitSupabase = { from: (t: string) => { select: (cols: string) => Builder } };

const BLOCK = 1000;
const MAX_BLOCKS = 10;

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

export async function readLastVisits(
  supabase: LastVisitSupabase,
  studioId: string,
  clientIds: readonly string[],
  nowIso: string,
): Promise<LastVisitResult> {
  const out = new Map<string, string>();
  const ids = [...new Set(clientIds)];
  if (ids.length === 0) return { ok: true, value: out };

  const [sessions, appointments] = await Promise.all([
    newestPerClient(
      (from, to) =>
        supabase
          .from("sessions")
          .select("client_id, started_at")
          .eq("studio_id", studioId)
          .in("client_id", ids)
          .is("deleted_at", null)
          .neq("record_status", "void")
          .lte("started_at", nowIso)
          .order("started_at", { ascending: false })
          .range(from, to),
      "started_at",
    ),
    newestPerClient(
      (from, to) =>
        supabase
          .from("appointments")
          .select("client_id, starts_at")
          .eq("studio_id", studioId)
          .in("client_id", ids)
          .eq("status", "completed")
          .lte("starts_at", nowIso)
          .order("starts_at", { ascending: false })
          .range(from, to),
      "starts_at",
    ),
  ]);
  // Either source failing makes the whole answer unavailable: the later of the
  // two cannot be known from one.
  if (sessions === null || appointments === null) return { ok: false };

  for (const m of [sessions, appointments]) {
    for (const [id, at] of m) {
      const cur = out.get(id);
      if (cur === undefined || at > cur) out.set(id, at);
    }
  }
  return { ok: true, value: out };
}
