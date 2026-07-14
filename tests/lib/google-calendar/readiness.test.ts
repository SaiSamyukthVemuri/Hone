import { describe, expect, it } from "vitest";
import {
  deriveConnectionReadiness,
  readinessIsOutboundReady,
  readinessNeedsEventScope,
  type ReadinessInput,
} from "@/lib/google-calendar/readiness";
import { CALENDAR_DISCOVERY_SCOPE } from "@/lib/google-calendar/config";
import {
  CALENDAR_EVENTS_OWNED_SCOPE,
  CALENDAR_APP_CREATED_SCOPE,
} from "@/lib/google-calendar/destination-scopes";

// Phase B2.2/B2.4 — connection readiness is DERIVED (never stored). The event
// scope requirement is now DESTINATION-AWARE (exact set membership).
const EVENTS_BROAD = "https://www.googleapis.com/auth/calendar.events";

function input(overrides: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    connectionStatus: "connected",
    grantedScopes: [CALENDAR_DISCOVERY_SCOPE],
    hasUsableRefreshToken: true,
    isStudioCalendarOwner: true,
    writeCalendarId: "primary",
    destinationMode: "existing_owned",
    ...overrides,
  };
}

describe("deriveConnectionReadiness — all six values", () => {
  it("disconnected", () => {
    expect(deriveConnectionReadiness(input({ connectionStatus: "disconnected" }))).toBe("disconnected");
  });
  it("error", () => {
    expect(deriveConnectionReadiness(input({ connectionStatus: "error" }))).toBe("error");
  });
  it("reconnect_required from status revoked/reconnect_required", () => {
    expect(deriveConnectionReadiness(input({ connectionStatus: "revoked" }))).toBe("reconnect_required");
    expect(deriveConnectionReadiness(input({ connectionStatus: "reconnect_required" }))).toBe("reconnect_required");
  });
  it("reconnect_required when connected but no usable refresh token", () => {
    expect(deriveConnectionReadiness(input({ hasUsableRefreshToken: false }))).toBe("reconnect_required");
  });
  it("reconnect_required when the core discovery scope was lost", () => {
    expect(deriveConnectionReadiness(input({ grantedScopes: ["openid"] }))).toBe("reconnect_required");
  });
  it("scope_upgrade_required: designated write target, Phase-A scopes, no event scope", () => {
    expect(deriveConnectionReadiness(input({ grantedScopes: [CALENDAR_DISCOVERY_SCOPE] }))).toBe("scope_upgrade_required");
  });
  it("outbound_scope_ready (existing_owned): designated target + calendar.events.owned granted", () => {
    expect(
      deriveConnectionReadiness(input({ grantedScopes: [CALENDAR_DISCOVERY_SCOPE, CALENDAR_EVENTS_OWNED_SCOPE] })),
    ).toBe("outbound_scope_ready");
  });
  it("outbound_scope_ready (dedicated_app_created): designated target + calendar.app.created granted", () => {
    expect(
      deriveConnectionReadiness(
        input({ destinationMode: "dedicated_app_created", grantedScopes: [CALENDAR_DISCOVERY_SCOPE, CALENDAR_APP_CREATED_SCOPE] }),
      ),
    ).toBe("outbound_scope_ready");
  });
  it("broad calendar.events does NOT satisfy existing_owned (prefix trap) -> scope_upgrade_required", () => {
    expect(
      deriveConnectionReadiness(input({ grantedScopes: [CALENDAR_DISCOVERY_SCOPE, EVENTS_BROAD] })),
    ).toBe("scope_upgrade_required");
  });
  it("wrong-mode scope does NOT satisfy (owned scope for dedicated mode) -> scope_upgrade_required", () => {
    expect(
      deriveConnectionReadiness(
        input({ destinationMode: "dedicated_app_created", grantedScopes: [CALENDAR_DISCOVERY_SCOPE, CALENDAR_EVENTS_OWNED_SCOPE] }),
      ),
    ).toBe("scope_upgrade_required");
  });
  it("no destination selected is fail-closed even with an event scope granted", () => {
    expect(
      deriveConnectionReadiness(
        input({ destinationMode: null, grantedScopes: [CALENDAR_DISCOVERY_SCOPE, CALENDAR_EVENTS_OWNED_SCOPE] }),
      ),
    ).toBe("scope_upgrade_required");
  });
  it("connected_phase_a: connected + healthy but NOT the designated write target", () => {
    expect(deriveConnectionReadiness(input({ isStudioCalendarOwner: false }))).toBe("connected_phase_a");
    expect(deriveConnectionReadiness(input({ writeCalendarId: null }))).toBe("connected_phase_a");
    // Even with the event scope, a non-owner is connected_phase_a, not ready.
    expect(
      deriveConnectionReadiness(input({ isStudioCalendarOwner: false, grantedScopes: [CALENDAR_DISCOVERY_SCOPE, CALENDAR_EVENTS_OWNED_SCOPE] })),
    ).toBe("connected_phase_a");
  });

  it("helper predicates", () => {
    expect(readinessNeedsEventScope("scope_upgrade_required")).toBe(true);
    expect(readinessNeedsEventScope("outbound_scope_ready")).toBe(false);
    expect(readinessIsOutboundReady("outbound_scope_ready")).toBe(true);
    expect(readinessIsOutboundReady("scope_upgrade_required")).toBe(false);
  });
});
