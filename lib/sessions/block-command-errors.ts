import "server-only";

// Safe error mapping for the L18 Phase 2 block/entry commands (migration 0166).
//
// A PostgREST RPC failure carries the raw exception message, which for these
// commands is a deliberately non-sensitive sentence, but it can also carry a
// constraint name, a function body fragment or an internal id when something
// unexpected fails. Nothing raw is ever returned to a practitioner: known
// outcomes map to the existing user-facing wording, and everything else becomes
// one generic message with the detail logged server-side.

/** Shape PostgREST returns on an RPC failure. */
export type RpcError = {
  message?: string | null;
  code?: string | null;
  details?: string | null;
  hint?: string | null;
};

/** The generic fallback. Deliberately says nothing about the database. */
export const GENERIC_BLOCK_COMMAND_ERROR =
  "Could not save these treatment details. Please reload the session and try again.";

/**
 * Stable outcomes raised by the 0166 commands (and the 0129 boundary they
 * delegate to), mapped to the wording the application already showed.
 *
 * Matching is on the exact sentence each command raises, not a fuzzy search of
 * a full PostgreSQL message, so an unrelated error can never be mistaken for a
 * known one.
 */
const KNOWN: ReadonlyArray<{ raised: string; safe: string }> = [
  {
    raised: "An authenticated practitioner is required.",
    safe: "Please sign in again to continue.",
  },
  {
    raised: "Inactive practitioners cannot remove blocks.",
    safe: "Inactive practitioners cannot delete blocks.",
  },
  {
    raised: "Session not found or not writable by this practitioner.",
    safe: "That session could not be found for this client.",
  },
  {
    raised: "Session does not belong to that client.",
    safe: "That session could not be found for this client.",
  },
  {
    raised: "Block does not belong to this session.",
    safe: "That settings block could not be found in this session.",
  },
  {
    raised: "Entry does not belong to this block.",
    safe: "That pass could not be found in this treatment area.",
  },
  {
    raised: "Unsupported block field.",
    safe: "Some of those settings could not be saved. Please reload and try again.",
  },
  {
    // 0129's optimistic-concurrency signal. The pre-existing wording.
    raised: "stale_block_version",
    safe:
      "This settings block was changed elsewhere. Reload the session and re-apply your edit.",
  },
  {
    // 0119/0159 finalized/retired clinical-record guards.
    raised: "finalized",
    safe: "This record is finalized and can no longer be edited.",
  },
];

/**
 * Map an RPC failure to a safe message.
 *
 * `logUnknown` receives only the raw message for server-side logging; it is
 * never returned to the caller.
 */
export function mapBlockCommandError(
  error: RpcError | null | undefined,
  logUnknown: (raw: string) => void = defaultLog,
): string {
  const raw = (error?.message ?? "").trim();
  if (!raw) {
    logUnknown("(empty RPC error)");
    return GENERIC_BLOCK_COMMAND_ERROR;
  }

  for (const k of KNOWN) {
    if (raw.includes(k.raised)) return k.safe;
  }

  // Anything else: a constraint violation, a type error, a Postgres internal,
  // is logged and generalised. Never surfaced.
  logUnknown(raw);
  return GENERIC_BLOCK_COMMAND_ERROR;
}

function defaultLog(raw: string): void {
  // Message only: no client name, no clinical value, no ids.
  console.error("[block-command] unmapped RPC failure:", raw);
}

/** True when the failure is the optimistic-concurrency conflict. */
export function isStaleBlockVersion(error: RpcError | null | undefined): boolean {
  return (error?.message ?? "").includes("stale_block_version");
}
