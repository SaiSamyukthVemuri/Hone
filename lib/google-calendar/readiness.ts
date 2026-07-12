import "server-only";
import { CALENDAR_DISCOVERY_SCOPE, EVENT_WRITE_SCOPE } from "./config";

// Google Calendar — Phase B2.2: connection READINESS is a DERIVED, server-side
// value. It is NOT a stored column and NOT a connection_status expansion.
//
// Why derived, not stored: a stored readiness flag goes stale the instant scopes
// change out-of-band (a user revokes a grant in their Google account, a token
// dies, an owner is re-designated). Deriving from the live connection fields can
// never be stale.
//
// This single function is the ONE source of truth that the settings UI (now) and
// the future B2.3 enable-gate + the worker eligibility filter (later) all consume
// — so "ready" means the same thing everywhere. A browser role never supplies or
// stores readiness; it can only be computed from trusted server-side rows.
//
// Readiness NEVER flips the outbound flag. It only GATES whether the flag may be
// turned on; enablement stays an explicit, separate action.

export type ConnectionReadiness =
  | "disconnected" // no connection / credentials destroyed
  | "error" // connection_status = error
  | "reconnect_required" // token unusable / revoked / core scope lost
  | "connected_phase_a" // connected + healthy, but not the studio's designated ready write target
  | "scope_upgrade_required" // the designated write target, connected on Phase-A scopes, MISSING calendar.events
  | "outbound_scope_ready"; // the designated write target, fully authorized incl. calendar.events

export type ReadinessInput = {
  connectionStatus: "disconnected" | "connected" | "reconnect_required" | "revoked" | "error";
  grantedScopes: string[];
  hasUsableRefreshToken: boolean;
  isStudioCalendarOwner: boolean;
  writeCalendarId: string | null;
};

export function deriveConnectionReadiness(input: ReadinessInput): ConnectionReadiness {
  const s = input.connectionStatus;
  if (s === "disconnected") return "disconnected";
  if (s === "error") return "error";
  if (s === "reconnect_required" || s === "revoked") return "reconnect_required";

  // connection_status === "connected"
  if (!input.hasUsableRefreshToken) return "reconnect_required"; // "connected" label but no usable token
  if (!input.grantedScopes.includes(CALENDAR_DISCOVERY_SCOPE)) return "reconnect_required"; // lost the core Phase-A scope

  const hasEvents = input.grantedScopes.includes(EVENT_WRITE_SCOPE);
  const isReadyTarget = input.isStudioCalendarOwner && !!input.writeCalendarId;

  if (hasEvents && isReadyTarget) return "outbound_scope_ready";
  if (!hasEvents && isReadyTarget) return "scope_upgrade_required";
  // Connected + healthy but NOT the designated write target (not the studio
  // calendar owner and/or no write calendar selected): no upgrade is asked of it.
  return "connected_phase_a";
}

// Whether the settings card should surface the "Grant event access" upgrade CTA.
export function readinessNeedsEventScope(r: ConnectionReadiness): boolean {
  return r === "scope_upgrade_required";
}

// Whether the connection is fully authorized for future outbound event writes.
// This is exactly the predicate the B2.3 enable-gate + worker filter will reuse.
export function readinessIsOutboundReady(r: ConnectionReadiness): boolean {
  return r === "outbound_scope_ready";
}
