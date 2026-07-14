import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGoogleRestClient } from "@/lib/google-calendar/sync/google-rest-client";
import { createAccessTokenCache } from "@/lib/google-calendar/sync/access-token-cache";
import { createTokenManager, type ConnectionStore, type TokenCrypto } from "@/lib/google-calendar/sync/token-manager";
import type { GoogleRestClient } from "@/lib/google-calendar/sync/google-rest-client";

// Phase B2.1 — the worker core must NEVER log tokens, secrets, codes, or event
// bodies. We spy on every console method and assert no sensitive material is
// emitted while refreshing (incl. rotation + invalid_grant).

const SECRETS = ["super-secret-refresh", "rotated-secret", "access-token-xyz", "client-secret-value"];

function mockResponse(status: number, bodyText: string): Response {
  return {
    status,
    headers: { get: () => null },
    text: async () => bodyText,
  } as unknown as Response;
}

describe("no secrets in logs", () => {
  const captured: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug", "trace"] as const;
  const originals: Record<string, unknown> = {};

  beforeEach(() => {
    captured.length = 0;
    process.env.GOOGLE_OAUTH_CLIENT_ID = "cid";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "client-secret-value";
    for (const m of methods) {
      originals[m] = console[m];
      console[m] = vi.fn((...args: unknown[]) => {
        captured.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      }) as unknown as typeof console.log;
    }
  });
  afterEach(() => {
    for (const m of methods) console[m] = originals[m] as typeof console.log;
  });

  function assertNoSecrets() {
    const blob = captured.join("\n");
    for (const s of SECRETS) expect(blob.includes(s)).toBe(false);
  }

  it("a successful refresh with rotation logs nothing sensitive", async () => {
    const client = createGoogleRestClient({
      fetchImpl: (async () =>
        mockResponse(200, JSON.stringify({ access_token: "access-token-xyz", expires_in: 3600, refresh_token: "rotated-secret" }))) as unknown as typeof fetch,
    });
    const store: ConnectionStore = {
      loadConnection: async () => ({
        id: "c",
        studioId: "s",
        practitionerId: "p",
        connectionStatus: "connected",
        grantedScopes: [],
        writeCalendarId: "primary",
        isStudioCalendarOwner: true,
        tokenExpiresAt: null,
        destinationMode: "existing_owned",
      }),
      loadRefreshCiphertext: async () => "enc:super-secret-refresh",
      storeRotatedToken: async () => {},
      touchTokenExpiry: async () => {},
      markReconnectRequired: async () => {},
    };
    const crypto: TokenCrypto = {
      encrypt: (raw) => ({ ok: true, ciphertext: `enc:${raw}`, keyVersion: 1, last4: raw.slice(-4) }),
      decrypt: (blob) => (blob?.startsWith("enc:") ? { ok: true, secret: blob.slice(4) } : { ok: false, reason: "x" }),
    };
    const tm = createTokenManager({ store, crypto, client: client as GoogleRestClient, cache: createAccessTokenCache() });
    const r = await tm.ensureAccessToken("c", "s");
    expect(r.ok).toBe(true);
    assertNoSecrets();
  });

  it("an invalid_grant refresh logs nothing sensitive", async () => {
    const client = createGoogleRestClient({
      fetchImpl: (async () => mockResponse(400, JSON.stringify({ error: "invalid_grant" }))) as unknown as typeof fetch,
    });
    const store: ConnectionStore = {
      loadConnection: async () => ({ id: "c", studioId: "s", practitionerId: "p", connectionStatus: "connected", grantedScopes: [], writeCalendarId: null, isStudioCalendarOwner: true, tokenExpiresAt: null, destinationMode: "existing_owned" }),
      loadRefreshCiphertext: async () => "enc:super-secret-refresh",
      storeRotatedToken: async () => {},
      touchTokenExpiry: async () => {},
      markReconnectRequired: async () => {},
    };
    const crypto: TokenCrypto = {
      encrypt: (raw) => ({ ok: true, ciphertext: `enc:${raw}`, keyVersion: 1, last4: raw.slice(-4) }),
      decrypt: (blob) => (blob?.startsWith("enc:") ? { ok: true, secret: blob.slice(4) } : { ok: false, reason: "x" }),
    };
    const tm = createTokenManager({ store, crypto, client: client as GoogleRestClient, cache: createAccessTokenCache() });
    await tm.ensureAccessToken("c", "s");
    assertNoSecrets();
  });
});
