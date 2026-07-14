import { describe, expect, it } from "vitest";
import {
  deriveConnectionReadiness,
  readinessIsOutboundReady,
  readinessNeedsDestinationSetup,
  readinessNeedsEventScope,
  type ReadinessInput,
} from "@/lib/google-calendar/readiness";
import { CALENDAR_DISCOVERY_SCOPE } from "@/lib/google-calendar/config";
import {
  CALENDAR_EVENTS_OWNED_SCOPE,
  CALENDAR_APP_CREATED_SCOPE,
} from "@/lib/google-calendar/destination-scopes";

// Phase B2.4 — connection readiness is DERIVED (never stored). The event scope
// requirement is DESTINATION-AWARE (exact set membership), and the derivation
// expresses the per-mode setup progression (permission required -> provisioning/
// selection pending -> ready) plus a fail-closed needs-attention state.
const EVENTS_BROAD = "https://www.googleapis.com/auth/calendar.events";

// A fully-configured, READY existing_owned connection as the baseline; tests vary it.
function input(overrides: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    connectionStatus: "connected",
    grantedScopes: [CALENDAR_DISCOVERY_SCOPE, CALENDAR_EVENTS_OWNED_SCOPE],
    hasUsableRefreshToken: true,
    isStudioCalendarOwner: true,
    writeCalendarId: "cal-owned",
    destinationMode: "existing_owned",
    appCreatedCalendarId: null,
    destinationOwnershipValidatedAt: "2026-07-13T00:00:00Z",
    provisioningAmbiguousAt: null,
    ...overrides,
  };
}

describe("deriveConnectionReadiness — connection health", () => {
  it("disconnected / error", () => {
    expect(deriveConnectionReadiness(input({ connectionStatus: "disconnected" }))).toBe("disconnected");
    expect(deriveConnectionReadiness(input({ connectionStatus: "error" }))).toBe("error");
  });
  it("reconnect_required from revoked/reconnect_required/no-token/no-discovery", () => {
    expect(deriveConnectionReadiness(input({ connectionStatus: "revoked" }))).toBe("reconnect_required");
    expect(deriveConnectionReadiness(input({ connectionStatus: "reconnect_required" }))).toBe("reconnect_required");
    expect(deriveConnectionReadiness(input({ hasUsableRefreshToken: false }))).toBe("reconnect_required");
    expect(deriveConnectionReadiness(input({ grantedScopes: ["openid"] }))).toBe("reconnect_required");
  });
});

describe("deriveConnectionReadiness — destination progression", () => {
  it("connected_no_destination when no mode is chosen (NULL never defaults to a mode)", () => {
    expect(deriveConnectionReadiness(input({ destinationMode: null }))).toBe("connected_no_destination");
    // Even with an event scope granted, a null destination is not ready.
    expect(
      deriveConnectionReadiness(input({ destinationMode: null, grantedScopes: [CALENDAR_DISCOVERY_SCOPE, CALENDAR_EVENTS_OWNED_SCOPE] })),
    ).toBe("connected_no_destination");
  });

  it("needs_attention when provisioning was ambiguous (outranks progress)", () => {
    expect(
      deriveConnectionReadiness(
        input({ destinationMode: "dedicated_app_created", provisioningAmbiguousAt: "2026-07-13T01:00:00Z" }),
      ),
    ).toBe("needs_attention");
  });

  it("dedicated_permission_required: dedicated mode, app.created not yet granted", () => {
    expect(
      deriveConnectionReadiness(
        input({ destinationMode: "dedicated_app_created", grantedScopes: [CALENDAR_DISCOVERY_SCOPE] }),
      ),
    ).toBe("dedicated_permission_required");
  });
  it("dedicated_provisioning_pending: app.created granted but calendar not created", () => {
    expect(
      deriveConnectionReadiness(
        input({
          destinationMode: "dedicated_app_created",
          grantedScopes: [CALENDAR_DISCOVERY_SCOPE, CALENDAR_APP_CREATED_SCOPE],
          appCreatedCalendarId: null,
          writeCalendarId: null,
        }),
      ),
    ).toBe("dedicated_provisioning_pending");
  });
  it("outbound_scope_ready (dedicated): app.created granted + calendar created + owner target", () => {
    expect(
      deriveConnectionReadiness(
        input({
          destinationMode: "dedicated_app_created",
          grantedScopes: [CALENDAR_DISCOVERY_SCOPE, CALENDAR_APP_CREATED_SCOPE],
          appCreatedCalendarId: "hone-appts-cal",
          writeCalendarId: "hone-appts-cal",
        }),
      ),
    ).toBe("outbound_scope_ready");
  });

  it("existing_permission_required: existing mode, events.owned not yet granted", () => {
    expect(
      deriveConnectionReadiness(
        input({ grantedScopes: [CALENDAR_DISCOVERY_SCOPE], destinationOwnershipValidatedAt: null, writeCalendarId: null }),
      ),
    ).toBe("existing_permission_required");
  });
  it("existing_selection_pending: events.owned granted but no validated owned calendar", () => {
    expect(
      deriveConnectionReadiness(input({ destinationOwnershipValidatedAt: null, writeCalendarId: null })),
    ).toBe("existing_selection_pending");
  });
  it("outbound_scope_ready (existing_owned): events.owned granted + validated owned target", () => {
    expect(deriveConnectionReadiness(input())).toBe("outbound_scope_ready");
  });
});

describe("deriveConnectionReadiness — exact-scope prefix protection", () => {
  it("broad calendar.events does NOT satisfy existing_owned -> permission still required", () => {
    expect(
      deriveConnectionReadiness(
        input({ grantedScopes: [CALENDAR_DISCOVERY_SCOPE, EVENTS_BROAD], destinationOwnershipValidatedAt: null, writeCalendarId: null }),
      ),
    ).toBe("existing_permission_required");
  });
  it("wrong-mode scope does NOT satisfy (owned scope for dedicated mode)", () => {
    expect(
      deriveConnectionReadiness(
        input({
          destinationMode: "dedicated_app_created",
          grantedScopes: [CALENDAR_DISCOVERY_SCOPE, CALENDAR_EVENTS_OWNED_SCOPE],
        }),
      ),
    ).toBe("dedicated_permission_required");
  });
  it("app.created does NOT satisfy existing_owned", () => {
    expect(
      deriveConnectionReadiness(
        input({ grantedScopes: [CALENDAR_DISCOVERY_SCOPE, CALENDAR_APP_CREATED_SCOPE], destinationOwnershipValidatedAt: null, writeCalendarId: null }),
      ),
    ).toBe("existing_permission_required");
  });
});

describe("readiness helper predicates", () => {
  it("needsEventScope / needsDestinationSetup / isOutboundReady", () => {
    expect(readinessNeedsEventScope("dedicated_permission_required")).toBe(true);
    expect(readinessNeedsEventScope("existing_permission_required")).toBe(true);
    expect(readinessNeedsEventScope("outbound_scope_ready")).toBe(false);
    expect(readinessNeedsDestinationSetup("dedicated_provisioning_pending")).toBe(true);
    expect(readinessNeedsDestinationSetup("existing_selection_pending")).toBe(true);
    expect(readinessNeedsDestinationSetup("outbound_scope_ready")).toBe(false);
    expect(readinessIsOutboundReady("outbound_scope_ready")).toBe(true);
    expect(readinessIsOutboundReady("dedicated_permission_required")).toBe(false);
  });
});
