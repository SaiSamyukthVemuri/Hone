import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Google Calendar — Phase A. Behavioral tests of the connect/disconnect/select/
// designate server actions (flag gate, state minting, nonce cookie, calendar
// validation), plus source pins for the callback route + UI dormant messaging.

// --- Mocks (controllable per test) ---
const jar = { set: vi.fn(), get: vi.fn(), delete: vi.fn() };
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => jar) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/queries", () => ({ getCurrentPractitionerWithStudio: vi.fn() }));
vi.mock("@/lib/google-calendar/state", () => ({ createOAuthState: vi.fn() }));
vi.mock("@/lib/google-calendar/token-crypto", () => ({
  isGoogleTokenCryptoConfigured: vi.fn(() => true),
  decryptGoogleSecret: vi.fn(() => ({ ok: true, secret: "refresh-token" })),
}));
vi.mock("@/lib/google-calendar/config", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/google-calendar/config")>();
  return { ...actual, getGoogleOAuthClient: vi.fn(() => ({ clientId: "cid", clientSecret: "sec" })) };
});
vi.mock("@/lib/google-calendar/oauth", () => ({
  buildAuthorizationUrl: vi.fn(() => "https://accounts.google.com/o/oauth2/v2/auth?state=x"),
  refreshAccessToken: vi.fn(async () => ({ ok: true, accessToken: "at", expiresInSeconds: 3600, rotatedRefreshToken: null })),
  fetchCalendarList: vi.fn(async () => ({
    ok: true,
    calendars: [{ id: "primary", summary: "Primary", accessRole: "owner", primary: true }],
  })),
  revokeToken: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/google-calendar/connection", () => ({
  getOwnConnectionMetadata: vi.fn(async () => null),
  getRefreshTokenCiphertext: vi.fn(async () => "v1:1:iv:tag:ct"),
  disconnectConnection: vi.fn(async () => {}),
  markReconnectRequired: vi.fn(async () => {}),
  setWriteCalendar: vi.fn(async () => {}),
  designateStudioCalendarOwner: vi.fn(async () => {}),
}));

import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { isGoogleTokenCryptoConfigured } from "@/lib/google-calendar/token-crypto";
import { buildAuthorizationUrl, revokeToken } from "@/lib/google-calendar/oauth";
import { createOAuthState } from "@/lib/google-calendar/state";
import {
  getOwnConnectionMetadata,
  disconnectConnection,
  setWriteCalendar,
  designateStudioCalendarOwner,
} from "@/lib/google-calendar/connection";
import {
  startGoogleCalendarConnectAction,
  disconnectGoogleCalendarAction,
  selectWriteCalendarAction,
  designateSelfAsCalendarOwnerAction,
} from "@/app/(app)/settings/profile/google-calendar-actions";

const STUDIO = "11111111-1111-1111-1111-111111111111";
const PRAC = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";

function setActor(over: { flag?: boolean; active?: boolean; role?: string } = {}) {
  vi.mocked(getCurrentPractitionerWithStudio).mockResolvedValue({
    practitioner: {
      id: PRAC,
      user_id: USER,
      active: over.active ?? true,
      role: over.role ?? "owner",
      email: "prac@example.com",
    },
    studio: { id: STUDIO, google_calendar_connection_enabled: over.flag ?? true },
  } as never);
}

beforeEach(() => {
  setActor();
  vi.mocked(createOAuthState).mockResolvedValue({
    ok: true,
    state: "STATE",
    nonce: "NONCE",
    codeChallenge: "CHALLENGE",
  } as never);
  vi.mocked(isGoogleTokenCryptoConfigured).mockReturnValue(true);
  vi.mocked(getOwnConnectionMetadata).mockResolvedValue(null);
});
afterEach(() => vi.clearAllMocks());

describe("startGoogleCalendarConnectAction — flag gate + state + nonce cookie", () => {
  it("rejects when the studio connection flag is OFF (server-side, not just UI)", async () => {
    setActor({ flag: false });
    const r = await startGoogleCalendarConnectAction();
    expect(r.ok).toBe(false);
    expect(createOAuthState).not.toHaveBeenCalled();
  });

  it("rejects an inactive practitioner", async () => {
    setActor({ active: false });
    const r = await startGoogleCalendarConnectAction();
    expect(r.ok).toBe(false);
  });

  it("fails closed when crypto/OAuth is not configured", async () => {
    vi.mocked(isGoogleTokenCryptoConfigured).mockReturnValue(false);
    const r = await startGoogleCalendarConnectAction();
    expect(r.ok).toBe(false);
    expect(createOAuthState).not.toHaveBeenCalled();
  });

  it("mints state bound to studio+practitioner+user and returns the auth URL", async () => {
    const r = await startGoogleCalendarConnectAction();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toMatch(/^https:\/\/accounts\.google\.com/);
    expect(createOAuthState).toHaveBeenCalledWith(
      expect.objectContaining({ studioId: STUDIO, practitionerId: PRAC, userId: USER }),
    );
  });

  it("sets the nonce cookie httpOnly + SameSite=Lax (NOT Strict)", async () => {
    await startGoogleCalendarConnectAction();
    expect(jar.set).toHaveBeenCalledTimes(1);
    const arg = jar.set.mock.calls[0][0];
    expect(arg.httpOnly).toBe(true);
    expect(arg.sameSite).toBe("lax");
    expect(arg.sameSite).not.toBe("strict");
    expect(arg.value).toBe("NONCE");
  });

  it("forces consent on a first connection (no existing connection)", async () => {
    await startGoogleCalendarConnectAction();
    expect(buildAuthorizationUrl).toHaveBeenCalledWith(
      expect.objectContaining({ forceConsent: true }),
    );
  });

  it("does NOT force consent on a healthy reconnect", async () => {
    vi.mocked(getOwnConnectionMetadata).mockResolvedValue({
      connectionStatus: "connected",
      googleAccountEmail: "g@example.com",
    } as never);
    await startGoogleCalendarConnectAction();
    expect(buildAuthorizationUrl).toHaveBeenCalledWith(
      expect.objectContaining({ forceConsent: false }),
    );
  });
});

describe("disconnectGoogleCalendarAction — revoke then destroy", () => {
  it("revokes at Google then clears local connection state", async () => {
    const r = await disconnectGoogleCalendarAction();
    expect(r.ok).toBe(true);
    expect(revokeToken).toHaveBeenCalledWith("refresh-token");
    expect(disconnectConnection).toHaveBeenCalledWith(STUDIO, PRAC);
  });

  it("is rejected when the flag is OFF", async () => {
    setActor({ flag: false });
    const r = await disconnectGoogleCalendarAction();
    expect(r.ok).toBe(false);
    expect(disconnectConnection).not.toHaveBeenCalled();
  });
});

describe("selectWriteCalendarAction — validate against Google's own list", () => {
  it("rejects an arbitrary/browser-supplied calendar id not in the account's list", async () => {
    const fd = new FormData();
    fd.set("calendar_id", "attacker-controlled@group.calendar.google.com");
    const r = await selectWriteCalendarAction(fd);
    expect(r.ok).toBe(false);
    expect(setWriteCalendar).not.toHaveBeenCalled();
  });

  it("stores a calendar id that IS in the connection's Google list", async () => {
    const fd = new FormData();
    fd.set("calendar_id", "primary");
    const r = await selectWriteCalendarAction(fd);
    expect(r.ok).toBe(true);
    expect(setWriteCalendar).toHaveBeenCalledWith(STUDIO, PRAC, "primary");
  });
});

describe("designateSelfAsCalendarOwnerAction — owner-only", () => {
  it("rejects a non-owner", async () => {
    setActor({ role: "practitioner" });
    const r = await designateSelfAsCalendarOwnerAction();
    expect(r.ok).toBe(false);
    expect(designateStudioCalendarOwner).not.toHaveBeenCalled();
  });

  it("requires a connected account", async () => {
    vi.mocked(getOwnConnectionMetadata).mockResolvedValue({ connectionStatus: "disconnected" } as never);
    const r = await designateSelfAsCalendarOwnerAction();
    expect(r.ok).toBe(false);
  });

  it("designates the owner's connection when connected", async () => {
    vi.mocked(getOwnConnectionMetadata).mockResolvedValue({ connectionStatus: "connected" } as never);
    const r = await designateSelfAsCalendarOwnerAction();
    expect(r.ok).toBe(true);
    expect(designateStudioCalendarOwner).toHaveBeenCalledWith(STUDIO, PRAC);
  });
});

// ---------------------------------------------------------------------------
// Source pins — the callback route + UI invariants the Vitest node env can't
// exercise directly.
// ---------------------------------------------------------------------------
const ROOT = process.cwd();
const CALLBACK = readFileSync(
  join(ROOT, "app/api/google-calendar/oauth/callback/route.ts"),
  "utf8",
);
const CARD = readFileSync(join(ROOT, "app/(app)/settings/profile/GoogleCalendarCard.tsx"), "utf8");
const PAGE = readFileSync(join(ROOT, "app/(app)/settings/profile/page.tsx"), "utf8");

describe("callback route — validation order + safety (source)", () => {
  it("runs on the Node runtime, force-dynamic", () => {
    expect(CALLBACK).toMatch(/export const runtime = "nodejs"/);
    expect(CALLBACK).toMatch(/export const dynamic = "force-dynamic"/);
  });

  it("requires an authenticated user, consumes the single-use state, and re-checks the practitioner", () => {
    expect(CALLBACK).toMatch(/auth\.getUser\(\)/);
    expect(CALLBACK).toMatch(/consumeOAuthState\(\{ state, nonce, userId: user\.id \}\)/);
    // Re-assert the practitioner is active AND belongs to the bound studio + user.
    expect(CALLBACK).toMatch(/\.eq\("studio_id", consumed\.studioId\)/);
    expect(CALLBACK).toMatch(/\.eq\("user_id", user\.id\)/);
    expect(CALLBACK).toMatch(/prac\.active !== true/);
  });

  it("never stores a plaintext token and clears the nonce cookie on exit", () => {
    expect(CALLBACK).toMatch(/encryptGoogleSecret\(token\.refreshToken\)/);
    expect(CALLBACK).toMatch(/never store plaintext/);
    expect(CALLBACK).toMatch(/OAUTH_NONCE_COOKIE, value: "", path: "\/", maxAge: 0/);
  });

  it("redirects to a fixed status path, never an arbitrary request-supplied redirect", () => {
    expect(CALLBACK).not.toMatch(/searchParams\.get\("next"\)/);
    expect(CALLBACK).not.toMatch(/searchParams\.get\("redirect"\)/);
  });
});

describe("GoogleCalendarCard — dormant messaging + iCal distinction (source)", () => {
  it("states event sync is still disabled while dormant (B2.2 wording)", () => {
    expect(CARD).toMatch(/Event synchronization is still disabled/i);
  });

  it("distinguishes itself from the one-way read-only iCal feed", () => {
    expect(CARD).toMatch(/one-way subscription that never imports events/i);
  });

  it("only requests identity + calendar list on first connect (onboarding copy)", () => {
    expect(CARD).toMatch(/No event read or write access is requested when you/i);
  });
});

describe("profile page — card gated on the studio flag (source)", () => {
  it("renders the Google card ONLY when google_calendar_connection_enabled is true", () => {
    expect(PAGE).toMatch(/google_calendar_connection_enabled === true/);
    expect(PAGE).toMatch(/\{googleEnabled && \(\s*\n?\s*<GoogleCalendarCard/);
  });
});
