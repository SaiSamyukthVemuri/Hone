import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PHASE_A_SCOPES, PHASE_B_ADDITIONAL_SCOPES } from "@/lib/google-calendar/config";
import {
  CALENDAR_APP_CREATED_SCOPE,
  CALENDAR_EVENTS_OWNED_SCOPE,
} from "@/lib/google-calendar/destination-scopes";
import { buildAuthorizationUrl, fetchTokenInfoScopes } from "@/lib/google-calendar/oauth";

// Phase B2.4: the DESTINATION scope-upgrade authorization URL + the granted-scope
// tokeninfo fallback. Broad calendar.events is fully retired: only the exact
// destination scopes (calendar.app.created / calendar.events.owned) are ever
// requested.
const EVENTS_BROAD = "https://www.googleapis.com/auth/calendar.events";

const saved = {
  cid: process.env.GOOGLE_OAUTH_CLIENT_ID,
  csec: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  origin: process.env.NEXT_PUBLIC_APP_ORIGIN,
};
beforeEach(() => {
  process.env.GOOGLE_OAUTH_CLIENT_ID = "cid.apps.googleusercontent.com";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "sec";
  process.env.NEXT_PUBLIC_APP_ORIGIN = "https://hone.care";
});
afterEach(() => {
  process.env.GOOGLE_OAUTH_CLIENT_ID = saved.cid;
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = saved.csec;
  process.env.NEXT_PUBLIC_APP_ORIGIN = saved.origin;
  vi.restoreAllMocks();
});

function upgradeUrl(scope: string): URL {
  const raw = buildAuthorizationUrl({
    state: "st",
    codeChallenge: "cc",
    forceConsent: true,
    scopes: [scope],
  });
  expect(raw).not.toBeNull();
  return new URL(raw as string);
}

describe("destination scope-upgrade authorization URL", () => {
  it("dedicated: requests ONLY calendar.app.created (no broad calendar / events / readonly)", () => {
    const scope = upgradeUrl(CALENDAR_APP_CREATED_SCOPE).searchParams.get("scope");
    expect(scope).toBe(CALENDAR_APP_CREATED_SCOPE);
    expect(scope).not.toContain(EVENTS_BROAD);
    expect(scope).not.toContain("calendar.readonly");
    expect(scope).not.toMatch(/auth\/calendar($|\s)/); // no broad full-calendar scope
  });
  it("existing-owned: requests ONLY calendar.events.owned (and NOT broad calendar.events)", () => {
    const scope = upgradeUrl(CALENDAR_EVENTS_OWNED_SCOPE).searchParams.get("scope") ?? "";
    expect(scope).toBe(CALENDAR_EVENTS_OWNED_SCOPE);
    // The exact-match: the broad prefix scope must NOT be requested on its own.
    expect(scope.split(" ")).not.toContain(EVENTS_BROAD);
  });
  it("preserves the Phase-A grant via include_granted_scopes=true + offline + prompt=consent", () => {
    const u = upgradeUrl(CALENDAR_APP_CREATED_SCOPE);
    expect(u.searchParams.get("include_granted_scopes")).toBe("true");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
  });
  it("the documented Phase-B scopes are the destination scopes, NOT broad calendar.events", () => {
    expect(PHASE_B_ADDITIONAL_SCOPES).toContain(CALENDAR_APP_CREATED_SCOPE);
    expect(PHASE_B_ADDITIONAL_SCOPES).toContain(CALENDAR_EVENTS_OWNED_SCOPE);
    expect(PHASE_B_ADDITIONAL_SCOPES as readonly string[]).not.toContain(EVENTS_BROAD);
  });
  it("the default connect URL still requests only the Phase-A scopes (no event scope)", () => {
    const raw = buildAuthorizationUrl({ state: "s", codeChallenge: "c", forceConsent: false });
    const scope = new URL(raw as string).searchParams.get("scope") ?? "";
    expect(scope).toBe(PHASE_A_SCOPES.join(" "));
    expect(scope).not.toContain(EVENTS_BROAD);
    expect(scope).not.toContain(CALENDAR_APP_CREATED_SCOPE);
    expect(scope).not.toContain(CALENDAR_EVENTS_OWNED_SCOPE);
  });
});

describe("fetchTokenInfoScopes (fallback only)", () => {
  it("parses the scope field from tokeninfo", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ scope: `${PHASE_A_SCOPES[2]} ${CALENDAR_EVENTS_OWNED_SCOPE}` }), { status: 200 }),
    );
    const r = await fetchTokenInfoScopes("at");
    expect(r.ok && r.scopes).toContain(CALENDAR_EVENTS_OWNED_SCOPE);
  });
  it("returns ok:false on an http error (caller keeps the primary result)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 400 }));
    const r = await fetchTokenInfoScopes("at");
    expect(r.ok).toBe(false);
  });
  it("never throws on a network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("boom"));
    const r = await fetchTokenInfoScopes("at");
    expect(r.ok).toBe(false);
  });
});
