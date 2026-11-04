// Erasure REQUESTS (R5, DN-18; Sam batch 3 Q18). Prepared, not wired: nothing imports this yet, so no page, route or menu shows it.
// Recording a request deletes nothing and execution is not available; the copy below is the contract the screen must keep
// (tests/lib/erasure/requests.test.ts). No retention period is stated and nothing is said about backups.

export type ErasureState = "requested" | "under_review" | "confirmed" | "withdrawn";

export type ErasureRequestRow = {
  id: string;
  client_id: string;
  state: ErasureState;
  /** null once the owner has cleared it */
  reason: string | null;
  requested_at: string;
};

export const ERASURE_DELETES_NOTHING = "Recording a request deletes nothing. Erasure itself is not available yet.";
export const ERASURE_EXECUTION_UNAVAILABLE = "Erasing a client's data is not available yet. Recording a request does not start it and does not change the client's record.";
export const ERASURE_NOT_AVAILABLE_YET = "Erasure requests are not available yet.";
export const ERASURE_REASON_MAX = 300;

// Shown with the reason box and beside every reason (Privacy CL1). The earlier wording is not kept in the request history; no promise is made about backups.
export const ERASURE_REASON_WARNING = "Do not include personal details about the client here.";
export const ERASURE_REASON_CORRECTABLE = "You can correct or clear the reason later. The earlier wording is not kept in the request history.";

export const ERASURE_STATE_LABEL: Record<ErasureState, string> = {
  requested: "Requested",
  under_review: "Under review",
  confirmed: "Recorded as confirmed. Nothing has been erased.",
  withdrawn: "Withdrawn",
};

// The one forward step offered from each state; `confirmed` and `withdrawn` offer none. Withdrawal is offered from every open state.
const NEXT: Record<ErasureState, { to: "under_review" | "confirmed"; label: string } | null> = {
  requested: { to: "under_review", label: "Start review" },
  under_review: { to: "confirmed", label: "Confirm request" },
  confirmed: null,
  withdrawn: null,
};

export function describeErasureRequest(row: ErasureRequestRow) {
  return {
    id: row.id,
    clientId: row.client_id,
    stateLabel: ERASURE_STATE_LABEL[row.state],
    reason: row.reason,
    reasonCleared: row.reason === null,
    requestedAt: row.requested_at,
    next: NEXT[row.state],
    canWithdraw: row.state !== "withdrawn",
    open: row.state !== "withdrawn",
  };
}

/** What the owner is shown for a client: the preferred name, else the name on file. The owner may read the legal name, but a list never needs it. */
export function erasureClientLabel(c: { preferred_name?: string | null; name?: string | null } | undefined): string {
  const preferred = c?.preferred_name?.trim();
  if (preferred) return preferred;
  return c?.name?.trim() ? "Name on file" : "Unknown client";
}

export function validateErasureReason(raw: unknown): { ok: true; reason: string } | { ok: false; error: string } {
  const reason = typeof raw === "string" ? raw.trim() : "";
  if (!reason) return { ok: false, error: "Say why this request is being recorded." };
  if (reason.length > ERASURE_REASON_MAX) return { ok: false, error: `Keep the reason to ${ERASURE_REASON_MAX} characters or fewer.` };
  return { ok: true, reason };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
