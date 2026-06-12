import { randomUUID } from "node:crypto";
import { Pool, type PoolClient, type QueryResult } from "pg";

// ===========================================================================
// DB/RLS integration test harness (PR #220)
// ===========================================================================
//
// Connects to a LOCAL Supabase Postgres only (the `supabase db start`
// stack from supabase/config.toml, db port 54322). The suite under
// tests/db/ exercises the REAL migrated database: RLS policies,
// triggers, claim RPCs, and constraints, as the `authenticated` role
// with auth.uid() simulated through request.jwt.claims. This is the
// behavior layer the static SQL-text tests in tests/migrations/
// cannot prove.
//
// Safety model (enforced below, pinned by the unit-lane guardrail
// test in tests/scripts/db-harness-guardrails.test.ts):
//   * The connection string must point at localhost. Anything else
//     throws before a single query runs.
//   * Connection strings containing hosted-database host patterns
//     (supabase.co/.com, pooler, amazonaws, etc.) are refused even
//     if they somehow resolve locally.
//   * The harness never reads NEXT_PUBLIC_SUPABASE_URL,
//     SUPABASE_SERVICE_ROLE_KEY, or any production credential. The
//     only env var it consults is HONE_LOCAL_DB_URL, and that value
//     must itself pass the localhost checks.
//   * Seeded auth users are fake rows inserted directly into the
//     LOCAL auth.users table with random UUIDs and @harness.local
//     emails. No real accounts, no production auth.

const DEFAULT_LOCAL_DB_URL =
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

// Host fragments that indicate a hosted/production database. The
// match runs over the WHOLE connection string so a banned host can
// not hide in credentials or query params.
const BANNED_URL_PATTERNS =
  /supabase\.co|supabase\.com|supabase\.in|pooler\.|amazonaws\.com|rds\.|azure|neon\.tech|render\.com|fly\.io/i;

export function resolveLocalDbUrl(): string {
  const url = process.env.HONE_LOCAL_DB_URL || DEFAULT_LOCAL_DB_URL;
  if (BANNED_URL_PATTERNS.test(url)) {
    throw new Error(
      "tests/db refuses to run: HONE_LOCAL_DB_URL matches a hosted-database host pattern. " +
        "This suite may only target the local Supabase stack (supabase db start).",
    );
  }
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(
      "tests/db refuses to run: HONE_LOCAL_DB_URL is not a parseable URL.",
    );
  }
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `tests/db refuses to run: database host "${host}" is not localhost. ` +
        "This suite may only target the local Supabase stack (supabase db start).",
    );
  }
  return url;
}

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: resolveLocalDbUrl(),
      max: 4,
      connectionTimeoutMillis: 5_000,
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// Admin-path query (connects as the local `postgres` role, which has
// bypassrls). Mirrors the app's service-role/admin-client writes.
// Use for seeding and for asserting ground truth.
export async function adminQuery(
  text: string,
  params: unknown[] = [],
): Promise<QueryResult> {
  return getPool().query(text, params);
}

export type UserQuery = (
  text: string,
  params?: unknown[],
) => Promise<QueryResult>;

// Run `fn` as an authenticated app user. Each call gets its own
// transaction on a pooled connection with:
//   set local role authenticated;
//   request.jwt.claims = {"sub": "<userId>", "role": "authenticated"}
// which is exactly how PostgREST presents a logged-in user to
// Postgres, so auth.uid() and every RLS policy behave as in
// production. Commits on success so trigger side effects (audit
// rows) are observable; rolls back if `fn` throws.
export async function asUser<T>(
  userId: string,
  fn: (query: UserQuery) => Promise<T>,
): Promise<T> {
  const client: PoolClient = await getPool().connect();
  try {
    await client.query("begin");
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: userId, role: "authenticated" }),
    ]);
    const result = await fn((text, params = []) => client.query(text, params));
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// Convenience: run a single statement as an authenticated user.
export async function userQuery(
  userId: string,
  text: string,
  params: unknown[] = [],
): Promise<QueryResult> {
  return asUser(userId, (query) => query(text, params));
}

export type SeededStudio = {
  studioId: string;
  userId: string;
  practitionerId: string;
  clientId: string;
};

// Seed a studio with one active owner practitioner (backed by a fake
// LOCAL auth.users row) and one client. All ids are random UUIDs so
// suites can re-run against the same local database without
// colliding; assertions must scope by these ids, never by global
// counts.
export async function seedStudio(label: string): Promise<SeededStudio> {
  const studioId = randomUUID();
  const userId = randomUUID();
  const practitionerId = randomUUID();
  const clientId = randomUUID();
  const email = `${label}-${userId.slice(0, 8)}@harness.local`;
  await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [
    userId,
    email,
  ]);
  await adminQuery(
    `insert into public.studios (id, name, owner_email) values ($1, $2, $3)`,
    [studioId, `Harness ${label}`, email],
  );
  await adminQuery(
    `insert into public.practitioners
       (id, studio_id, user_id, display_name, email, role, active)
     values ($1, $2, $3, $4, $5, 'owner', true)`,
    [practitionerId, studioId, userId, `Harness ${label}`, email],
  );
  await adminQuery(
    `insert into public.clients (id, studio_id, name) values ($1, $2, $3)`,
    [clientId, studioId, `Client ${label}`],
  );
  return { studioId, userId, practitionerId, clientId };
}

// Seed an additional NON-OWNER practitioner (role 'practitioner')
// into an existing studio, backed by its own fake local auth user.
// Used by owner-tier tests (PR #222) to exercise the owner/member
// distinction.
export async function seedMember(
  studio: SeededStudio,
  label: string,
): Promise<{ userId: string; practitionerId: string }> {
  const userId = randomUUID();
  const practitionerId = randomUUID();
  const email = `${label}-${userId.slice(0, 8)}@harness.local`;
  await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [
    userId,
    email,
  ]);
  await adminQuery(
    `insert into public.practitioners
       (id, studio_id, user_id, display_name, email, role, active)
     values ($1, $2, $3, $4, $5, 'practitioner', true)`,
    [practitionerId, studio.studioId, userId, `Member ${label}`, email],
  );
  return { userId, practitionerId };
}

// Seed a session (electrolysis) for a studio's client; returns ids.
export async function seedSession(
  studio: SeededStudio,
): Promise<{ sessionId: string; blockId: string }> {
  const sessionId = randomUUID();
  const blockId = randomUUID();
  await adminQuery(
    `insert into public.sessions (id, studio_id, client_id, practitioner_id, modality)
     values ($1, $2, $3, $4, 'electrolysis')`,
    [sessionId, studio.studioId, studio.clientId, studio.practitionerId],
  );
  await adminQuery(
    `insert into public.session_blocks (id, studio_id, session_id)
     values ($1, $2, $3)`,
    [blockId, studio.studioId, sessionId],
  );
  return { sessionId, blockId };
}
