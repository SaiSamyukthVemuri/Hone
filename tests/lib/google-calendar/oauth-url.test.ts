import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  PHASE_A_SCOPES,
  PHASE_B_ADDITIONAL_SCOPES,
  REQUESTED_SCOPES,
  safeReturnPath,
  getOAuthRedirectUri,
} from "@/lib/google-calendar/config";
import {
  buildAuthorizationUrl,
  generatePkce,
  sha256Hex,
} from "@/lib/google-calendar/oauth";

const saved = {
  cid: process.env.GOOGLE_OAUTH_CLIENT_ID,
  csec: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  origin: process.env.NEXT_PUBLIC_APP_ORIGIN,
};

beforeEach(() => {
  process.env.GOOGLE_OAUTH_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-client-secret";
  process.env.NEXT_PUBLIC_APP_ORIGIN = "https://hone.care";
});
afterEach(() => {
  process.env.GOOGLE_OAUTH_CLIENT_ID = saved.cid;
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = saved.csec;
  process.env.NEXT_PUBLIC_APP_ORIGIN = saved.origin;
});

describe("Phase A scopes — least privilege", () => {
  it("requests ONLY identity + calendar-list discovery (NO event read/write)", () => {
    expect(REQUESTED_SCOPES).toEqual(PHASE_A_SCOPES);
    expect(PHASE_A_SCOPES).toContain("openid");
    expect(PHASE_A_SCOPES).toContain("https://www.googleapis.com/auth/userinfo.email");
    expect(PHASE_A_SCOPES).toContain(
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    );
    // Phase A must NOT request any event read/write scope.
    expect(PHASE_A_SCOPES).not.toContain("https://www.googleapis.com/auth/calendar.events");
    expect(PHASE_A_SCOPES).not.toContain("https://www.googleapis.com/auth/calendar.readonly");
    expect(PHASE_A_SCOPES).not.toContain("https://www.googleapis.com/auth/calendar");
  });

  it("reserves the DESTINATION event scopes for Phase B (documented, not requested now); broad calendar.events is retired", () => {
    expect(PHASE_B_ADDITIONAL_SCOPES).toContain("https://www.googleapis.com/auth/calendar.app.created");
    expect(PHASE_B_ADDITIONAL_SCOPES).toContain("https://www.googleapis.com/auth/calendar.events.owned");
    expect(PHASE_B_ADDITIONAL_SCOPES).toContain("https://www.googleapis.com/auth/calendar.readonly");
    expect(PHASE_B_ADDITIONAL_SCOPES as readonly string[]).not.toContain(
      "https://www.googleapis.com/auth/calendar.events",
    );
  });
});

describe("buildAuthorizationUrl", () => {
  it("includes offline access + incremental authorization + PKCE S256 + Phase A scopes", () => {
    const url = buildAuthorizationUrl({
      state: "STATE123",
      codeChallenge: "CHALLENGE",
      forceConsent: false,
    });
    expect(url).toBeTruthy();
    const p = new URL(url!).searchParams;
    expect(p.get("access_type")).toBe("offline");
    expect(p.get("include_granted_scopes")).toBe("true");
    expect(p.get("response_type")).toBe("code");
    expect(p.get("code_challenge")).toBe("CHALLENGE");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("state")).toBe("STATE123");
    expect(p.get("redirect_uri")).toBe("https://hone.care/api/google-calendar/oauth/callback");
    const scope = p.get("scope") ?? "";
    expect(scope).toContain("calendar.calendarlist.readonly");
    expect(scope).not.toContain("calendar.events");
    // Not forcing consent by default.
    expect(p.get("prompt")).toBeNull();
  });

  it("forces prompt=consent + login_hint when requested (first connect / reconnect)", () => {
    const url = buildAuthorizationUrl({
      state: "S",
      codeChallenge: "C",
      forceConsent: true,
      loginHint: "practitioner@example.com",
    });
    const p = new URL(url!).searchParams;
    expect(p.get("prompt")).toBe("consent");
    expect(p.get("login_hint")).toBe("practitioner@example.com");
  });

  it("returns null (fail-closed) when the OAuth client is not configured", () => {
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    expect(buildAuthorizationUrl({ state: "S", codeChallenge: "C", forceConsent: false })).toBeNull();
  });

  it("builds the fixed, server-derived redirect URI (never a request header)", () => {
    expect(getOAuthRedirectUri()).toBe("https://hone.care/api/google-calendar/oauth/callback");
  });
});

describe("PKCE + hashing", () => {
  it("derives a correct S256 challenge from the verifier", () => {
    const { verifier, challenge } = generatePkce();
    const expected = createHash("sha256")
      .update(verifier)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    expect(challenge).toBe(expected);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
  });

  it("sha256Hex produces 64 hex chars", () => {
    expect(sha256Hex("abc")).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("safeReturnPath — open-redirect guard", () => {
  it("allows only allow-listed internal paths, defaulting otherwise", () => {
    expect(safeReturnPath("/settings/profile")).toBe("/settings/profile");
    expect(safeReturnPath("https://evil.example.com")).toBe("/settings/profile");
    expect(safeReturnPath("//evil.example.com")).toBe("/settings/profile");
    expect(safeReturnPath("/admin")).toBe("/settings/profile");
    expect(safeReturnPath(null)).toBe("/settings/profile");
  });
});
