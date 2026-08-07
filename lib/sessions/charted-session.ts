// THE definition of "the newest prior CHARTED session" — one rule, one module.
//
// WHY THIS EXISTS
// ---------------
// An empty session row is created the instant a practitioner taps a modality
// on /clients/<id>/sessions/new (start_session, migration 0167), and abandoned
// zero-block rows are common. Every previous-context surface that ordered by
// `started_at DESC LIMIT 1` therefore selected that empty row and rendered a
// blank "previous session" while the real treatment sat one row below. A newer
// laser session did the same thing to an electrolysis summary.
//
// The rule is deliberately split in two halves so it can be enforced where each
// half belongs:
//
//   SQL HALF (push to the database — the caller's query):
//     sessions.studio_id      = :studioId
//     sessions.client_id      = :clientId
//     sessions.deleted_at    IS NULL
//     order by started_at desc
//   Both call sites get this for free from getClientById(), whose sessions read
//   is already studio-scoped, client-scoped, soft-delete-filtered and ordered
//   newest-first, and which already embeds live entries.
//
//   CONTENT HALF (pure, below): void exclusion, the current-session exclusion,
//   the time bound, and — the part a `LIMIT 1` can never express — whether the
//   session actually CONTAINS charting.
//
// A session counts as charted when it has at least one live settings block, or
// at least one live electrolysis entry, or at least one live laser entry. That
// is exactly pickLastTreatment's rule (lib/sessions/clinical-summary.ts) and
// treatment-intelligence's; this module adds the three filters those pure
// helpers deliberately do not carry, so a caller cannot forget one.
//
// KNOWN DIVERGENCE (documented, not fixed here): lib/dashboard/
// clients-needing-attention.ts uses a blocks-only rule with no legacy-entry
// fallback. It is owned by another workstream and is out of scope; it is named
// here so the next person finds it rather than assuming this module is the only
// definition in the repository.
//
// Pure. No I/O, no imports from the data layer. Client-safe.

// The minimum shape a candidate must expose. Every field is optional except the
// two that identify and order the row, so callers can pass a narrow select or a
// full `Session` row interchangeably.
export type ChartedSessionCandidate = {
  id: string;
  started_at: string;
  record_status?: string | null;
  deleted_at?: string | null;
  // Migration 0068. Present only on callers that select it; read solely by the
  // excludeAppointmentId filter below.
  appointment_id?: string | null;
  electrolysis_entries?: ReadonlyArray<{ deleted_at?: string | null }> | null;
  laser_entries?: ReadonlyArray<{ deleted_at?: string | null }> | null;
};

// A block only counts when it is live. Callers that already filtered
// soft-deleted blocks out still work: an absent deleted_at reads as live.
export type ChartedBlockRow = { deleted_at?: string | null };

export type ChartedSessionOptions = {
  // Strict upper bound on started_at. The charting page passes the current
  // session's started_at so a session charted later the same day can never be
  // presented as "last time".
  before?: string | null;
  // The session being charted right now. Never its own previous treatment.
  excludeSessionId?: string | null;
  // The appointment being PREPARED right now. Every session carrying this
  // appointment_id is the current visit record, not the visit before it.
  //
  // Strictly stronger than excludeSessionId for that job: `sessions.appointment_id`
  // has no unique constraint (migration 0068 — "one appointment may have zero or
  // more sessions"), so excluding the single row a `limit(1)` linked-session
  // lookup happened to return would leave a sibling behind. It is also why this
  // is a JS-side filter and not a PostgREST `.neq("appointment_id", …)`: the
  // column is nullable, and `NULL <> 'x'` is NULL, so a SQL neq would silently
  // discard every UNLINKED session — which is nearly all of them.
  excludeAppointmentId?: string | null;
  // Restrict to one modality. Deliberately OFF by default: a prior laser
  // session is legitimately "the last treatment" for a client mid-transition.
  modality?: string | null;
  // Hard bound on how many rows are inspected, so an unbounded client history
  // can never turn into an unbounded IN(...) list downstream.
  limit?: number;
};

export const DEFAULT_CHARTED_SESSION_LIMIT = 25;

function liveCount(
  rows: ReadonlyArray<{ deleted_at?: string | null }> | null | undefined,
): number {
  if (!rows) return 0;
  let n = 0;
  for (const r of rows) if (r.deleted_at == null) n += 1;
  return n;
}

// Newest first, with a deterministic tie-break so two sessions sharing an exact
// started_at always resolve the same way (id descending, matching the
// `order by ps.started_at desc, ps.id desc` the 0157 copy-source function uses).
function newestFirst<T extends ChartedSessionCandidate>(
  sessions: ReadonlyArray<T>,
): T[] {
  return [...sessions].sort((a, b) => {
    const at = new Date(a.started_at).getTime();
    const bt = new Date(b.started_at).getTime();
    if (bt !== at) return bt - at;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

// The filters a `LIMIT 1` cannot express, applied to a candidate row. Content is
// NOT checked here — that needs the blocks map, which callers load in one
// batched query over the surviving candidate ids.
export function isChartedSessionCandidate(
  session: ChartedSessionCandidate,
  opts: ChartedSessionOptions = {},
): boolean {
  if (session.deleted_at != null) return false;
  // record_status is NOT NULL in the schema; a missing value on a narrow select
  // is treated as non-void rather than rejected.
  if (session.record_status === "void") return false;
  if (opts.excludeSessionId && session.id === opts.excludeSessionId) {
    return false;
  }
  if (
    opts.excludeAppointmentId
    && session.appointment_id === opts.excludeAppointmentId
  ) {
    return false;
  }
  if (opts.before) {
    const bound = new Date(opts.before).getTime();
    const at = new Date(session.started_at).getTime();
    if (!(at < bound)) return false;
  }
  if (opts.modality) {
    const m = (session as { modality?: string | null }).modality;
    if (m !== opts.modality) return false;
  }
  return true;
}

// The bounded, ordered candidate window. Call this FIRST, load blocks for the
// returned ids in ONE batched query, then call pickNewestChartedSession with
// the resulting map. Splitting it this way is what keeps the whole selector at
// a single round-trip and free of N+1.
export function chartedSessionCandidates<T extends ChartedSessionCandidate>(
  sessions: ReadonlyArray<T>,
  opts: ChartedSessionOptions = {},
): T[] {
  const limit = Math.max(1, opts.limit ?? DEFAULT_CHARTED_SESSION_LIMIT);
  return newestFirst(sessions)
    .filter((s) => isChartedSessionCandidate(s, opts))
    .slice(0, limit);
}

// Does this session actually contain charting? Live block, live electrolysis
// entry, or live laser entry. A session row on its own never qualifies.
export function hasChartedContent(
  session: ChartedSessionCandidate,
  blocksBySession: ReadonlyMap<string, ReadonlyArray<ChartedBlockRow>>,
): boolean {
  if (liveCount(blocksBySession.get(session.id)) > 0) return true;
  if (liveCount(session.electrolysis_entries) > 0) return true;
  if (liveCount(session.laser_entries) > 0) return true;
  return false;
}

// THE selector. Returns the newest session that passes every filter AND
// contains charting, or null when the client has no prior charted treatment.
// Fails soft by design: a first-visit client, a client whose only other session
// is an abandoned empty one, and a failed blocks read all yield null, and every
// caller renders nothing rather than an empty "previous session" shell.
export function pickNewestChartedSession<T extends ChartedSessionCandidate>(
  sessions: ReadonlyArray<T>,
  blocksBySession: ReadonlyMap<string, ReadonlyArray<ChartedBlockRow>>,
  opts: ChartedSessionOptions = {},
): T | null {
  return (
    chartedSessionCandidates(sessions, opts).find((s) =>
      hasChartedContent(s, blocksBySession),
    ) ?? null
  );
}

// Group a flat batched `session_blocks` read into the map the two functions
// above expect. Rows are grouped by session_id and kept in the order supplied
// (callers order by sort_order), so a caller never needs a second sort.
export function groupBlocksBySession<T extends { session_id: string }>(
  rows: ReadonlyArray<T>,
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const bucket = out.get(row.session_id);
    if (bucket) bucket.push(row);
    else out.set(row.session_id, [row]);
  }
  return out;
}
