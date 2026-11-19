import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase B2.4 — the DESTINATION-AWARE event-scope upgrade server action
// (behavioral, mocked deps) plus source pins for the callback route + settings
// card. The requested scope now DERIVES from the connection's chosen destination:
// dedicated -> calendar.app.created, existing_owned -> calendar.events.owned.
// Broad `calendar.events` (the old EVENT_WRITE_SCOPE) was REMOVED — it is
// requested nowhere. The exact bound scope is carried on the OAuth state so the
// callback can reject a destination/scope that changed.

const jar = { set: vi.fn(), get: vi.fn(), delete: vi.fn() };
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => jar) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/queries", () => ({ getCurrentPractitionerWithStudio: vi.fn() }));
vi.mock("@/lib/google-calendar/state", () => ({ createOAuthState: vi.fn() }));
vi.mock("@/lib/google-calendar/token-crypto", () => ({
  isGoogleTokenCryptoConfigured: vi.fn(() => true),
  decryptGoogleSecret: vi.fn(() => ({ ok: true, secret: "rt" })),
}));
vi.mock("@/lib/google-calendar/config", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/google-calendar/config")>();
  return { ...actual, getGoogleOAuthClient: vi.fn(() => ({ clientId: "cid", clientSecret: "sec" })) };
});
vi.mock("@/lib/google-calendar/oauth", () => ({
  buildAuthorizationUrl: vi.fn(() => "https://accounts.google.com/o/oauth2/v2/auth?state=x"),
  createSecondaryCalendar: vi.fn(),
  fetchCalendarList: vi.fn(),
  findCalendarsByDescriptionToken: vi.fn(),
  randomUrlToken: vi.fn(() => "a".repeat(32)),
  refreshAccessToken: vi.fn(),
  revokeToken: vi.fn(),
}));
vi.mock("@/lib/google-calendar/connection", () => ({
  getOwnConnectionMetadata: vi.fn(),
  getRefreshTokenCiphertext: vi.fn(),
  markReconnectRequired: vi.fn(),
  disconnectConnection: vi.fn(),
  setWriteCalendar: vi.fn(),
  designateStudioCalendarOwner: vi.fn(),
  setDestinationMode: vi.fn(),
  setOwnedCalendarDestination: vi.fn(),
  setDedicatedCalendarDestination: vi.fn(),
  beginDedicatedProvisioningAttempt: vi.fn(),
  markDedicatedProvisioningAmbiguous: vi.fn(),
}));

import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { createOAuthState } from "@/lib/google-calendar/state";
import { buildAuthorizationUrl } from "@/lib/google-calendar/oauth";
import { getOwnConnectionMetadata } from "@/lib/google-calendar/connection";
import {
  CALENDAR_APP_CREATED_SCOPE,
  CALENDAR_EVENTS_OWNED_SCOPE,
} from "@/lib/google-calendar/destination-scopes";
import { startGoogleCalendarEventScopeUpgradeAction } from "@/app/(app)/settings/profile/google-calendar-actions";

// Broad `calendar.events` — the prefix trap. It must NEVER be requested.
const EVENTS_BROAD = "https://www.googleapis.com/auth/calendar.events";

const mockCtx = (
  over: { connEnabled?: boolean; outboundEnabled?: boolean; active?: boolean; role?: string } = {},
) => {
  vi.mocked(getCurrentPractitionerWithStudio).mockResolvedValue({
    practitioner: { id: "p1", user_id: "u1", active: over.active ?? true, role: over.role ?? "owner" },
    studio: {
      id: "s1",
      google_calendar_connection_enabled: over.connEnabled ?? true,
      google_calendar_outbound_sync_enabled: over.outboundEnabled ?? false,
    },
  } as unknown as Awaited<ReturnType<typeof getCurrentPractitionerWithStudio>>);
};

const conn = (over: Record<string, unknown> = {}) =>
  ({
    connectionStatus: "connected",
    googleAccountEmail: "sam@example.com",
    destinationMode: "existing_owned",
    ...over,
  }) as unknown as Awaited<ReturnType<typeof getOwnConnectionMetadata>>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createOAuthState).mockResolvedValue({ ok: true, state: "st", nonce: "no", codeChallenge: "cc" });
  vi.mocked(getOwnConnectionMetadata).mockResolvedValue(conn());
});
afterEach(() => vi.restoreAllMocks());

describe("startGoogleCalendarEventScopeUpgradeAction — destination-derived scope", () => {
  it("existing_owned requests ONLY calendar.events.owned (never broad calendar.events)", async () => {
    mockCtx();
    vi.mocked(getOwnConnectionMetadata).mockResolvedValue(conn({ destinationMode: "existing_owned" }));
    const r = await startGoogleCalendarEventScopeUpgradeAction();
    expect(r.ok).toBe(true);
    const args = vi.mocked(buildAuthorizationUrl).mock.calls[0][0];
    expect(args.scopes).toEqual([CALENDAR_EVENTS_OWNED_SCOPE]);
    expect(args.scopes).not.toContain(EVENTS_BROAD);
    expect(args.forceConsent).toBe(true);
    expect(jar.set).toHaveBeenCalledWith(expect.objectContaining({ sameSite: "lax", httpOnly: true }));
  });

  it("dedicated_app_created requests ONLY calendar.app.created (never broad calendar.events)", async () => {
    mockCtx();
    vi.mocked(getOwnConnectionMetadata).mockResolvedValue(conn({ destinationMode: "dedicated_app_created" }));
    const r = await startGoogleCalendarEventScopeUpgradeAction();
    expect(r.ok).toBe(true);
    const args = vi.mocked(buildAuthorizationUrl).mock.calls[0][0];
    expect(args.scopes).toEqual([CALENDAR_APP_CREATED_SCOPE]);
    expect(args.scopes).not.toContain(EVENTS_BROAD);
  });

  it("BINDS destination.mode + the EXACT required scope onto the OAuth state (existing_owned)", async () => {
    mockCtx();
    vi.mocked(getOwnConnectionMetadata).mockResolvedValue(conn({ destinationMode: "existing_owned" }));
    await startGoogleCalendarEventScopeUpgradeAction();
    expect(createOAuthState).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: { mode: "existing_owned", requiredScope: CALENDAR_EVENTS_OWNED_SCOPE },
      }),
    );
  });

  it("BINDS destination.mode + the EXACT required scope onto the OAuth state (dedicated)", async () => {
    mockCtx();
    vi.mocked(getOwnConnectionMetadata).mockResolvedValue(conn({ destinationMode: "dedicated_app_created" }));
    await startGoogleCalendarEventScopeUpgradeAction();
    expect(createOAuthState).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: { mode: "dedicated_app_created", requiredScope: CALENDAR_APP_CREATED_SCOPE },
      }),
    );
  });

  it("rejects when NO destination has been chosen yet (mode null) — scope has nothing to derive from", async () => {
    mockCtx();
    vi.mocked(getOwnConnectionMetadata).mockResolvedValue(conn({ destinationMode: null }));
    const r = await startGoogleCalendarEventScopeUpgradeAction();
    expect(r.ok).toBe(false);
    expect(buildAuthorizationUrl).not.toHaveBeenCalled();
    expect(createOAuthState).not.toHaveBeenCalled();
  });

  it("rejects an unknown/tampered destination mode (fail-closed)", async () => {
    mockCtx();
    vi.mocked(getOwnConnectionMetadata).mockResolvedValue(conn({ destinationMode: "something_else" }));
    const r = await startGoogleCalendarEventScopeUpgradeAction();
    expect(r.ok).toBe(false);
    expect(buildAuthorizationUrl).not.toHaveBeenCalled();
  });

  it("rejects when the outbound sync flag is ON (never entangle scope + enablement)", async () => {
    mockCtx({ outboundEnabled: true });
    const r = await startGoogleCalendarEventScopeUpgradeAction();
    expect(r.ok).toBe(false);
    expect(buildAuthorizationUrl).not.toHaveBeenCalled();
  });

  it("rejects when the connection flag is OFF", async () => {
    mockCtx({ connEnabled: false });
    const r = await startGoogleCalendarEventScopeUpgradeAction();
    expect(r.ok).toBe(false);
    expect(buildAuthorizationUrl).not.toHaveBeenCalled();
  });

  it("rejects a non-owner practitioner (owner-only destination management)", async () => {
    mockCtx({ role: "member" });
    const r = await startGoogleCalendarEventScopeUpgradeAction();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/owner/i);
    expect(buildAuthorizationUrl).not.toHaveBeenCalled();
  });

  it("rejects when there is no existing connection to upgrade", async () => {
    mockCtx();
    vi.mocked(getOwnConnectionMetadata).mockResolvedValue(null);
    const r = await startGoogleCalendarEventScopeUpgradeAction();
    expect(r.ok).toBe(false);
    expect(buildAuthorizationUrl).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Source pins — the callback route + settings card invariants the Vitest node
// env can't exercise directly (updated to the B2.4 destination contract).
// ---------------------------------------------------------------------------
describe("callback route — source pins for the B2.4 destination guards", () => {
  const src = readFileSync(
    join(process.cwd(), "app/api/google-calendar/oauth/callback/route.ts"),
    "utf8",
  );
  it("rejects account switching (identity mismatch => account_mismatch, no overwrite)", () => {
    expect(src).toMatch(/getConnectionAccountId/);
    expect(src).toMatch(/existingAccountId !== null && existingAccountId !== info\.sub/);
    expect(src).toMatch(/"account_mismatch"/);
  });
  it("verifies granted scopes with token-response primary + tokeninfo fallback (normalized)", () => {
    expect(src).toMatch(/grantedScopes = normalizeGrantedScopes\(token\.grantedScopes\)/);
    expect(src).toMatch(/grantedScopes\.length === 0[\s\S]{0,120}fetchTokenInfoScopes/);
  });
  it("gates on the EXACT destination scope + destination_changed, never resets the write calendar", () => {
    expect(src).toMatch(/hasRequiredEventScopes\(boundMode, grantedScopes\)/);
    expect(src).toMatch(/"destination_changed"/);
    expect(src).toMatch(/event_scope_granted|event_scope_not_granted/);
    expect(src).toMatch(/existing\?\.writeCalendarId/);
  });
  it("no longer imports the removed broad EVENT_WRITE_SCOPE", () => {
    expect(src).not.toMatch(/EVENT_WRITE_SCOPE/);
  });
  it("does not enqueue, sync, or write a Google event", () => {
    expect(src).not.toMatch(/calendar_sync_outbox|calendar_event_links|events\.(insert|patch|delete)/);
  });
});

describe("settings card — B2.4 destination-driven UX source pins", () => {
  const src = readFileSync(
    join(process.cwd(), "app/(app)/settings/profile/GoogleCalendarCard.tsx"),
    "utf8",
  );
  it("consumes derived readiness + drives the destination setup + scope-upgrade CTA", () => {
    expect(src).toMatch(/readiness: ConnectionReadiness/);
    expect(src).toMatch(/startGoogleCalendarEventScopeUpgradeAction/);
    expect(src).toMatch(/dedicated_permission_required/);
    expect(src).toMatch(/existing_permission_required/);
    expect(src).toMatch(/outbound_scope_ready/);
    expect(src).toMatch(/Grant permission to (create a calendar|use your calendar)/);
    expect(src).toMatch(/Synchronization is still disabled/);
  });
  it("never renders a token/scope-consent secret or claims sync is active", () => {
    expect(src).not.toMatch(/accessToken|refresh_token|codeVerifier/);
    expect(src).not.toMatch(/synchronization is active|sync is on|syncing/i);
  });
});
