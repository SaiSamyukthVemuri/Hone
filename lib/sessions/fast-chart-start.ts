// Repeat-client fast charting: "Start from last session".
//
// This module owns the ONE extra concept the fast path adds on top of the
// existing whole-session copy authority (migration 0157): after the governed,
// atomic copy commits, WHICH just-created treatment area does the practitioner
// land in, and how is that carried back to the charting page.
//
// It adds NO copy engine and NO write path. The copy itself is unchanged:
//   whole_session_copy_source_descriptor  (server-derived source + fingerprint)
//     -> buildCopyDrafts / draftToCopyInput  (canonical client model)
//       -> normalizeWholeSessionCopy         (canonical server normalizer)
//         -> copy_session_setup RPC          (the single, atomic, idempotent writer)
//
// The landing area travels as a SEARCH PARAM rather than component state
// because the destination blocks do not exist until the copy commits: they are
// rendered by a fresh server pass, so the newly mounted editor cannot inherit
// state from the panel that created them. A param is deterministic, survives
// the server round trip, and is validated against live rows before it is
// honoured.
//
// The param is an INSTRUCTION, not durable page state: it says "open the editor
// for the area I just created". The charting view consumes it once and clears
// it, so re-opening the URL later does not silently reopen an editor.

// Search param the charting page reads to decide which treatment area opens in
// TODAY'S editor. Deliberately short and stable: it appears in the URL bar of a
// clinical screen.
export const FAST_CHART_PARAM = "chart";

// Where the practitioner lands after a successful copy: the FIRST area created
// by the batch. copy_session_setup builds `created_block_ids` by iterating the
// spec array in order and assigning sort_order 1..N, so element 0 is always the
// area with sort_order 1, the same area the source listed first. An idempotent
// replay returns the identical array from the provenance ledger, so a retried
// fast start lands on the same area rather than a different one.
//
// Only the first area is opened. The whole batch is copied in ONE action, so the
// practitioner is never walked through areas to confirm what the previous chart
// already knows; she opens the remaining editors only to record what actually
// happened in each.
export function landingBlockId(
  createdBlockIds: readonly string[] | null | undefined,
): string | null {
  if (!createdBlockIds || createdBlockIds.length === 0) return null;
  const first = createdBlockIds[0];
  return typeof first === "string" && first.trim() !== "" ? first : null;
}

// The charting URL that lands the practitioner in today's editor for `blockId`.
// Path-only (no origin) so it is a same-origin client navigation.
export function fastChartUrl(
  clientId: string,
  sessionId: string,
  blockId: string,
): string {
  return (
    `/clients/${encodeURIComponent(clientId)}` +
    `/sessions/${encodeURIComponent(sessionId)}` +
    `?${FAST_CHART_PARAM}=${encodeURIComponent(blockId)}`
  );
}

// Resolve the param to a treatment area to auto-open, or null.
//
// FAIL CLOSED: the value is honoured ONLY when it names a live block that is
// already rendered on THIS session. A stale id (the area was removed), a
// repeated param, or a hand-crafted id for another session/studio resolves to
// null and changes nothing. The param can therefore never widen what is
// visible. It can only pre-open an editor the practitioner could already open
// by tapping "Edit" on an area she is already looking at.
export function resolveAutoEditBlockId(
  raw: string | string[] | undefined | null,
  liveBlockIds: readonly string[],
): string | null {
  if (typeof raw !== "string") return null; // absent, or repeated (?chart=a&chart=b)
  const candidate = raw.trim();
  if (candidate === "") return null;
  return liveBlockIds.includes(candidate) ? candidate : null;
}
