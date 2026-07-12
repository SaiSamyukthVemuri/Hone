import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EVENT_WRITE_SCOPE,
  PHASE_A_SCOPES,
  PHASE_B_ADDITIONAL_SCOPES,
} from "@/lib/google-calendar/config";
import { buildAuthorizationUrl, fetchTokenInfoScopes } from "@/lib/google-calendar/oauth";

// Phase B2.2 — the incremental event-scope upgrade authorization URL + the
// granted-scope tokeninfo fallback.

const saved = { cid: process.env.GOOGLE_OAUTH_CLIENT_ID, csec: process.env.GOOGLE_OAUTH_CLIENT_SECRET, origin: process.env.NEXT_PUBLIC_APP_ORIGIN };
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

describe("event-scope upgrade authorization URL", () => {
  function upgradeUrl(): URL {
    const raw = buildAuthorizationUrl({
      state: "st",
      codeChallenge: "cc",
      forceConsent: true,
      scopes: [EVENT_WRITE_SCOPE],
    });
    expect(raw).not.toBeNull();
    return new URL(raw as string);
  }

  it("requests ONLY calendar.events (not broad calendar, readonly, contacts, etc.)", () => {
    const scope = upgradeUrl().searchParams.get("scope");
    expect(scope).toBe(EVENT_WRITE_SCOPE);
    expect(scope).not.toContain("calendar.readonly");
    expect(scope).not.toMatch(/auth\/calendar($|\s)/); // no broad full-calendar scope
    expect(scope).not.toContain("contacts");
    expect(scope).not.toContain("gmail");
    expect(scope).not.toContain("drive");
  });

  it("preserves the Phase-A grant via include_granted_scopes=true", () => {
    expect(upgradeUrl().searchParams.get("include_granted_scopes")).toBe("true");
  });

  it("requests offline access + prompt=consent (unconditional)", () => {
    const u = upgradeUrl();
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
  });

  it("EVENT_WRITE_SCOPE is the documented Phase-B additional scope", () => {
    expect(PHASE_B_ADDITIONAL_SCOPES).toContain(EVENT_WRITE_SCOPE);
  });

  it("the default connect URL still requests only the Phase-A scopes (no event scope)", () => {
    const raw = buildAuthorizationUrl({ state: "s", codeChallenge: "c", forceConsent: false });
    const scope = new URL(raw as string).searchParams.get("scope") ?? "";
    expect(scope).toBe(PHASE_A_SCOPES.join(" "));
    expect(scope).not.toContain(EVENT_WRITE_SCOPE);
  });
});

describe("fetchTokenInfoScopes (fallback only)", () => {
  it("parses the scope field from tokeninfo", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ scope: `${PHASE_A_SCOPES[2]} ${EVENT_WRITE_SCOPE}` }), { status: 200 }),
    );
    const r = await fetchTokenInfoScopes("at");
    expect(r.ok && r.scopes).toContain(EVENT_WRITE_SCOPE);
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
