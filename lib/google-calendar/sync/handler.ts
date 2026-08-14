import "server-only";
import { hasRequiredEventScopes } from "../destination-scopes";
import type { ClaimedJob, JobResult } from "./job-result";
import type { ConnectionAuthRow, ConnectionStore, TokenManager } from "./token-manager";

// Google Calendar: Phase B2.1: the transport-neutral worker core.
//
// handleCalendarSyncJob is the single orchestration seam every transport (cron
// route, dedicated worker) calls. It depends on NO Next.js/Vercel/cron/host type
// and on NO feature flag being enabled. It performs the execution-time
// eligibility gate + token acquisition, then delegates the actual Google event
// operation to an INJECTED operations map. B2.3-c1 supplies the real event
// create/update/delete operations (dormant, wired to no route); tests also
// inject mock operations to exercise the full JobResult mapping. The core NEVER
// creates/updates/deletes a Google event itself.

// B2.4: the required outbound event scope is DESTINATION-AWARE (derived from the
// connection's destination_mode via hasRequiredEventScopes), calendar.app.created
// for a Hone-created calendar, calendar.events.owned for an existing owned
// calendar. Broad calendar.events satisfies eligibility NOWHERE. This execution-
// time gate mirrors the (B2.3/0131) claim-side calendar_connection_outbound_ready
// filter. NOT granted in Phase A; B2.2 adds it via incremental auth.

export type SyncOperationContext = {
  job: ClaimedJob;
  accessToken: string;
  connection: ConnectionAuthRow;
};

// The per-op-type dispatch table. B2.3-c1 supplies real convergent handlers; the
// core wires none by default. A handler returns a JobResult (never throws for a
// Google outcome).
export type SyncOperations = Partial<Record<ClaimedJob["opType"], (ctx: SyncOperationContext) => Promise<JobResult>>>;

export type HandlerDeps = {
  store: ConnectionStore;
  tokenManager: TokenManager;
  isStudioOutboundEnabled: (studioId: string) => Promise<boolean>;
  operations: SyncOperations;
  now?: () => number;
};

// The SINGLE execution-time connection-eligibility contract, run against a given
// connection row (the pre-token row, then authoritatively against token.connection).
// Returns null when eligible, or the mapped JobResult when not. It mirrors the
// (B2.3/0131) claim-side calendar_connection_outbound_ready filter and NEVER lets an
// ineligible/stale connection reach the event operation.
export function classifyConnectionEligibility(conn: ConnectionAuthRow, job: ClaimedJob): JobResult | null {
  // Tenant integrity: the loaded row must match the claimed job (never dispatch on a mismatch).
  if (conn.id !== job.connectionId || conn.studioId !== job.studioId) {
    return { code: "retry_ineligible", errorCode: "connection_tenant_mismatch" };
  }
  if (conn.connectionStatus === "reconnect_required" || conn.connectionStatus === "revoked") {
    return { code: "terminal_reconnect_required", errorCode: `connection_${conn.connectionStatus}` };
  }
  // Destination-derived exact scope; broad calendar.events satisfies eligibility NOWHERE.
  if (!hasRequiredEventScopes(conn.destinationMode, conn.grantedScopes)) {
    return { code: "terminal_insufficient_scope", errorCode: "missing_destination_scope" };
  }
  if (conn.connectionStatus !== "connected" || !conn.isStudioCalendarOwner) {
    return { code: "retry_ineligible", errorCode: "connection_not_eligible" };
  }
  if (!conn.writeCalendarId || conn.writeCalendarId.length === 0) {
    return { code: "retry_ineligible", errorCode: "missing_write_calendar" };
  }
  return null;
}

export async function handleCalendarSyncJob(job: ClaimedJob, deps: HandlerDeps): Promise<JobResult> {
  // 1. Pre-token gate: re-derive the connection by (connectionId, studioId) and run
  //    the FULL eligibility contract (incl. writeCalendarId) + the outbound flag,
  //    so an already-ineligible job never does unnecessary token work.
  const conn = await deps.store.loadConnection(job.connectionId, job.studioId);
  if (!conn) return { code: "retry_ineligible", errorCode: "connection_missing" };
  const preEligibility = classifyConnectionEligibility(conn, job);
  if (preEligibility) return preEligibility;
  if (!(await deps.isStudioOutboundEnabled(job.studioId))) {
    return { code: "retry_ineligible", errorCode: "outbound_flag_off" };
  }

  // 2. Acquire a valid access token (single-flight refresh + rotation handled by
  //    the token manager). Auth failures map to terminal/retry codes.
  const token = await deps.tokenManager.ensureAccessToken(job.connectionId, job.studioId);
  if (!token.ok) {
    if (token.kind === "reconnect_required") {
      return { code: "terminal_reconnect_required", errorCode: token.code };
    }
    if (token.kind === "insufficient_scope") {
      return { code: "terminal_insufficient_scope", errorCode: token.code };
    }
    return { code: "retry_transient", errorCode: token.code, retryAfterSeconds: token.retryAfterSeconds };
  }

  // 3. Post-token AUTHORITATIVE gate: token.connection is the fresher current row
  //    (the refresh may have flipped reconnect_required / rotated / re-read). Re-run
  //    the full contract against it, re-read the outbound flag immediately before
  //    dispatch, and NEVER continue using the older pre-token connection.
  const current = token.connection;
  const postEligibility = classifyConnectionEligibility(current, job);
  if (postEligibility) return postEligibility;
  if (!(await deps.isStudioOutboundEnabled(job.studioId))) {
    return { code: "retry_ineligible", errorCode: "outbound_flag_off" };
  }

  // 4. Dispatch the actual Google operation (B2.3-c1 operations map) with the
  //    authoritative token.connection. The core wires no operations by default, so
  //    in production this path is dormant.
  const op = deps.operations[job.opType];
  if (!op) {
    // No handler for this op in this build: hold the job (do not dead it) so a
    // later phase's worker can process it once the operation is implemented.
    return { code: "retry_ineligible", errorCode: "operation_not_implemented" };
  }
  return op({ job, accessToken: token.accessToken, connection: current });
}
