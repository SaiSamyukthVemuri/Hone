import "server-only";
import { CALENDAR_DISCOVERY_SCOPE } from "./config";
import { hasRequiredEventScopes } from "./destination-scopes";

// Google Calendar: Phase B2.2: connection READINESS is a DERIVED, server-side
// value. It is NOT a stored column and NOT a connection_status expansion.
//
// Why derived, not stored: a stored readiness flag goes stale the instant scopes
// change out-of-band (a user revokes a grant in their Google account, a token
// dies, an owner is re-designated). Deriving from the live connection fields can
// never be stale.
//
// This single function is the ONE source of truth that the settings UI (now) and
// the future B2.3 enable-gate + the worker eligibility filter (later) all consume
// so "ready" means the same thing everywhere. A browser role never supplies or
// stores readiness; it can only be computed from trusted server-side rows.
//
// Readiness NEVER flips the outbound flag. It only GATES whether the flag may be
// turned on; enablement stays an explicit, separate action.

export type ConnectionReadiness =
  | "disconnected" // no connection / credentials destroyed
  | "error" // connection_status = error
  | "reconnect_required" // token unusable / revoked / core scope lost
  | "connected_no_destination" // connected + healthy, but no appointment destination chosen yet
  | "dedicated_permission_required" // dedicated mode chosen, calendar.app.created NOT yet granted
  | "dedicated_provisioning_pending" // dedicated scope granted, the Hone calendar not yet provisioned
  | "existing_permission_required" // existing-owned mode chosen, calendar.events.owned NOT yet granted
  | "existing_selection_pending" // existing-owned scope granted, an owned calendar not yet validated/selected
  | "needs_attention" // provisioning reconciliation was ambiguous (multiple token matches), fail closed
  | "outbound_scope_ready"; // destination fully configured + exact scope + studio write target

export type ReadinessInput = {
  connectionStatus: "disconnected" | "connected" | "reconnect_required" | "revoked" | "error";
  grantedScopes: string[];
  hasUsableRefreshToken: boolean;
  isStudioCalendarOwner: boolean;
  writeCalendarId: string | null;
  // B2.4: the chosen destination. The required event scope DERIVES from it
  // (dedicated -> calendar.app.created; existing_owned -> calendar.events.owned).
  // NULL (not selected) or unknown => no event scope can be satisfied (fail-closed).
  destinationMode: string | null;
  // B2.4 provenance/provisioning inputs (all nullable). appCreatedCalendarId is
  // the dedicated-provisioning anchor; destinationOwnershipValidatedAt marks a
  // validated existing-owned target; provisioningAmbiguousAt marks a fail-closed
  // multi-match reconciliation that needs attention.
  appCreatedCalendarId?: string | null;
  destinationOwnershipValidatedAt?: string | null;
  provisioningAmbiguousAt?: string | null;
};

export function deriveConnectionReadiness(input: ReadinessInput): ConnectionReadiness {
  const s = input.connectionStatus;
  if (s === "disconnected") return "disconnected";
  if (s === "error") return "error";
  if (s === "reconnect_required" || s === "revoked") return "reconnect_required";

  // connection_status === "connected"
  if (!input.hasUsableRefreshToken) return "reconnect_required"; // "connected" label but no usable token
  if (!input.grantedScopes.includes(CALENDAR_DISCOVERY_SCOPE)) return "reconnect_required"; // lost the core Phase-A scope

  // A fail-closed provisioning ambiguity outranks every "progress" state.
  if (input.provisioningAmbiguousAt) return "needs_attention";

  const mode = input.destinationMode;
  if (mode == null) return "connected_no_destination"; // NULL never defaults to a mode

  // B2.4: destination-aware, EXACT set membership. Broad calendar.events satisfies
  // NOTHING; the required scope depends on the chosen destination mode.
  const hasScope = hasRequiredEventScopes(mode, input.grantedScopes);
  const isReadyTarget = input.isStudioCalendarOwner && !!input.writeCalendarId;

  if (mode === "dedicated_app_created") {
    if (!hasScope) return "dedicated_permission_required";
    // Scope granted (credentials replaced) but the Hone calendar not yet created.
    if (!input.appCreatedCalendarId) return "dedicated_provisioning_pending";
    if (isReadyTarget) return "outbound_scope_ready";
    return "dedicated_provisioning_pending";
  }

  if (mode === "existing_owned") {
    if (!hasScope) return "existing_permission_required";
    // Scope granted but an owned calendar not yet validated + selected.
    if (!input.destinationOwnershipValidatedAt || !input.writeCalendarId) {
      return "existing_selection_pending";
    }
    if (isReadyTarget) return "outbound_scope_ready";
    return "existing_selection_pending";
  }

  // Unknown/tampered mode (DB CHECK prevents storing one) => fail-closed not-ready.
  return "connected_no_destination";
}

// Whether the settings card should surface a "Grant permission" CTA (the next step
// is an incremental scope grant for the chosen destination).
export function readinessNeedsEventScope(r: ConnectionReadiness): boolean {
  return r === "dedicated_permission_required" || r === "existing_permission_required";
}

// Whether the connection is fully authorized for future outbound event writes.
// This is exactly the predicate the B2.3 enable-gate + worker filter will reuse
// (and mirrors the DB calendar_connection_outbound_ready gate's true-case).
export function readinessIsOutboundReady(r: ConnectionReadiness): boolean {
  return r === "outbound_scope_ready";
}

// Whether the connection has the destination scope but still needs the owner to
// finish configuring the target (create the Hone calendar / select an owned one).
export function readinessNeedsDestinationSetup(r: ConnectionReadiness): boolean {
  return r === "dedicated_provisioning_pending" || r === "existing_selection_pending";
}
