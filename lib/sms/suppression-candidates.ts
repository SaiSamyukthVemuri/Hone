import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SuppressionCandidate } from "./suppression";

// ===========================================================================
// PHONE-WIDE STOP CANDIDATES: READ COMPLETELY, OR NOT AT ALL
// (Codex P1 4234615485)
// ===========================================================================
//
// PostgREST caps every response at its row limit (max_rows; 1,000 on Hone's
// stacks) and answers 200 with the first window and no error. A STOP decision
// over that window is a guess: a STOP row outside it reads as "not opted out".
//
// So both sources are read in KEYSET pages: ordered by id, each page after the
// last id seen, until a page comes back EMPTY. A short page is never trusted to
// be the last one, so a row limit below the page size cannot end the read
// early. A row that exists for the whole read cannot be skipped; one inserted
// mid-read is the in-flight case the send paths already accept.
//
// FAIL-CLOSED. A failed page, a page whose ids do not advance, or more pages
// than the ceiling allows answers `{ ok: false }`. The caller then does not
// text, does not record, or (the STOP route) records the scan as failed and
// lets Twilio retry.
//
// THE SOURCES ARE THE STOP ROUTE'S OWN: `clients`, which the service role
// reads, and 0202's `waitlist_prospect_suppression_candidates`, which returns a
// table, so PostgREST filters, orders and limits its output as it does a
// table's. Matching stays `selectHoneSuppressionTargets` (lib/sms/suppression).
//
// PII. Nothing here logs a number.
// ===========================================================================

export const SUPPRESSION_READ_PAGE_SIZE = 1000;
/** 100 pages of 1,000: past this the read is bounded out, and fails closed. */
export const SUPPRESSION_READ_MAX_PAGES = 100;

export type SuppressionCandidatesRead =
  | { ok: true; candidates: SuppressionCandidate[] }
  | { ok: false };

type ReadOptions = {
  /** Only rows already opted out: the send-time and owner-recording checks. */
  optedOutOnly: boolean;
};

type PageAnswer = PromiseLike<{ data: unknown; error: unknown }>;

/**
 * The few builder calls a keyset page makes, typed structurally: supabase-js's
 * own generics, reassigned through a `let`, instantiate too deeply to check.
 */
type KeysetQuery = {
  not(column: string, operator: "is", value: null): KeysetQuery;
  gt(column: string, value: string): KeysetQuery;
  order(column: string, options: { ascending: boolean }): KeysetQuery;
  limit(count: number): PageAnswer;
};

/**
 * Every row a keyset query returns, or null when the read fails or cannot be
 * shown complete. `page(after)` must order by id ascending, filter id > after
 * when after is set, and limit to SUPPRESSION_READ_PAGE_SIZE.
 */
async function readAllPages(page: (after: string | null) => PageAnswer): Promise<SuppressionCandidate[] | null> {
  const rows: SuppressionCandidate[] = [];
  let after: string | null = null;
  for (let pages = 0; pages < SUPPRESSION_READ_MAX_PAGES; pages += 1) {
    const { data, error } = await page(after);
    if (error || !Array.isArray(data)) return null;
    if (data.length === 0) return rows;
    rows.push(...(data as SuppressionCandidate[]));
    const last = (data[data.length - 1] as { id?: unknown }).id;
    // The keyset must move forward, or the loop could re-read a page forever.
    if (typeof last !== "string" || (after !== null && last <= after)) return null;
    after = last;
  }
  return null;
}

async function read(
  page: (after: string | null) => PageAnswer,
): Promise<SuppressionCandidatesRead> {
  try {
    const candidates = await readAllPages(page);
    return candidates ? { ok: true, candidates } : { ok: false };
  } catch {
    return { ok: false };
  }
}

/** Every client row with a phone (or only those opted out), read completely. */
export function readClientSuppressionCandidates(
  admin: SupabaseClient,
  opts: ReadOptions,
): Promise<SuppressionCandidatesRead> {
  return read((after) => {
    let q = admin
      .from("clients")
      .select("id, studio_id, phone, sms_opted_out_at") as unknown as KeysetQuery;
    q = q.not("phone", "is", null);
    if (opts.optedOutOnly) q = q.not("sms_opted_out_at", "is", null);
    if (after !== null) q = q.gt("id", after);
    return q.order("id", { ascending: true }).limit(SUPPRESSION_READ_PAGE_SIZE);
  });
}

/** Every prospect row with a phone (or only those opted out), read completely. */
export function readProspectSuppressionCandidates(
  admin: SupabaseClient,
  opts: ReadOptions,
): Promise<SuppressionCandidatesRead> {
  return read((after) => {
    let q = admin.rpc("waitlist_prospect_suppression_candidates") as unknown as KeysetQuery;
    if (opts.optedOutOnly) q = q.not("sms_opted_out_at", "is", null);
    if (after !== null) q = q.gt("id", after);
    return q.order("id", { ascending: true }).limit(SUPPRESSION_READ_PAGE_SIZE);
  });
}
