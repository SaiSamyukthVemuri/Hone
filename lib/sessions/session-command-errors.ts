import "server-only";

// Safe error mapping for the L18 Phase 3 session commands (migration 0167).
//
// Same posture as lib/sessions/block-command-errors.ts: a PostgREST RPC failure
// carries the raw exception message, which for these commands is a deliberately
// non-sensitive sentence — but it can also carry a constraint name, a function
// body fragment or an internal id when something unexpected fails. Nothing raw
// reaches a practitioner: known outcomes map to the wording the application
// already showed, and everything else becomes one generic message with the
// detail logged server-side.

/** Shape PostgREST returns on an RPC failure. */
export type RpcError = {
  message?: string | null;
  code?: string | null;
  details?: string | null;
  hint?: string | null;
};

/** The generic fallback. Deliberately says nothing about the database. */
export const GENERIC_SESSION_COMMAND_ERROR =
  "Something went wrong saving this session. Please reload and try again.";

/**
 * Stable outcomes raised by the 0167 commands (and the 0166 guard they reuse),
 * each mapped to the exact sentence the direct writer used to produce.
 *
 * Matching is on the raised sentence, not a fuzzy search of a full PostgreSQL
 * message, so an unrelated error can never be mistaken for a known one.
 */
const KNOWN: ReadonlyArray<{ raised: string; safe: string }> = [
  // --- shared guards -------------------------------------------------------
  {
    raised: "An authenticated practitioner is required.",
    safe: "Please sign in again to continue.",
  },
  {
    raised: "No active practitioner found for the signed-in user.",
    safe: "No active practitioner found for the signed-in user.",
  },
  {
    raised: "Session not found or not writable by this practitioner.",
    safe: "Session not found.",
  },
  {
    raised: "Session does not belong to that client.",
    safe: "Session not found.",
  },
  { raised: "Session not found.", safe: "Session not found." },

  // --- start_session -------------------------------------------------------
  { raised: "Unsupported session modality.", safe: "Unsupported session modality." },
  { raised: "Client not found in this studio.", safe: "Client not found in this studio." },
  { raised: "Appointment is not in your studio.", safe: "Appointment is not in your studio." },
  {
    raised: "Appointment is for a different client.",
    safe: "Appointment is for a different client.",
  },
  {
    raised: "Appointment is assigned to a different practitioner.",
    safe: "Appointment is assigned to a different practitioner.",
  },

  // --- per-field commands --------------------------------------------------
  {
    raised: "Price must be a non-negative number.",
    safe: "Price must be a non-negative number.",
  },
  {
    raised: "Practitioner not found in this studio.",
    safe: "Practitioner not found in this studio.",
  },
  {
    raised: "Session start cannot be after the session end time.",
    safe: "Session start cannot be after the session end time.",
  },
  {
    raised: "A session start time is required.",
    safe: "Enter a valid date and time.",
  },
  {
    raised: "Inactive practitioners cannot edit sessions.",
    safe: "Inactive practitioners cannot edit sessions.",
  },
  {
    raised: "Inactive practitioners cannot delete sessions.",
    safe: "Inactive practitioners cannot delete sessions.",
  },
  {
    raised: "Reason must be at least 10 characters.",
    safe: "Reason must be at least 10 characters.",
  },
  {
    raised: "This session has already been removed.",
    safe: "This session has already been removed.",
  },

  // --- treatment plan linkage ---------------------------------------------
  { raised: "Plan not found.", safe: "Plan not found." },
  { raised: "Cannot attach to a closed plan.", safe: "Cannot attach to a closed plan." },
  {
    raised: "Plan does not belong to this client.",
    safe: "Plan does not belong to this client.",
  },

  // --- aftercare stamp -----------------------------------------------------
  {
    raised: "An explicit aftercare value is required.",
    safe: "Something went wrong saving this session. Please reload and try again.",
  },

  // --- preserved clinical guards (triggers, 0159/0160) ---------------------
  {
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
export function mapSessionCommandError(
  error: RpcError | null | undefined,
  logUnknown: (raw: string) => void = defaultLog,
): string {
  const raw = (error?.message ?? "").trim();
  if (!raw) {
    logUnknown("(empty RPC error)");
    return GENERIC_SESSION_COMMAND_ERROR;
  }

  for (const k of KNOWN) {
    if (raw.includes(k.raised)) return k.safe;
  }

  // Anything else — a constraint violation, a type error, a Postgres internal —
  // is logged and generalised. Never surfaced.
  logUnknown(raw);
  return GENERIC_SESSION_COMMAND_ERROR;
}

function defaultLog(raw: string): void {
  // Message only: no client name, no clinical value, no ids.
  console.error("[session-command] unmapped RPC failure:", raw);
}
