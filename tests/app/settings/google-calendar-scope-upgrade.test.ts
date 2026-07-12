import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase B2.2 — the event-scope upgrade server action (behavioral, mocked deps)
// plus source pins for the callback route (account-match, tokeninfo fallback,
// event-scope banners) and the settings card (readiness-driven UX).

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
  fetchCalendarList: vi.fn(),
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
}));

import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { createOAuthState } from "@/lib/google-calendar/state";
import { buildAuthorizationUrl } from "@/lib/google-calendar/oauth";
import { getOwnConnectionMetadata } from "@/lib/google-calendar/connection";
import { EVENT_WRITE_SCOPE } from "@/lib/google-calendar/config";
import { startGoogleCalendarEventScopeUpgradeAction } from "@/app/(app)/settings/profile/google-calendar-actions";

const mockCtx = (over: { connEnabled?: boolean; outboundEnabled?: boolean; active?: boolean } = {}) => {
  vi.mocked(getCurrentPractitionerWithStudio).mockResolvedValue({
    practitioner: { id: "p1", user_id: "u1", active: over.active ?? true, role: "owner" },
    studio: {
      id: "s1",
      google_calendar_connection_enabled: over.connEnabled ?? true,
      google_calendar_outbound_sync_enabled: over.outboundEnabled ?? false,
    },
  } as unknown as Awaited<ReturnType<typeof getCurrentPractitionerWithStudio>>);
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createOAuthState).mockResolvedValue({ ok: true, state: "st", nonce: "no", codeChallenge: "cc" });
  vi.mocked(getOwnConnectionMetadata).mockResolvedValue({ connectionStatus: "connected", googleAccountEmail: "sam@example.com" } as unknown as Awaited<ReturnType<typeof getOwnConnectionMetadata>>);
});
afterEach(() => vi.restoreAllMocks());

describe("startGoogleCalendarEventScopeUpgradeAction", () => {
  it("requests ONLY calendar.events, prompt=consent, and sets a SameSite=Lax nonce cookie", async () => {
    mockCtx();
    const r = await startGoogleCalendarEventScopeUpgradeAction();
    expect(r.ok).toBe(true);
    const args = vi.mocked(buildAuthorizationUrl).mock.calls[0][0];
    expect(args.scopes).toEqual([EVENT_WRITE_SCOPE]);
    expect(args.forceConsent).toBe(true);
    expect(jar.set).toHaveBeenCalledWith(expect.objectContaining({ sameSite: "lax", httpOnly: true }));
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
  });

  it("rejects when there is no existing connection to upgrade", async () => {
    mockCtx();
    vi.mocked(getOwnConnectionMetadata).mockResolvedValue(null);
    const r = await startGoogleCalendarEventScopeUpgradeAction();
    expect(r.ok).toBe(false);
    expect(buildAuthorizationUrl).not.toHaveBeenCalled();
  });
});

describe("callback route — source pins for the B2.2 guards", () => {
  const src = readFileSync(
    join(process.cwd(), "app/api/google-calendar/oauth/callback/route.ts"),
    "utf8",
  );
  it("rejects account switching (identity mismatch => account_mismatch, no overwrite)", () => {
    expect(src).toMatch(/getConnectionAccountId/);
    expect(src).toMatch(/existingAccountId !== null && existingAccountId !== info\.sub/);
    expect(src).toMatch(/"account_mismatch"/);
  });
  it("verifies granted scopes with token-response primary + tokeninfo fallback", () => {
    expect(src).toMatch(/grantedScopes = token\.grantedScopes/);
    expect(src).toMatch(/grantedScopes\.length === 0[\s\S]{0,120}fetchTokenInfoScopes/);
  });
  it("derives the event-scope banners and never resets the write calendar on re-auth", () => {
    expect(src).toMatch(/grantedScopes\.includes\(EVENT_WRITE_SCOPE\)/);
    expect(src).toMatch(/event_scope_granted|event_scope_not_granted/);
    expect(src).toMatch(/existing\?\.writeCalendarId/);
  });
  it("does not enqueue, sync, or write a Google event", () => {
    expect(src).not.toMatch(/calendar_sync_outbox|calendar_event_links|events\.(insert|patch|delete)/);
  });
});

describe("settings card — readiness-driven UX source pins", () => {
  const src = readFileSync(
    join(process.cwd(), "app/(app)/settings/profile/GoogleCalendarCard.tsx"),
    "utf8",
  );
  it("consumes derived readiness and shows the upgrade CTA + ready + dormant messaging", () => {
    expect(src).toMatch(/readiness: ConnectionReadiness/);
    expect(src).toMatch(/Grant calendar event access/);
    expect(src).toMatch(/scope_upgrade_required/);
    expect(src).toMatch(/outbound_scope_ready/);
    expect(src).toMatch(/Event synchronization is still disabled/);
    expect(src).toMatch(/startGoogleCalendarEventScopeUpgradeAction/);
  });
  it("never renders a token/scope-consent secret or claims sync is active", () => {
    expect(src).not.toMatch(/accessToken|refresh_token|codeVerifier/);
    expect(src).not.toMatch(/synchronization is active|sync is on|syncing/i);
  });
});
