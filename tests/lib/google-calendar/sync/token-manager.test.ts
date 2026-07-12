import { describe, expect, it, vi } from "vitest";
import { createAccessTokenCache } from "@/lib/google-calendar/sync/access-token-cache";
import {
  createTokenManager,
  type ConnectionAuthRow,
  type ConnectionStore,
  type TokenCrypto,
} from "@/lib/google-calendar/sync/token-manager";
import type { GoogleFailure, GoogleRestClient, RefreshTokenSuccess } from "@/lib/google-calendar/sync/google-rest-client";

type RefreshFn = (rt: string) => Promise<RefreshTokenSuccess | GoogleFailure>;

// Phase B2.1 — token refresh lifecycle: rotation persistence (the live-defect
// fix), fail-closed encryption, invalid_grant, single-flight, and caching.

const CONN = "conn-1";
const STUDIO = "studio-1";

function baseRow(overrides: Partial<ConnectionAuthRow> = {}): ConnectionAuthRow {
  return {
    id: CONN,
    studioId: STUDIO,
    practitionerId: "prac-1",
    connectionStatus: "connected",
    grantedScopes: ["https://www.googleapis.com/auth/calendar.events"],
    writeCalendarId: "primary",
    isStudioCalendarOwner: true,
    tokenExpiresAt: null,
    ...overrides,
  };
}

// In-memory store that records mutations and updates its own ciphertext so a
// "next refresh uses the rotated token" assertion is meaningful.
function makeStore(initialCipher: string, row = baseRow()) {
  const state = { cipher: initialCipher, status: row.connectionStatus, reconnectCode: null as string | null, expiry: null as string | null };
  const store: ConnectionStore = {
    loadConnection: vi.fn(async (id, studioId) =>
      id === CONN && studioId === STUDIO ? { ...row, connectionStatus: state.status } : null,
    ),
    loadRefreshCiphertext: vi.fn(async (id, studioId) => (id === CONN && studioId === STUDIO ? state.cipher : null)),
    storeRotatedToken: vi.fn(async (args) => {
      state.cipher = args.encryptedRefreshToken;
    }),
    touchTokenExpiry: vi.fn(async (_id, _s, iso) => {
      state.expiry = iso;
    }),
    markReconnectRequired: vi.fn(async (_id, _s, code) => {
      state.status = "reconnect_required";
      state.reconnectCode = code;
    }),
  };
  return { store, state };
}

// Trivial reversible crypto: "enc:<secret>". Toggle `failEncrypt` to force a
// fail-closed path.
function makeCrypto(failEncrypt = false): TokenCrypto {
  return {
    encrypt: (raw) =>
      failEncrypt
        ? { ok: false, reason: "encrypt_failed" }
        : { ok: true, ciphertext: `enc:${raw}`, keyVersion: 1, last4: raw.slice(-4) },
    decrypt: (blob) =>
      blob && blob.startsWith("enc:") ? { ok: true, secret: blob.slice(4) } : { ok: false, reason: "decrypt_failed" },
  };
}

type RefreshResult = Awaited<ReturnType<GoogleRestClient["refreshToken"]>>;
function makeClient(results: RefreshResult[], delayMs = 0) {
  const calls: string[] = [];
  let i = 0;
  const client: Pick<GoogleRestClient, "refreshToken"> = {
    refreshToken: vi.fn(async (rt: string) => {
      calls.push(rt);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return results[Math.min(i++, results.length - 1)];
    }),
  };
  return { client, calls };
}

function ok(accessToken: string, expiresIn = 3600, rotated: string | null = null): RefreshResult {
  return { ok: true, accessToken, expiresInSeconds: expiresIn, rotatedRefreshToken: rotated };
}

describe("token rotation persistence", () => {
  it("persists a rotated refresh token and the NEXT refresh uses it", async () => {
    const { store, state } = makeStore("enc:rt1");
    const { client, calls } = makeClient([ok("at1", 3600, "rt2"), ok("at2", 3600, null)]);
    const cache = createAccessTokenCache();
    let clock = 1_000_000;
    const tm = createTokenManager({ store, crypto: makeCrypto(), client, cache, now: () => clock });

    const r1 = await tm.ensureAccessToken(CONN, STUDIO);
    expect(r1.ok && r1.accessToken).toBe("at1");
    expect(store.storeRotatedToken).toHaveBeenCalledTimes(1);
    expect(state.cipher).toBe("enc:rt2"); // persisted

    clock += 4_000_000; // beyond expiry -> forces a real refresh
    cache.clear(CONN);
    const r2 = await tm.ensureAccessToken(CONN, STUDIO);
    expect(r2.ok && r2.accessToken).toBe("at2");
    expect(calls[1]).toBe("rt2"); // next refresh used the rotated token
  });

  it("absent rotation preserves the existing token (no store write)", async () => {
    const { store, state } = makeStore("enc:rt1");
    const { client } = makeClient([ok("at1", 3600, null)]);
    const tm = createTokenManager({ store, crypto: makeCrypto(), client, cache: createAccessTokenCache() });
    await tm.ensureAccessToken(CONN, STUDIO);
    expect(store.storeRotatedToken).not.toHaveBeenCalled();
    expect(state.cipher).toBe("enc:rt1");
  });

  it("encryption failure FAILS CLOSED: refresh reported failed, old token intact", async () => {
    const { store, state } = makeStore("enc:rt1");
    const { client } = makeClient([ok("at1", 3600, "rt2")]);
    const tm = createTokenManager({ store, crypto: makeCrypto(true), client, cache: createAccessTokenCache() });
    const r = await tm.ensureAccessToken(CONN, STUDIO);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("rotation_encrypt_failed");
    expect(store.storeRotatedToken).not.toHaveBeenCalled();
    expect(state.cipher).toBe("enc:rt1"); // unchanged
  });
});

describe("auth failures", () => {
  it("invalid_grant marks reconnect_required + clears cache", async () => {
    const { store, state } = makeStore("enc:rt1");
    const client: Pick<GoogleRestClient, "refreshToken"> = {
      refreshToken: vi.fn<RefreshFn>(async () => ({ ok: false, error: { kind: "invalid_grant", status: 400, code: "invalid_grant", retryAfterSeconds: null } })),
    };
    const cache = createAccessTokenCache();
    const tm = createTokenManager({ store, crypto: makeCrypto(), client, cache });
    const r = await tm.ensureAccessToken(CONN, STUDIO);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("reconnect_required");
    expect(store.markReconnectRequired).toHaveBeenCalledWith(CONN, STUDIO, "invalid_grant");
    expect(state.status).toBe("reconnect_required");
    expect(cache.get(CONN, Date.now())).toBeNull();
  });

  it("insufficient_scope is a distinct terminal kind", async () => {
    const { store } = makeStore("enc:rt1");
    const client: Pick<GoogleRestClient, "refreshToken"> = {
      refreshToken: vi.fn<RefreshFn>(async () => ({ ok: false, error: { kind: "insufficient_scope", status: 403, code: "google_insufficient_scope", retryAfterSeconds: null } })),
    };
    const tm = createTokenManager({ store, crypto: makeCrypto(), client, cache: createAccessTokenCache() });
    const r = await tm.ensureAccessToken(CONN, STUDIO);
    expect(r.ok === false && r.kind).toBe("insufficient_scope");
  });

  it("transient carries the retry-after and does not mark reconnect", async () => {
    const { store } = makeStore("enc:rt1");
    const client: Pick<GoogleRestClient, "refreshToken"> = {
      refreshToken: vi.fn<RefreshFn>(async () => ({ ok: false, error: { kind: "transient", status: 503, code: "google_http_503", retryAfterSeconds: 30 } })),
    };
    const tm = createTokenManager({ store, crypto: makeCrypto(), client, cache: createAccessTokenCache() });
    const r = await tm.ensureAccessToken(CONN, STUDIO);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("transient");
      expect(r.retryAfterSeconds).toBe(30);
    }
    expect(store.markReconnectRequired).not.toHaveBeenCalled();
  });

  it("a reconnect_required connection is not refreshed", async () => {
    const { store } = makeStore("enc:rt1", baseRow({ connectionStatus: "reconnect_required" }));
    const { client, calls } = makeClient([ok("at1")]);
    const tm = createTokenManager({ store, crypto: makeCrypto(), client, cache: createAccessTokenCache() });
    const r = await tm.ensureAccessToken(CONN, STUDIO);
    expect(r.ok === false && r.kind).toBe("reconnect_required");
    expect(calls.length).toBe(0);
  });
});

describe("single-flight + cache", () => {
  it("collapses concurrent same-connection calls into one refresh", async () => {
    const { store } = makeStore("enc:rt1");
    const { client, calls } = makeClient([ok("at1")], 20);
    const tm = createTokenManager({ store, crypto: makeCrypto(), client, cache: createAccessTokenCache() });
    const [a, b] = await Promise.all([tm.ensureAccessToken(CONN, STUDIO), tm.ensureAccessToken(CONN, STUDIO)]);
    expect(a).toEqual(b);
    expect(calls.length).toBe(1); // exactly one refresh
  });

  it("a cached token within skew avoids a second refresh", async () => {
    const { store } = makeStore("enc:rt1");
    const { client, calls } = makeClient([ok("at1", 3600)]);
    let clock = 1_000_000;
    const tm = createTokenManager({ store, crypto: makeCrypto(), client, cache: createAccessTokenCache(), now: () => clock });
    await tm.ensureAccessToken(CONN, STUDIO);
    clock += 60_000; // still well inside the 3600s validity minus 60s skew
    await tm.ensureAccessToken(CONN, STUDIO);
    expect(calls.length).toBe(1);
  });

  it("expiry skew forces a refresh when within 60s of expiry", async () => {
    const { store } = makeStore("enc:rt1");
    const { client, calls } = makeClient([ok("at1", 30), ok("at2", 30)]); // 30s tokens < 60s skew
    let clock = 1_000_000;
    const tm = createTokenManager({ store, crypto: makeCrypto(), client, cache: createAccessTokenCache(), now: () => clock });
    await tm.ensureAccessToken(CONN, STUDIO);
    clock += 1000;
    await tm.ensureAccessToken(CONN, STUDIO);
    expect(calls.length).toBe(2); // never cacheable under skew
  });
});
