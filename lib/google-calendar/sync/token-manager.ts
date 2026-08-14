import "server-only";
import { type AccessTokenCache, DEFAULT_EXPIRY_SKEW_MS } from "./access-token-cache";
import type { GoogleRestClient } from "./google-rest-client";

// Google Calendar: Phase B2.1: token-refresh lifecycle for the worker.
//
// Guarantees:
//   * SINGLE-FLIGHT refresh per connection. In-process: an inflight-promise map
//     collapses concurrent callers. Cross-process: an injected RefreshCoordinator
//     (pg_advisory_xact_lock, transaction-scoped) so a worker fleet never runs
//     two refreshes for the same connection at once, which would race the
//     rotated-token persist.
//   * Refresh only when the cached access token is within the 60s expiry skew.
//   * ROTATION PERSISTENCE (fixes the live Phase-A defect): when Google returns a
//     new refresh token, it is encrypted and stored under the lock BEFORE the
//     result is returned, so the next refresh uses it. If encryption fails, we
//     FAIL CLOSED: the refresh is reported failed and the OLD encrypted token is
//     left intact (never silently dropped).
//   * invalid_grant -> mark the connection reconnect_required, clear the cache,
//     do not retry the refresh repeatedly.
//   * Ownership is re-derived from the connection row (by connectionId + studioId)
//     inside the lock; no cross-studio access; no token ever logged or returned to
//     a browser role.

export type ConnectionAuthRow = {
  id: string;
  studioId: string;
  practitionerId: string;
  connectionStatus: "disconnected" | "connected" | "reconnect_required" | "revoked" | "error";
  grantedScopes: string[];
  writeCalendarId: string | null;
  isStudioCalendarOwner: boolean;
  tokenExpiresAt: string | null;
  // B2.4: the chosen destination. The worker's execution-time scope gate DERIVES
  // the required event scope from it (calendar.app.created / calendar.events.owned)
  // broad calendar.events satisfies eligibility nowhere.
  destinationMode: string | null;
};

// A safe typed error for a FAILED/uncertain refresh-secret read (a Supabase query
// error or a thrown transport error while reading calendar_connection_secrets). It
// is DISTINCT from a genuinely-absent secret (which loadRefreshCiphertext returns
// as null). The token manager maps it to a transient retry, NEVER to
// reconnect_required, so a transient DB blip can't force a re-auth or touch the
// stored refresh token. Carries NO raw Supabase/SQL detail, connection id,
// ciphertext, or secret.
export class RefreshSecretReadError extends Error {
  constructor() {
    super("refresh secret read failed");
    this.name = "RefreshSecretReadError";
  }
}

// DB access, injected so the worker core is testable against a local disposable
// Supabase (pg) without the Supabase JS admin client. Production wiring uses the
// admin-client store (connection-store.ts).
export interface ConnectionStore {
  loadConnection(connectionId: string, studioId: string): Promise<ConnectionAuthRow | null>;
  // Returns the ciphertext when present, null when the query SUCCEEDS with no
  // secret row, and THROWS RefreshSecretReadError when the read fails/is uncertain
  // (never conflate a read failure with a genuinely-absent token).
  loadRefreshCiphertext(connectionId: string, studioId: string): Promise<string | null>;
  storeRotatedToken(args: {
    connectionId: string;
    studioId: string;
    encryptedRefreshToken: string;
    refreshTokenLast4: string;
    encryptionKeyVersion: number;
  }): Promise<void>;
  touchTokenExpiry(connectionId: string, studioId: string, expiresAtIso: string): Promise<void>;
  markReconnectRequired(connectionId: string, studioId: string, code: string): Promise<void>;
}

// Encrypt/decrypt of the refresh token (server-only). Production uses
// token-crypto.ts; tests can inject the real module or a fake.
export interface TokenCrypto {
  encrypt(raw: string): { ok: true; ciphertext: string; keyVersion: number; last4: string } | { ok: false; reason: string };
  decrypt(blob: string | null): { ok: true; secret: string } | { ok: false; reason: string };
}

// Cross-process mutual exclusion. runExclusive holds the lock for the connection
// across the whole callback (including the Google refresh HTTP call).
export interface RefreshCoordinator {
  runExclusive<T>(connectionId: string, fn: () => Promise<T>): Promise<T>;
}

// A pass-through coordinator (in-process serialization only) for a single-process
// pilot that has no pg pool wired. Documented as pilot-only.
export const inProcessOnlyCoordinator: RefreshCoordinator = {
  async runExclusive(_connectionId, fn) {
    return fn();
  },
};

export type TokenResult =
  | { ok: true; accessToken: string; connection: ConnectionAuthRow }
  | { ok: false; kind: "reconnect_required" | "insufficient_scope" | "transient"; code: string; retryAfterSeconds?: number };

export type TokenManagerDeps = {
  store: ConnectionStore;
  crypto: TokenCrypto;
  client: Pick<GoogleRestClient, "refreshToken">;
  cache: AccessTokenCache;
  coordinator?: RefreshCoordinator;
  now?: () => number;
  skewMs?: number;
};

export type TokenManager = {
  ensureAccessToken(connectionId: string, studioId: string): Promise<TokenResult>;
};

export function createTokenManager(deps: TokenManagerDeps): TokenManager {
  const now = deps.now ?? Date.now;
  const skewMs = deps.skewMs ?? DEFAULT_EXPIRY_SKEW_MS;
  const coordinator = deps.coordinator ?? inProcessOnlyCoordinator;
  const inflight = new Map<string, Promise<TokenResult>>();

  async function refreshUnderLock(connectionId: string, studioId: string): Promise<TokenResult> {
    // Double-check the cache inside the lock (an in-process waiter may already
    // have filled it). Access tokens are per-process, so a peer PROCESS that
    // refreshed does not populate our cache, but the lock still prevents its
    // concurrent refresh from racing our rotated-token persist.
    const cachedInLock = deps.cache.get(connectionId, now(), skewMs);
    const conn = await deps.store.loadConnection(connectionId, studioId);
    if (!conn) return { ok: false, kind: "transient", code: "connection_missing" };
    if (cachedInLock) return { ok: true, accessToken: cachedInLock, connection: conn };

    if (conn.connectionStatus === "reconnect_required" || conn.connectionStatus === "revoked") {
      deps.cache.clear(connectionId);
      return { ok: false, kind: "reconnect_required", code: `connection_${conn.connectionStatus}` };
    }

    let cipher: string | null;
    try {
      cipher = await deps.store.loadRefreshCiphertext(connectionId, studioId);
    } catch (e) {
      if (e instanceof RefreshSecretReadError) {
        // A transient/uncertain secrets-read failure is NOT a missing token: do
        // NOT mark reconnect_required, do NOT clear/overwrite the stored refresh
        // token. Report a transient so the worker result becomes retry_transient.
        // (The refresh coordinator's finally still releases the lock normally.)
        return { ok: false, kind: "transient", code: "refresh_secret_read_error" };
      }
      throw e;
    }
    if (!cipher) {
      await deps.store.markReconnectRequired(connectionId, studioId, "no_refresh_token");
      deps.cache.clear(connectionId);
      return { ok: false, kind: "reconnect_required", code: "no_refresh_token" };
    }
    const dec = deps.crypto.decrypt(cipher);
    if (!dec.ok) {
      await deps.store.markReconnectRequired(connectionId, studioId, "decrypt_failed");
      deps.cache.clear(connectionId);
      return { ok: false, kind: "reconnect_required", code: "decrypt_failed" };
    }

    const refreshed = await deps.client.refreshToken(dec.secret);
    if (!refreshed.ok) {
      const e = refreshed.error;
      if (e.kind === "invalid_grant") {
        await deps.store.markReconnectRequired(connectionId, studioId, "invalid_grant");
        deps.cache.clear(connectionId);
        return { ok: false, kind: "reconnect_required", code: "invalid_grant" };
      }
      if (e.kind === "insufficient_scope") {
        return { ok: false, kind: "insufficient_scope", code: e.code };
      }
      return {
        ok: false,
        kind: "transient",
        code: e.code,
        retryAfterSeconds: e.retryAfterSeconds ?? undefined,
      };
    }

    // Rotation persistence: the fix for the live defect. A rotated refresh token
    // is encrypted + stored under the lock. Encryption failure FAILS CLOSED: the
    // refresh is reported failed and the OLD stored token is left untouched.
    if (refreshed.rotatedRefreshToken) {
      const enc = deps.crypto.encrypt(refreshed.rotatedRefreshToken);
      if (!enc.ok) {
        deps.cache.clear(connectionId);
        return { ok: false, kind: "transient", code: "rotation_encrypt_failed" };
      }
      await deps.store.storeRotatedToken({
        connectionId,
        studioId,
        encryptedRefreshToken: enc.ciphertext,
        refreshTokenLast4: enc.last4,
        encryptionKeyVersion: enc.keyVersion,
      });
    }

    const expiresAtMs = now() + refreshed.expiresInSeconds * 1000;
    await deps.store.touchTokenExpiry(connectionId, studioId, new Date(expiresAtMs).toISOString());
    deps.cache.set(connectionId, refreshed.accessToken, expiresAtMs);
    return { ok: true, accessToken: refreshed.accessToken, connection: conn };
  }

  return {
    async ensureAccessToken(connectionId, studioId) {
      const cached = deps.cache.get(connectionId, now(), skewMs);
      if (cached) {
        const conn = await deps.store.loadConnection(connectionId, studioId);
        if (conn) return { ok: true, accessToken: cached, connection: conn };
        // Connection vanished under us: treat as transient.
        deps.cache.clear(connectionId);
      }
      const existing = inflight.get(connectionId);
      if (existing) return existing;
      const p = coordinator
        .runExclusive(connectionId, () => refreshUnderLock(connectionId, studioId))
        .catch((): TokenResult => ({ ok: false, kind: "transient", code: "refresh_lock_error" }));
      inflight.set(connectionId, p);
      try {
        return await p;
      } finally {
        inflight.delete(connectionId);
      }
    },
  };
}
