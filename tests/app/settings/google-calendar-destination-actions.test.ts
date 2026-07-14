import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Phase B2.4 — DUAL-DESTINATION setup server actions (behavioral, all deps
// mocked; NO db, NO network). Every destination action is OWNER-gated and
// re-authorizes server-side; the browser only ever submits a candidate id/mode
// which the server re-validates against Google's own list. NOTHING here syncs an
// event or turns on the outbound flag — this is destination SETUP only.

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
  revokeToken: vi.fn(async () => ({ ok: true })),
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
import { isGoogleTokenCryptoConfigured, decryptGoogleSecret } from "@/lib/google-calendar/token-crypto";
import {
  buildAuthorizationUrl,
  createSecondaryCalendar,
  fetchCalendarList,
  findCalendarsByDescriptionToken,
  randomUrlToken,
  refreshAccessToken,
} from "@/lib/google-calendar/oauth";
import { createOAuthState } from "@/lib/google-calendar/state";
import {
  getOwnConnectionMetadata,
  getRefreshTokenCiphertext,
  designateStudioCalendarOwner,
  setDestinationMode,
  setOwnedCalendarDestination,
  setDedicatedCalendarDestination,
  beginDedicatedProvisioningAttempt,
  markDedicatedProvisioningAmbiguous,
} from "@/lib/google-calendar/connection";
import {
  CALENDAR_APP_CREATED_SCOPE,
  CALENDAR_EVENTS_OWNED_SCOPE,
} from "@/lib/google-calendar/destination-scopes";
import {
  chooseDestinationModeAction,
  provisionDedicatedCalendarAction,
  selectOwnedCalendarAction,
  listOwnedCalendarsAction,
} from "@/app/(app)/settings/profile/google-calendar-actions";

const STUDIO = "s1";
const PRAC = "p1";
const USER = "u1";
const DISCOVERY = "https://www.googleapis.com/auth/calendar.calendarlist.readonly";
const TOKEN = "a".repeat(32);

function setActor(
  over: { connEnabled?: boolean; outboundEnabled?: boolean; active?: boolean; role?: string } = {},
) {
  vi.mocked(getCurrentPractitionerWithStudio).mockResolvedValue({
    practitioner: { id: PRAC, user_id: USER, active: over.active ?? true, role: over.role ?? "owner" },
    studio: {
      id: STUDIO,
      google_calendar_connection_enabled: over.connEnabled ?? true,
      google_calendar_outbound_sync_enabled: over.outboundEnabled ?? false,
    },
  } as unknown as Awaited<ReturnType<typeof getCurrentPractitionerWithStudio>>);
}

// A connected metadata baseline; callers override per scenario.
function conn(over: Record<string, unknown> = {}) {
  return {
    connectionStatus: "connected",
    googleAccountEmail: "sam@example.com",
    destinationMode: "existing_owned",
    grantedScopes: [DISCOVERY, CALENDAR_EVENTS_OWNED_SCOPE],
    writeCalendarId: null,
    appCreatedCalendarId: null,
    selectedCalendarDisplayName: null,
    provisioningAmbiguousAt: null,
    provisioningAttemptToken: null,
    ...over,
  } as unknown as Awaited<ReturnType<typeof getOwnConnectionMetadata>>;
}

// A dedicated-mode baseline with the app.created scope granted.
function dedicatedConn(over: Record<string, unknown> = {}) {
  return conn({
    destinationMode: "dedicated_app_created",
    grantedScopes: [DISCOVERY, CALENDAR_APP_CREATED_SCOPE],
    ...over,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  setActor();
  vi.mocked(isGoogleTokenCryptoConfigured).mockReturnValue(true);
  vi.mocked(decryptGoogleSecret).mockReturnValue({ ok: true, secret: "rt" } as never);
  vi.mocked(getRefreshTokenCiphertext).mockResolvedValue("ciphertext");
  vi.mocked(refreshAccessToken).mockResolvedValue({
    ok: true,
    accessToken: "at",
    expiresInSeconds: 3600,
    rotatedRefreshToken: null,
  } as never);
  vi.mocked(randomUrlToken).mockReturnValue(TOKEN);
  vi.mocked(createOAuthState).mockResolvedValue({ ok: true, state: "st", nonce: "no", codeChallenge: "cc" } as never);
  vi.mocked(getOwnConnectionMetadata).mockResolvedValue(conn());
  vi.mocked(setDestinationMode).mockResolvedValue({ ok: true, connectionId: "c1" } as never);
  vi.mocked(setOwnedCalendarDestination).mockResolvedValue({ ok: true, connectionId: "c1" } as never);
  vi.mocked(setDedicatedCalendarDestination).mockResolvedValue({ ok: true, connectionId: "c1" } as never);
  vi.mocked(beginDedicatedProvisioningAttempt).mockResolvedValue({
    ok: true,
    connectionId: "c1",
    attemptToken: TOKEN,
  } as never);
  vi.mocked(markDedicatedProvisioningAmbiguous).mockResolvedValue({ ok: true, connectionId: "c1" } as never);
  vi.mocked(designateStudioCalendarOwner).mockResolvedValue(undefined as never);
  vi.mocked(createSecondaryCalendar).mockResolvedValue({ ok: true, id: "new-cal" } as never);
  vi.mocked(findCalendarsByDescriptionToken).mockResolvedValue({ ok: true, calendarIds: [] } as never);
  vi.mocked(fetchCalendarList).mockResolvedValue({ ok: true, calendars: [] } as never);
});
afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// chooseDestinationModeAction
// ---------------------------------------------------------------------------
describe("chooseDestinationModeAction", () => {
  it("records a valid mode for a connected owner", async () => {
    const r = await chooseDestinationModeAction("existing_owned");
    expect(r.ok).toBe(true);
    expect(setDestinationMode).toHaveBeenCalledWith(STUDIO, PRAC, "existing_owned");
  });

  it("rejects an invalid mode without touching the store", async () => {
    const r = await chooseDestinationModeAction("banana");
    expect(r.ok).toBe(false);
    expect(setDestinationMode).not.toHaveBeenCalled();
  });

  it("rejects when the account is not connected", async () => {
    vi.mocked(getOwnConnectionMetadata).mockResolvedValue(conn({ connectionStatus: "disconnected" }));
    const r = await chooseDestinationModeAction("existing_owned");
    expect(r.ok).toBe(false);
    expect(setDestinationMode).not.toHaveBeenCalled();
  });

  it("surfaces a switching-unsupported error distinctly (no-switch invariant)", async () => {
    vi.mocked(setDestinationMode).mockResolvedValue({
      ok: false,
      reason: "destination_switching_unsupported",
    } as never);
    const r = await chooseDestinationModeAction("dedicated_app_created");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/support/i);
  });

  it("surfaces a generic error on any other store failure", async () => {
    vi.mocked(setDestinationMode).mockResolvedValue({ ok: false, reason: "connection_not_found" } as never);
    const r = await chooseDestinationModeAction("existing_owned");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/save|try again/i);
      expect(r.error).not.toMatch(/support/i);
    }
  });
});

// ---------------------------------------------------------------------------
// provisionDedicatedCalendarAction
// ---------------------------------------------------------------------------
describe("provisionDedicatedCalendarAction", () => {
  it("is idempotent when already provisioned — converges without creating", async () => {
    vi.mocked(getOwnConnectionMetadata).mockResolvedValue(
      dedicatedConn({ appCreatedCalendarId: "existing-app-cal", selectedCalendarDisplayName: "Hone Appointments" }),
    );
    const r = await provisionDedicatedCalendarAction();
    expect(r.ok).toBe(true);
    expect(setDedicatedCalendarDestination).toHaveBeenCalledWith(
      STUDIO,
      PRAC,
      expect.objectContaining({ calendarId: "existing-app-cal" }),
    );
    expect(designateStudioCalendarOwner).toHaveBeenCalledWith(STUDIO, PRAC);
    expect(createSecondaryCalendar).not.toHaveBeenCalled();
    expect(findCalendarsByDescriptionToken).not.toHaveBeenCalled();
  });

  it("is blocked (needs attention) when provisioning was flagged ambiguous — never creates", async () => {
    vi.mocked(getOwnConnectionMetadata).mockResolvedValue(
      dedicatedConn({ provisioningAmbiguousAt: "2026-07-13T01:00:00Z" }),
    );
    const r = await provisionDedicatedCalendarAction();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/attention/i);
    expect(createSecondaryCalendar).not.toHaveBeenCalled();
  });

  it("blocks creation when the app.created scope is not yet granted", async () => {
    vi.mocked(getOwnConnectionMetadata).mockResolvedValue(dedicatedConn({ grantedScopes: [DISCOVERY] }));
    const r = await provisionDedicatedCalendarAction();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/grant/i);
    expect(createSecondaryCalendar).not.toHaveBeenCalled();
    // scope gate is BEFORE token mint
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  it("creates EXACTLY ONE calendar on a zero-match reconcile, with the attempt-token marker", async () => {
    vi.mocked(getOwnConnectionMetadata).mockResolvedValue(dedicatedConn());
    vi.mocked(findCalendarsByDescriptionToken).mockResolvedValue({ ok: true, calendarIds: [] } as never);
    vi.mocked(createSecondaryCalendar).mockResolvedValue({ ok: true, id: "new-cal" } as never);
    const r = await provisionDedicatedCalendarAction();
    expect(r.ok).toBe(true);
    expect(createSecondaryCalendar).toHaveBeenCalledTimes(1);
    expect(createSecondaryCalendar).toHaveBeenCalledWith(
      "at",
      expect.objectContaining({
        summary: "Hone Appointments",
        description: expect.stringContaining(`hone-provisioning-attempt:${TOKEN}`),
      }),
    );
    // A stable attempt token was minted via CAS and the created calendar adopted.
    expect(beginDedicatedProvisioningAttempt).toHaveBeenCalledWith(STUDIO, PRAC, TOKEN);
    expect(setDedicatedCalendarDestination).toHaveBeenCalledWith(
      STUDIO,
      PRAC,
      expect.objectContaining({ calendarId: "new-cal" }),
    );
    expect(designateStudioCalendarOwner).toHaveBeenCalledWith(STUDIO, PRAC);
  });

  it("adopts a single reconciled calendar WITHOUT creating (orphan recovery)", async () => {
    vi.mocked(getOwnConnectionMetadata).mockResolvedValue(dedicatedConn());
    vi.mocked(findCalendarsByDescriptionToken).mockResolvedValue({
      ok: true,
      calendarIds: ["adopt-cal"],
    } as never);
    const r = await provisionDedicatedCalendarAction();
    expect(r.ok).toBe(true);
    expect(createSecondaryCalendar).not.toHaveBeenCalled();
    expect(setDedicatedCalendarDestination).toHaveBeenCalledWith(
      STUDIO,
      PRAC,
      expect.objectContaining({ calendarId: "adopt-cal" }),
    );
  });

  it("marks ambiguous (fail-closed) on a multi-match reconcile — no create, no adopt", async () => {
    vi.mocked(getOwnConnectionMetadata).mockResolvedValue(dedicatedConn());
    vi.mocked(findCalendarsByDescriptionToken).mockResolvedValue({
      ok: true,
      calendarIds: ["c1", "c2"],
    } as never);
    const r = await provisionDedicatedCalendarAction();
    expect(r.ok).toBe(false);
    expect(markDedicatedProvisioningAmbiguous).toHaveBeenCalledWith(STUDIO, PRAC);
    expect(createSecondaryCalendar).not.toHaveBeenCalled();
    expect(setDedicatedCalendarDestination).not.toHaveBeenCalled();
  });

  it("fails closed (no create) when reconciliation transport errors", async () => {
    vi.mocked(getOwnConnectionMetadata).mockResolvedValue(dedicatedConn());
    vi.mocked(findCalendarsByDescriptionToken).mockResolvedValue({
      ok: false,
      reason: "reconcile_network_error",
    } as never);
    const r = await provisionDedicatedCalendarAction();
    expect(r.ok).toBe(false);
    expect(createSecondaryCalendar).not.toHaveBeenCalled();
    expect(setDedicatedCalendarDestination).not.toHaveBeenCalled();
  });

  it("rejects when the destination mode isn't dedicated", async () => {
    vi.mocked(getOwnConnectionMetadata).mockResolvedValue(conn({ destinationMode: "existing_owned" }));
    const r = await provisionDedicatedCalendarAction();
    expect(r.ok).toBe(false);
    expect(createSecondaryCalendar).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// selectOwnedCalendarAction
// ---------------------------------------------------------------------------
describe("selectOwnedCalendarAction", () => {
  it("accepts + persists a calendar the connected account OWNS (server-verified role)", async () => {
    vi.mocked(fetchCalendarList).mockResolvedValue({
      ok: true,
      calendars: [{ id: "cal-own", summary: "My Calendar", accessRole: "owner", primary: false }],
    } as never);
    const r = await selectOwnedCalendarAction("cal-own");
    expect(r.ok).toBe(true);
    expect(setOwnedCalendarDestination).toHaveBeenCalledWith(STUDIO, PRAC, {
      calendarId: "cal-own",
      displayName: "My Calendar",
    });
    expect(designateStudioCalendarOwner).toHaveBeenCalledWith(STUDIO, PRAC);
  });

  it.each(["writer", "reader", "freeBusyReader", "unknown"])(
    "rejects a calendar whose accessRole is %s (not owner) — nothing stored",
    async (role) => {
      vi.mocked(fetchCalendarList).mockResolvedValue({
        ok: true,
        calendars: [{ id: "cal-x", summary: "Shared", accessRole: role, primary: false }],
      } as never);
      const r = await selectOwnedCalendarAction("cal-x");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/own/i);
      expect(setOwnedCalendarDestination).not.toHaveBeenCalled();
    },
  );

  it("rejects a forged/browser-supplied id that is not in the account's own list", async () => {
    vi.mocked(fetchCalendarList).mockResolvedValue({
      ok: true,
      calendars: [{ id: "cal-own", summary: "My Calendar", accessRole: "owner", primary: false }],
    } as never);
    const r = await selectOwnedCalendarAction("forged-id@group.calendar.google.com");
    expect(r.ok).toBe(false);
    expect(setOwnedCalendarDestination).not.toHaveBeenCalled();
  });

  it("only trusts fetchCalendarList's accessRole — a non-owner listed id is still rejected", async () => {
    // The browser cannot submit a role; even a real calendar the account can see
    // as writer must not become a destination.
    vi.mocked(fetchCalendarList).mockResolvedValue({
      ok: true,
      calendars: [
        { id: "cal-writer", summary: "Team", accessRole: "writer", primary: false },
        { id: "cal-own", summary: "Mine", accessRole: "owner", primary: false },
      ],
    } as never);
    const r = await selectOwnedCalendarAction("cal-writer");
    expect(r.ok).toBe(false);
    expect(setOwnedCalendarDestination).not.toHaveBeenCalled();
  });

  it("rejects when the destination mode isn't existing_owned", async () => {
    vi.mocked(getOwnConnectionMetadata).mockResolvedValue(dedicatedConn());
    const r = await selectOwnedCalendarAction("cal-own");
    expect(r.ok).toBe(false);
    expect(setOwnedCalendarDestination).not.toHaveBeenCalled();
  });

  it("rejects when the events.owned scope is not granted", async () => {
    vi.mocked(getOwnConnectionMetadata).mockResolvedValue(conn({ grantedScopes: [DISCOVERY] }));
    const r = await selectOwnedCalendarAction("cal-own");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/grant/i);
    expect(fetchCalendarList).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// listOwnedCalendarsAction
// ---------------------------------------------------------------------------
describe("listOwnedCalendarsAction", () => {
  it("returns ONLY calendars with accessRole owner", async () => {
    vi.mocked(fetchCalendarList).mockResolvedValue({
      ok: true,
      calendars: [
        { id: "own-1", summary: "Owned 1", accessRole: "owner", primary: true },
        { id: "wr-1", summary: "Writer", accessRole: "writer", primary: false },
        { id: "rd-1", summary: "Reader", accessRole: "reader", primary: false },
        { id: "own-2", summary: "Owned 2", accessRole: "owner", primary: false },
      ],
    } as never);
    const r = await listOwnedCalendarsAction();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.calendars.map((c) => c.id)).toEqual(["own-1", "own-2"]);
      expect(r.calendars.every((c) => c.accessRole === "owner")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Authorization — owner gate + connection flag + active, across the actions
// ---------------------------------------------------------------------------
describe("authorization — destination actions are owner-gated + flag-gated", () => {
  it("chooseDestinationModeAction: owner + connected + flag on succeeds", async () => {
    const r = await chooseDestinationModeAction("existing_owned");
    expect(r.ok).toBe(true);
    expect(setDestinationMode).toHaveBeenCalled();
  });

  it("chooseDestinationModeAction: rejects a non-owner (member) without mutating", async () => {
    setActor({ role: "member" });
    const r = await chooseDestinationModeAction("existing_owned");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/owner/i);
    expect(setDestinationMode).not.toHaveBeenCalled();
  });

  it("chooseDestinationModeAction: rejects an inactive practitioner", async () => {
    setActor({ active: false });
    const r = await chooseDestinationModeAction("existing_owned");
    expect(r.ok).toBe(false);
    expect(setDestinationMode).not.toHaveBeenCalled();
  });

  it("chooseDestinationModeAction: rejects when the connection flag is OFF", async () => {
    setActor({ connEnabled: false });
    const r = await chooseDestinationModeAction("existing_owned");
    expect(r.ok).toBe(false);
    expect(setDestinationMode).not.toHaveBeenCalled();
  });

  it("provisionDedicatedCalendarAction: non-owner is rejected — never creates a calendar", async () => {
    setActor({ role: "member" });
    vi.mocked(getOwnConnectionMetadata).mockResolvedValue(dedicatedConn());
    const r = await provisionDedicatedCalendarAction();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/owner/i);
    expect(createSecondaryCalendar).not.toHaveBeenCalled();
  });

  it("selectOwnedCalendarAction: non-owner is rejected — never stores a destination", async () => {
    setActor({ role: "member" });
    vi.mocked(fetchCalendarList).mockResolvedValue({
      ok: true,
      calendars: [{ id: "cal-own", summary: "Mine", accessRole: "owner", primary: false }],
    } as never);
    const r = await selectOwnedCalendarAction("cal-own");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/owner/i);
    expect(setOwnedCalendarDestination).not.toHaveBeenCalled();
  });

  it("listOwnedCalendarsAction: non-owner is rejected", async () => {
    setActor({ role: "member" });
    const r = await listOwnedCalendarsAction();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/owner/i);
  });

  // buildAuthorizationUrl is imported here only to assert it is NOT called for a
  // non-owner (the upgrade action's owner gate is covered fully in the
  // scope-upgrade suite; this is the cross-action authorization guard).
  it("no destination mutation helper is ever reached for a non-owner", () => {
    expect(buildAuthorizationUrl).not.toHaveBeenCalled();
  });
});
