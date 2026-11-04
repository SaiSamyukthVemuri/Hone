import { ERASURE_NOT_AVAILABLE_YET, isUuid, validateErasureReason } from "./requests";

// The owner's three erasure commands (R5, DN-18), with their dependencies injected so the rules are unit-testable without a session.
// Prepared, not wired. The database (held 0295) is the authority: it re-derives the studio, the owner and the actor from the session and
// refuses everyone else with one indistinguishable error. This layer refuses non-owners first, takes the studio from the session (never
// from the form), validates shape, and turns database codes into plain copy that never echoes an id, a reason or a name.

export type ErasureCtx = {
  practitioner: { role: string; active: boolean };
  studio: { id: string };
  supabase: { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { code?: string } | null }> };
};
export type ErasureResult = { ok: true } | { ok: false; error: string };

const REFUSED = "Only the studio owner can manage erasure requests.";
const FAILED = "Could not save that. Try again.";

export function erasureErrorCopy(code: string | undefined): string {
  switch (code) {
    case "42501": return REFUSED;
    case "23505": return "This client already has an open erasure request.";
    case "23514": return "Say why this request is being recorded (up to 300 characters).";
    case "55000": return "That step is not available for this request.";
    case "22023": return "That step is not available for this request.";
    case "42883":
    case "PGRST202": return ERASURE_NOT_AVAILABLE_YET; // the database does not have the commands yet
    default: return FAILED;
  }
}

const isOwner = (c: ErasureCtx) => c.practitioner.active && c.practitioner.role === "owner";

async function call(ctx: ErasureCtx, fn: string, args: Record<string, unknown>): Promise<ErasureResult> {
  const { error } = await ctx.supabase.rpc(fn, args);
  return error ? { ok: false, error: erasureErrorCopy(error.code) } : { ok: true };
}

export async function requestErasure(ctx: ErasureCtx, input: { clientId: unknown; reason: unknown }): Promise<ErasureResult> {
  if (!isOwner(ctx)) return { ok: false, error: REFUSED };
  if (!isUuid(input.clientId)) return { ok: false, error: FAILED };
  const reason = validateErasureReason(input.reason);
  if (!reason.ok) return reason;
  return call(ctx, "request_client_erasure", { p_studio: ctx.studio.id, p_client: input.clientId, p_reason: reason.reason });
}

export async function advanceErasure(ctx: ErasureCtx, input: { requestId: unknown; to: unknown }): Promise<ErasureResult> {
  if (!isOwner(ctx)) return { ok: false, error: REFUSED };
  if (!isUuid(input.requestId) || (input.to !== "under_review" && input.to !== "confirmed")) return { ok: false, error: FAILED };
  return call(ctx, "advance_client_erasure_request", { p_studio: ctx.studio.id, p_request: input.requestId, p_to: input.to });
}

/** Replace the reason. A blank value is an error here, never a clear: clearing is its own deliberate command (Privacy DP1), because the earlier wording is not kept. */
export async function correctErasureReason(ctx: ErasureCtx, input: { requestId: unknown; reason: unknown }): Promise<ErasureResult> {
  if (!isOwner(ctx)) return { ok: false, error: REFUSED };
  if (!isUuid(input.requestId)) return { ok: false, error: FAILED };
  const reason = validateErasureReason(input.reason);
  if (!reason.ok) return reason;
  return call(ctx, "correct_client_erasure_reason", { p_studio: ctx.studio.id, p_request: input.requestId, p_reason: reason.reason });
}

/** Clear the reason (NULL). Only reachable from the explicit "Clear reason" control; the database audits that it happened, never the text. */
export async function clearErasureReason(ctx: ErasureCtx, input: { requestId: unknown }): Promise<ErasureResult> {
  if (!isOwner(ctx)) return { ok: false, error: REFUSED };
  if (!isUuid(input.requestId)) return { ok: false, error: FAILED };
  return call(ctx, "correct_client_erasure_reason", { p_studio: ctx.studio.id, p_request: input.requestId, p_reason: null });
}

export async function withdrawErasure(ctx: ErasureCtx, input: { requestId: unknown }): Promise<ErasureResult> {
  if (!isOwner(ctx)) return { ok: false, error: REFUSED };
  if (!isUuid(input.requestId)) return { ok: false, error: FAILED };
  return call(ctx, "withdraw_client_erasure_request", { p_studio: ctx.studio.id, p_request: input.requestId });
}
