// CLIENTS DIRECTORY: the server reads. A CONSTANT number of reads, none per row:
//   1. the clients of the studio (one id-paged traversal), explicit columns;
//   2. one read of confirmed upcoming appointments for the studio;
//   3. one read of the studio's intake rows (status only, never the answers);
//   and, for the visible page only, one batched last-visit read (last-visit.ts).
// Everything is read through the SIGNED-IN client, so row-level security still
// decides what a viewer may read. Filtering, search, sort, count and paging happen
// afterwards, in directory-query.ts, over the whole set read here.
//
// Explicit column lists: no `*`, no address, nothing clinical, no legal identity
// (Privacy S2, S3). The preferred name is read through the existing fallback, so
// the directory works on a database that does not have the column yet.
//
// A failed CLIENT read throws a fixed message (the page's error state). A failed
// AGGREGATE read is reported as `null` for that aggregate, never as an empty
// answer. No error text, name, email or phone is ever put in a thrown message or
// a log line (Privacy S6).

import { readWithPreferredName, preferredNameColumn } from "@/lib/clients/preferred-name-read";
import type { DirectorySourceClient } from "@/lib/clients/directory-rules";
import type { IntakeStatusValue } from "@/lib/clients/directory-query";

export const DIRECTORY_CLIENT_COLUMNS = "id, name, pronouns, email, phone, archived_at";

type Result = { data: unknown; error: { code?: string | null; message?: string | null } | null };
type Q = {
  eq: (c: string, v: string | boolean) => Q;
  gt: (c: string, v: string) => Q;
  is: (c: string, v: null) => Q;
  not: (c: string, op: string, v: null) => Q;
  order: (c: string, o: { ascending: boolean }) => Q;
  range: (a: number, b: number) => PromiseLike<Result>;
};
export type DirectorySupabase = { from: (t: string) => { select: (cols: string) => Q } };

const BLOCK = 1000;
const MAX_BLOCKS = 50;

/** The studio's clients for one view, as the full authorized set. Throws a fixed message on any failure. */
export async function readDirectoryClients(
  supabase: DirectorySupabase,
  studioId: string,
  archived: boolean,
): Promise<DirectorySourceClient[]> {
  const failure = archived ? "Failed to load archived clients" : "Failed to load clients";
  const out: DirectorySourceClient[] = [];
  const seen = new Set<string>();
  let afterId: string | null = null;
  for (let block = 0; block < MAX_BLOCKS; block += 1) {
    const res: Result = await readWithPreferredName((includePreferred) => {
      let q = supabase
        .from("clients")
        .select(`${preferredNameColumn(includePreferred)}${DIRECTORY_CLIENT_COLUMNS}`)
        .eq("studio_id", studioId);
      q = archived ? q.not("archived_at", "is", null) : q.is("archived_at", null);
      if (afterId !== null) q = q.gt("id", afterId);
      return q.order("id", { ascending: true }).range(0, BLOCK - 1);
    });
    if (res.error) throw new Error(failure);
    const rows = (res.data ?? []) as DirectorySourceClient[];
    if (rows.length === 0) return out;
    for (const row of rows) {
      if (seen.has(row.id)) throw new Error(failure);
      seen.add(row.id);
      out.push(row);
    }
    afterId = rows[rows.length - 1].id;
  }
  // Never return a partial directory as if it were whole.
  throw new Error(failure);
}

/** client id -> earliest upcoming start (status confirmed, starts after now); null when the read failed. */
export async function readNextAppointments(
  supabase: DirectorySupabase,
  studioId: string,
  nowIso: string,
): Promise<Map<string, string> | null> {
  const next = new Map<string, string>();
  for (let block = 0; block < MAX_BLOCKS; block += 1) {
    const res: Result = await supabase
      .from("appointments")
      .select("client_id, starts_at")
      .eq("studio_id", studioId)
      .eq("status", "confirmed")
      .gt("starts_at", nowIso)
      .order("starts_at", { ascending: true })
      .range(block * BLOCK, block * BLOCK + BLOCK - 1);
    if (res.error) return null;
    const rows = (res.data ?? []) as Array<{ client_id: string; starts_at: string }>;
    for (const r of rows) {
      const cur = next.get(r.client_id);
      if (cur === undefined || r.starts_at < cur) next.set(r.client_id, r.starts_at);
    }
    if (rows.length < BLOCK) return next;
  }
  return null;
}

/** client id -> canonical current intake status (the newest non-deleted form); null when the read failed. */
export async function readCurrentIntake(
  supabase: DirectorySupabase,
  studioId: string,
): Promise<Map<string, IntakeStatusValue> | null> {
  const best = new Map<string, string>();
  const out = new Map<string, IntakeStatusValue>();
  for (let block = 0; block < MAX_BLOCKS; block += 1) {
    const res: Result = await supabase
      .from("client_intake_forms")
      .select("client_id, status, created_at")
      .eq("studio_id", studioId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .range(block * BLOCK, block * BLOCK + BLOCK - 1);
    if (res.error) return null;
    const rows = (res.data ?? []) as Array<{ client_id: string; status: IntakeStatusValue; created_at: string }>;
    for (const r of rows) {
      const cur = best.get(r.client_id);
      // Canonical rule (today-intake.ts): strictly newer created_at wins.
      if (cur !== undefined && r.created_at <= cur) continue;
      best.set(r.client_id, r.created_at);
      out.set(r.client_id, r.status);
    }
    if (rows.length < BLOCK) return out;
  }
  return null;
}
