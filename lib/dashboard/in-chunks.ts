// PostgREST carries `.in("col", ids)` in the URL. 600 appointment ids are about 24 KB, far past the roughly 4 KB the gateway accepts
// (#1336 kept every request under about 4 KB for the same reason). A uuid is 36 characters plus an encoded comma, so 80 ids is about
// 3.2 KB. Every chunk is its own request; ANY chunk that errors fails the whole read, so a partial answer is never presented as a
// complete one.

export const ID_CHUNK = 80;

// PostgREST truncates a response at `max_rows` (supabase/config.toml: 1000) WITHOUT an error. A page that reaches the cap may have hidden
// rows, so absence from it proves nothing (a client price could fall back to the menu price). A capped page is therefore a FAILED read:
// callers already turn a failed read into "Amount unavailable" (quotes) or an unreadable panel (everything else), never a guessed figure.
export const ROW_CAP = 1000;

export function chunkIds<T>(ids: readonly T[], size: number = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

export type ChunkRead<Row> = { data: Row[] | null; error: unknown };

/** Runs `read` once per chunk (in parallel) and concatenates. One failed or row-capped chunk = the whole read fails. */
export async function readInChunks<Row>(
  ids: readonly string[],
  read: (chunk: string[]) => PromiseLike<ChunkRead<Row>>,
): Promise<{ ok: true; rows: Row[] } | { ok: false }> {
  const parts = await Promise.all(chunkIds(ids).map((c) => read(c)));
  const rows: Row[] = [];
  for (const p of parts) {
    if (p.error) return { ok: false };
    if ((p.data?.length ?? 0) >= ROW_CAP) return { ok: false };
    rows.push(...(p.data ?? []));
  }
  return { ok: true, rows };
}
