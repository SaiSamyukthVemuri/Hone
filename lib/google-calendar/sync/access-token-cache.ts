import "server-only";

// Google Calendar: Phase B2.1: in-memory access-token cache for the worker
// runtime process. Access tokens are NEVER persisted (Phase A stores only the
// encrypted refresh token) and NEVER returned to browser roles or logged.
//
// Keyed by connection id, expiry-aware with a skew so we refresh slightly early.
// A dedicated worker fleet has one cache PER process; cross-process single-flight
// is provided by the DB advisory lock in the token manager, not by this cache.

export const DEFAULT_EXPIRY_SKEW_MS = 60_000; // refresh when within 60s of expiry

type Entry = { accessToken: string; expiresAtMs: number };

export type AccessTokenCache = {
  // Returns a still-valid token (accounting for skew) or null.
  get(connectionId: string, nowMs: number, skewMs?: number): string | null;
  set(connectionId: string, accessToken: string, expiresAtMs: number): void;
  clear(connectionId: string): void;
  clearAll(): void;
  size(): number;
};

export function createAccessTokenCache(): AccessTokenCache {
  const store = new Map<string, Entry>();
  return {
    get(connectionId, nowMs, skewMs = DEFAULT_EXPIRY_SKEW_MS) {
      const e = store.get(connectionId);
      if (!e) return null;
      if (nowMs >= e.expiresAtMs - skewMs) {
        // Expiring/expired within skew: treat as a miss (and drop it).
        store.delete(connectionId);
        return null;
      }
      return e.accessToken;
    },
    set(connectionId, accessToken, expiresAtMs) {
      store.set(connectionId, { accessToken, expiresAtMs });
    },
    clear(connectionId) {
      store.delete(connectionId);
    },
    clearAll() {
      store.clear();
    },
    size() {
      return store.size;
    },
  };
}

// A process-wide default cache for the pilot cron adapter. A dedicated worker
// would construct its own per-process cache instead.
export const processAccessTokenCache: AccessTokenCache = createAccessTokenCache();
