import "server-only";
import { PHASE_B_ADDITIONAL_SCOPES } from "../config";
import type { ClaimedJob, JobResult } from "./job-result";
import type { ConnectionAuthRow, ConnectionStore, TokenManager } from "./token-manager";

// Google Calendar — Phase B2.1: the transport-neutral worker core.
//
// handleCalendarSyncJob is the single orchestration seam every transport (cron
// route, dedicated worker) calls. It depends on NO Next.js/Vercel/cron/host type
// and on NO feature flag being enabled. It performs the execution-time
// eligibility gate + token acquisition, then delegates the actual Google event
// operation to an INJECTED operations map. In B2.1 no real operations are wired
// (event create/update/delete are B2.4); tests inject mock operations to exercise
// the full JobResult mapping. The core NEVER creates/updates/deletes a Google
// event itself.

// The calendar.events scope is required to write events. It is NOT granted in
// Phase A; B2.2 adds it via incremental auth. Enforced here at execution time,
// mirroring the (B2.3) Option A claim-side eligibility filter.
export const REQUIRED_OUTBOUND_SCOPE = "https://www.googleapis.com/auth/calendar.events";
// Sanity: the required scope is the documented Phase-B additional scope.
const _scopeConsistency: boolean = PHASE_B_ADDITIONAL_SCOPES.includes(
  REQUIRED_OUTBOUND_SCOPE as (typeof PHASE_B_ADDITIONAL_SCOPES)[number],
);
void _scopeConsistency;

export type SyncOperationContext = {
  job: ClaimedJob;
  accessToken: string;
  connection: ConnectionAuthRow;
};

// The per-op-type dispatch table. B2.4 supplies real convergent handlers; B2.1
// wires none. A handler returns a JobResult (never throws for a Google outcome).
export type SyncOperations = Partial<Record<ClaimedJob["opType"], (ctx: SyncOperationContext) => Promise<JobResult>>>;

export type HandlerDeps = {
  store: ConnectionStore;
  tokenManager: TokenManager;
  isStudioOutboundEnabled: (studioId: string) => Promise<boolean>;
  operations: SyncOperations;
  now?: () => number;
};

export async function handleCalendarSyncJob(job: ClaimedJob, deps: HandlerDeps): Promise<JobResult> {
  // 1. Re-derive the connection by (connectionId, studioId). Never trust the job
  //    payload's ids alone for ownership.
  const conn = await deps.store.loadConnection(job.connectionId, job.studioId);
  if (!conn) {
    // The connection row is gone (or mid-teardown). Hold, don't kill.
    return { code: "retry_ineligible", errorCode: "connection_missing" };
  }

  // 2. Execution-time eligibility gate (mirrors the B2.3 Option A claim filter).
  if (conn.connectionStatus === "reconnect_required" || conn.connectionStatus === "revoked") {
    return { code: "terminal_reconnect_required", errorCode: `connection_${conn.connectionStatus}` };
  }
  if (!conn.grantedScopes.includes(REQUIRED_OUTBOUND_SCOPE)) {
    return { code: "terminal_insufficient_scope", errorCode: "missing_events_scope" };
  }
  if (conn.connectionStatus !== "connected" || !conn.isStudioCalendarOwner) {
    return { code: "retry_ineligible", errorCode: "connection_not_eligible" };
  }
  const outboundEnabled = await deps.isStudioOutboundEnabled(job.studioId);
  if (!outboundEnabled) {
    return { code: "retry_ineligible", errorCode: "outbound_flag_off" };
  }

  // 3. Acquire a valid access token (single-flight refresh + rotation handled by
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

  // 4. Dispatch the actual Google operation (B2.4). B2.1 wires no operations, so
  //    this path is only reachable in tests via an injected mock.
  const op = deps.operations[job.opType];
  if (!op) {
    // No handler for this op in this build: hold the job (do not dead it) so a
    // later phase's worker can process it once the operation is implemented.
    return { code: "retry_ineligible", errorCode: "operation_not_implemented" };
  }
  return op({ job, accessToken: token.accessToken, connection: conn });
}
