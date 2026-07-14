import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { adminQuery, closePool, resolveLocalDbUrl, seedStudio, userQuery, type SeededStudio } from "./helpers/harness";
import { createAccessTokenCache } from "@/lib/google-calendar/sync/access-token-cache";
import { createPgRefreshCoordinator } from "@/lib/google-calendar/sync/pg-refresh-coordinator";
import { createTokenManager, type ConnectionStore, type TokenCrypto } from "@/lib/google-calendar/sync/token-manager";
import type { GoogleFailure, GoogleRestClient, RefreshTokenSuccess } from "@/lib/google-calendar/sync/google-rest-client";
import { decryptGoogleSecret, encryptGoogleSecret } from "@/lib/google-calendar/token-crypto";

// Google Calendar — Phase B2.1 DB integration (LOCAL disposable Supabase only).
// Proves: pg_advisory_xact_lock single-flight serialization; independence across
// connections; rotated-token persist + next-refresh-uses-it (real crypto through
// the DB); browser roles cannot read the ciphertext; cross-studio refresh
// rejected; and the reconnect_required transition. No hosted production is ever
// touched (the harness refuses any non-localhost connection string).

const EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";
let pool: Pool;

beforeAll(() => {
  // A disposable test encryption key (32-byte hex) for the round-trip crypto.
  process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = "0".repeat(64);
  process.env.GOOGLE_TOKEN_ENCRYPTION_KEY_VERSION = "1";
  pool = new Pool({ connectionString: resolveLocalDbUrl(), max: 6 });
});
afterAll(async () => {
  await pool.end();
  await closePool();
});

const realCrypto: TokenCrypto = {
  encrypt: (raw) => encryptGoogleSecret(raw),
  decrypt: (blob) => decryptGoogleSecret(blob),
};

function pgStore(): ConnectionStore {
  return {
    async loadConnection(id, studioId) {
      const r = await adminQuery(
        "select id, studio_id, practitioner_id, connection_status, granted_scopes, write_calendar_id, is_studio_calendar_owner, token_expires_at, destination_mode from public.calendar_connections where id=$1 and studio_id=$2",
        [id, studioId],
      );
      if (r.rowCount === 0) return null;
      const row = r.rows[0];
      return {
        id: row.id,
        studioId: row.studio_id,
        practitionerId: row.practitioner_id,
        connectionStatus: row.connection_status,
        grantedScopes: row.granted_scopes ?? [],
        writeCalendarId: row.write_calendar_id,
        isStudioCalendarOwner: row.is_studio_calendar_owner === true,
        tokenExpiresAt: row.token_expires_at ? new Date(row.token_expires_at).toISOString() : null,
        destinationMode: row.destination_mode ?? null,
      };
    },
    async loadRefreshCiphertext(id, studioId) {
      const r = await adminQuery(
        "select encrypted_refresh_token from public.calendar_connection_secrets where connection_id=$1 and studio_id=$2",
        [id, studioId],
      );
      return r.rowCount ? r.rows[0].encrypted_refresh_token : null;
    },
    async storeRotatedToken(a) {
      await adminQuery(
        "update public.calendar_connection_secrets set encrypted_refresh_token=$1, refresh_token_last4=$2, encryption_key_version=$3, updated_at=now() where connection_id=$4 and studio_id=$5",
        [a.encryptedRefreshToken, a.refreshTokenLast4, a.encryptionKeyVersion, a.connectionId, a.studioId],
      );
    },
    async touchTokenExpiry(id, s, iso) {
      await adminQuery("update public.calendar_connections set token_expires_at=$1 where id=$2 and studio_id=$3", [iso, id, s]);
    },
    async markReconnectRequired(id, s, code) {
      await adminQuery(
        "update public.calendar_connections set connection_status='reconnect_required', last_error_code=$1, last_error_at=now() where id=$2 and studio_id=$3",
        [code.slice(0, 64), id, s],
      );
    },
  };
}

async function seedConnection(studio: SeededStudio, refreshPlain: string): Promise<string> {
  const connId = randomUUID();
  await adminQuery(
    "insert into public.calendar_connections (id, studio_id, practitioner_id, connection_status, granted_scopes, write_calendar_id, is_studio_calendar_owner) values ($1,$2,$3,'connected',$4,'primary',true)",
    [connId, studio.studioId, studio.practitionerId, [EVENTS_SCOPE]],
  );
  const enc = encryptGoogleSecret(refreshPlain);
  if (!enc.ok) throw new Error("encrypt failed in test setup");
  await adminQuery(
    "insert into public.calendar_connection_secrets (connection_id, studio_id, encrypted_refresh_token, refresh_token_last4, encryption_key_version) values ($1,$2,$3,$4,$5)",
    [connId, studio.studioId, enc.ciphertext, enc.last4, enc.keyVersion],
  );
  return connId;
}

type RefreshFn = (rt: string) => Promise<RefreshTokenSuccess | GoogleFailure>;

// A client that tracks max concurrency across refreshes (to observe the lock).
function trackingClient(delayMs: number) {
  const state = { current: 0, max: 0, calls: [] as string[] };
  const refreshToken: RefreshFn = async (rt) => {
    state.current += 1;
    state.max = Math.max(state.max, state.current);
    state.calls.push(rt);
    await new Promise((r) => setTimeout(r, delayMs));
    state.current -= 1;
    return { ok: true, accessToken: `at_${state.calls.length}`, expiresInSeconds: 3600, rotatedRefreshToken: null };
  };
  return { client: { refreshToken } as Pick<GoogleRestClient, "refreshToken">, state };
}

function managerWith(client: Pick<GoogleRestClient, "refreshToken">) {
  return createTokenManager({
    store: pgStore(),
    crypto: realCrypto,
    client,
    cache: createAccessTokenCache(), // per-manager cache => simulates a distinct process
    coordinator: createPgRefreshCoordinator(pool),
  });
}

describe("advisory-lock single-flight", () => {
  it("serializes concurrent refreshes for the SAME connection (max concurrency 1)", async () => {
    const studio = await seedStudio("gcalTokA");
    const conn = await seedConnection(studio, "rt-A");
    const { client, state } = trackingClient(60);
    // Two distinct managers = two processes sharing the DB lock.
    const tm1 = managerWith(client);
    const tm2 = managerWith(client);
    const [r1, r2] = await Promise.all([tm1.ensureAccessToken(conn, studio.studioId), tm2.ensureAccessToken(conn, studio.studioId)]);
    expect(r1.ok && r2.ok).toBe(true);
    expect(state.calls.length).toBe(2); // both processes minted their own access token
    expect(state.max).toBe(1); // but never concurrently — the lock serialized them
  });

  it("does NOT serialize DIFFERENT connections (they refresh in parallel)", async () => {
    // Two separate studios: calendar_connections is one-per-practitioner +
    // one-owner-per-studio, so two distinct connections need distinct studios.
    const studioA = await seedStudio("gcalTokB1");
    const studioB = await seedStudio("gcalTokB2");
    const connA = await seedConnection(studioA, "rt-A");
    const connB = await seedConnection(studioB, "rt-B");
    const { client, state } = trackingClient(60);
    const tm1 = managerWith(client);
    const tm2 = managerWith(client);
    await Promise.all([tm1.ensureAccessToken(connA, studioA.studioId), tm2.ensureAccessToken(connB, studioB.studioId)]);
    expect(state.max).toBe(2); // distinct lock keys => overlap allowed
  });
});

describe("rotation persistence through the DB", () => {
  it("persists a rotated refresh token (encrypted) and the next refresh uses it", async () => {
    const studio = await seedStudio("gcalTokRot");
    const conn = await seedConnection(studio, "rt-old");
    const calls: string[] = [];
    let n = 0;
    const client: Pick<GoogleRestClient, "refreshToken"> = {
      refreshToken: (async (rt: string) => {
        calls.push(rt);
        n += 1;
        return { ok: true, accessToken: `at${n}`, expiresInSeconds: 3600, rotatedRefreshToken: n === 1 ? "rt-new" : null };
      }) as RefreshFn,
    };
    const cache = createAccessTokenCache();
    let clock = 2_000_000_000_000;
    const tm = createTokenManager({ store: pgStore(), crypto: realCrypto, client, cache, coordinator: createPgRefreshCoordinator(pool), now: () => clock });

    await tm.ensureAccessToken(conn, studio.studioId);
    // The stored ciphertext now decrypts to the rotated token.
    const row = await adminQuery("select encrypted_refresh_token from public.calendar_connection_secrets where connection_id=$1", [conn]);
    const dec = decryptGoogleSecret(row.rows[0].encrypted_refresh_token);
    expect(dec.ok && dec.secret).toBe("rt-new");

    clock += 4_000_000; // force a fresh refresh
    cache.clear(conn);
    await tm.ensureAccessToken(conn, studio.studioId);
    expect(calls[1]).toBe("rt-new"); // next refresh used the rotated token
  });
});

describe("isolation + reconnect transition", () => {
  it("a browser (authenticated) role cannot read the ciphertext", async () => {
    const studio = await seedStudio("gcalTokSec");
    await seedConnection(studio, "rt-secret");
    await expect(
      userQuery(studio.userId, "select encrypted_refresh_token from public.calendar_connection_secrets"),
    ).rejects.toThrow();
  });

  it("a cross-studio refresh cannot touch the connection", async () => {
    const studio = await seedStudio("gcalTokX1");
    const other = await seedStudio("gcalTokX2");
    const conn = await seedConnection(studio, "rt-x");
    const { client } = trackingClient(0);
    const tm = managerWith(client);
    const r = await tm.ensureAccessToken(conn, other.studioId); // wrong studio
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("connection_missing");
  });

  it("invalid_grant transitions the connection to reconnect_required (member-readable)", async () => {
    const studio = await seedStudio("gcalTokRR");
    const conn = await seedConnection(studio, "rt-rr");
    const client: Pick<GoogleRestClient, "refreshToken"> = {
      refreshToken: (async () => ({ ok: false, error: { kind: "invalid_grant", status: 400, code: "invalid_grant", retryAfterSeconds: null } })) as RefreshFn,
    };
    const tm = createTokenManager({ store: pgStore(), crypto: realCrypto, client, cache: createAccessTokenCache(), coordinator: createPgRefreshCoordinator(pool) });
    const r = await tm.ensureAccessToken(conn, studio.studioId);
    expect(r.ok === false && r.kind).toBe("reconnect_required");
    // The member can see the health state; the code is a safe short string.
    const seen = await userQuery(studio.userId, "select connection_status, last_error_code from public.calendar_connections where id=$1", [conn]);
    expect(seen.rows[0].connection_status).toBe("reconnect_required");
    expect(seen.rows[0].last_error_code).toBe("invalid_grant");
  });
});
