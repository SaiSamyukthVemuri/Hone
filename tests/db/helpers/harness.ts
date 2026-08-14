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

// Run several admin statements inside ONE transaction on ONE connection, so
// they share a single `now()`. `adminQuery` is autocommit, each call is its
// own transaction with its own transaction timestamp, which is fine for
// seeding but wrong whenever a test's meaning depends on two statements
// observing the SAME clock (B4's repair window measures "exactly 72 hours"
// between an audit row's created_at and the command's now()).
// Commits on success, rolls back if `fn` throws.
export async function adminTx<T>(
  fn: (query: UserQuery) => Promise<T>,
): Promise<T> {
  const client: PoolClient = await getPool().connect();
  try {
    await client.query("begin");
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

// Run `fn` under an explicit Postgres role (anon / authenticated / service_role)
// in a rolled-back transaction, for function-level EXECUTE privilege probes.
// `role` is an allow-listed test literal, never user input.
const ROLE_ALLOWLIST = new Set(["anon", "authenticated", "service_role"]);
export async function asRole<T>(
  role: "anon" | "authenticated" | "service_role",
  fn: (query: UserQuery) => Promise<T>,
): Promise<T> {
  if (!ROLE_ALLOWLIST.has(role)) throw new Error(`unsupported role: ${role}`);
  const client: PoolClient = await getPool().connect();
  try {
    await client.query("begin");
    await client.query(`set local role ${role}`);
    const result = await fn((text, params = []) => client.query(text, params));
    await client.query("rollback"); // privilege probes never persist
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

// Force a session into the RETIRED 'finalized'/'void' lifecycle, for the few
// suites that must still exercise behaviour against a legacy record.
//
// Migration 0159 permanently blocks that transition for EVERY role, so the only
// way to construct the state is to disable the retirement trigger as the table
// OWNER, write, and re-enable. That is deliberate and deliberately noisy: it is
// proof that the shipped schema carries no bypass at all. `anon`, `authenticated`
// and `service_role` cannot do this, only the migration channel can, which is
// exactly the posture the product decision asks for. Any suite calling this is
// asserting something about the ONE preserved legacy artifact, never about a
// capability a practitioner has.
export async function seedLegacyRecordStatus(
  sessionId: string,
  status: "finalized" | "void",
): Promise<void> {
  await adminQuery(
    "alter table public.sessions disable trigger sessions_guard_retired_finalization",
  );
  try {
    await adminQuery("update public.sessions set record_status = $2 where id = $1", [
      sessionId,
      status,
    ]);
  } finally {
    await adminQuery(
      "alter table public.sessions enable trigger sessions_guard_retired_finalization",
    );
  }
}

// ===========================================================================
// B5 / 0174, appointment_audit TEST-ONLY fixtures
// ===========================================================================
//
// 0174 made `public.appointment_audit` structurally append-only and made its
// `created_at` database-derived at INSERT:
//
//   * appointment_audit_derive_trusted_fields_trg (BEFORE INSERT) overwrites
//     any caller-supplied created_at with now();
//   * appointment_audit_append_only (BEFORE UPDATE OR DELETE) refuses every
//     mutation except the ON DELETE SET NULL detach.
//
// Both are exactly the point of B5, so neither may be softened to suit tests.
// But some suites legitimately need HISTORICAL audit rows, B4's 72-hour repair
// window is measured from `appointment_audit.created_at DESC`, so proving the
// boundary requires a row that really is 72 hours old.
//
// The three helpers below are the sanctioned way to build that state, and they
// follow `seedLegacyRecordStatus` above verbatim: disable the trigger as the
// table OWNER, write, re-enable in a `finally`. That capability belongs to the
// migration channel alone, `anon`, `authenticated` and `service_role` cannot
// reach it, and after 0174 service_role holds no INSERT/UPDATE/DELETE on the
// table at all.
//
// *** WHY THERE IS NO RPC FOR THIS ***
// It would have been easier to ship a `set_appointment_audit_created_at()`
// SECURITY DEFINER function and call it from tests. That is precisely what B5
// must not do: a production-reachable "choose an arbitrary audit timestamp"
// entry point would hand back the caller-controlled created_at that 0174 exists
// to remove, and would re-open the forgery that wins the cancellation-insight
// card's `order by created_at desc limit 1`. The bypass lives in the test
// harness, runs as the owner, and ships in no migration.

const AUDIT_DERIVE_TRG = "appointment_audit_derive_trusted_fields_trg";
const AUDIT_APPEND_ONLY_TRG = "appointment_audit_append_only";

async function withAuditTriggerDisabled<T>(
  trigger: string,
  fn: () => Promise<T>,
): Promise<T> {
  await adminQuery(
    `alter table public.appointment_audit disable trigger ${trigger}`,
  );
  try {
    return await fn();
  } finally {
    await adminQuery(
      `alter table public.appointment_audit enable trigger ${trigger}`,
    );
  }
}

// Insert an appointment_audit row with a REAL historical created_at, bypassing
// the derive trigger. `createdAtSql` is a trusted SQL interval/timestamp
// expression written by the test (e.g. "now() - interval '10 days'"), never
// user input.
export async function seedHistoricalAppointmentAudit(opts: {
  appointmentId: string;
  actorType: "practitioner" | "client" | "system";
  actorId: string | null;
  action: string;
  details?: Record<string, unknown>;
  createdAtSql: string;
  studioId?: string;
}): Promise<void> {
  await withAuditTriggerDisabled(AUDIT_DERIVE_TRG, async () => {
    // studio_id is NOT NULL and the derive trigger is off, so it is resolved
    // here from the parent appointment, the same value the trigger would have
    // derived, never a caller-chosen tenant.
    await adminQuery(
      `insert into public.appointment_audit
         (appointment_id, studio_id, actor_type, actor_id, actor_practitioner_id,
          action, details, created_at)
       values (
         $1,
         coalesce($6::uuid, (select a.studio_id from public.appointments a where a.id = $1)),
         $2, $3,
         case when $2 = 'practitioner' then $3::uuid end,
         $4, $5::jsonb, ${opts.createdAtSql})`,
      [
        opts.appointmentId,
        opts.actorType,
        opts.actorId,
        opts.action,
        JSON.stringify(opts.details ?? {}),
        opts.studioId ?? null,
      ],
    );
  });
}

// Move an EXISTING audit row's created_at, bypassing the append-only trigger.
// Used by the B4 repair-window boundary tests, which need "exactly 72 hours"
// and "72 hours + 1 microsecond" measured against the same transaction clock.
export async function backdateAppointmentAudit(
  appointmentId: string,
  action: string,
  intervalSql: string,
): Promise<void> {
  await withAuditTriggerDisabled(AUDIT_APPEND_ONLY_TRG, async () => {
    await adminQuery(
      `update public.appointment_audit
          set created_at = now() - ${intervalSql}
        where appointment_id = $1 and action = $2`,
      [appointmentId, action],
    );
  });
}

// Remove appointment_audit rows for a studio, bypassing the append-only
// trigger. Fixture teardown ONLY, 0174 deliberately leaves no runtime path
// that can delete an audit row, including for service_role.
export async function purgeAppointmentAudit(studioId: string): Promise<void> {
  await withAuditTriggerDisabled(AUDIT_APPEND_ONLY_TRG, async () => {
    await adminQuery(
      `delete from public.appointment_audit where studio_id = $1`,
      [studioId],
    );
  });
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
