import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { adminQuery, adminTx, closePool, seedStudio, userQuery, type SeededStudio } from "./helpers/harness";

// 0375 up / down / up on the shared test database. The down is EMERGENCY-ONLY: it destroys consent evidence, refuses while any stored
// photo row or pending storage deletion exists, and refuses while any consent, withdrawal, switch-log or audit row exists unless the session
// sets hone.confirm_destroy_consent_evidence = 'yes'. This file replays the down and then the up, and always leaves the database at the migration
// head (the up is re-applied in a finally), so later files see the objects 0375 creates. NAMED files only: a directory walk is refused by the
// "no DB suite walks a whole source root" guard.
const root = join(__dirname, "..", "..", "supabase");
const up = readFileSync(join(root, "migrations", "0375_client_identification_photo_store.sql"), "utf8");
const down = readFileSync(join(root, "rollbacks", "0375_client_identification_photo_store.down.sql"), "utf8");

// What the up creates, read from the up itself so a new object cannot be forgotten by the down without this going red.
const TABLES = [...up.matchAll(/^create table public\.(\w+)/gm)].map((m) => m[1]);
const FUNCTIONS = [...up.matchAll(/^create or replace function public\.(\w+)\(/gm)].map((m) => m[1]);
const TRIGGERS_ON_CLIENTS = ["client_id_photo_on_client_archive", "clients_portrait_pointer_frozen"];

const q = async (t: string, p: unknown[] = []) => (await adminQuery(t, p)).rows as any[];
const n = async (t: string, p: unknown[] = []) => Number((await q(t, p))[0].n);
const tableCount = () => n(`select count(*)::int n from pg_tables where schemaname='public' and tablename = any($1)`, [TABLES]);
const functionNames = async () =>
  new Set((await q(`select distinct proname from pg_proc where pronamespace='public'::regnamespace and proname = any($1)`, [FUNCTIONS])).map((r) => r.proname));
const triggerCount = () =>
  n(`select count(*)::int n from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.relname='clients' and not t.tgisinternal and t.tgname = any($1)`, [TRIGGERS_ON_CLIENTS]);
const canRun = async (role: string) =>
  (await q(`select has_function_privilege($1, 'public.set_client_portrait(uuid,uuid,uuid)', 'execute') ok`, [role]))[0].ok as boolean;
const publicCanRun = async () =>
  n(`select count(*)::int n from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid='public.set_client_portrait(uuid,uuid,uuid)'::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE'`);
const evidenceRows = () =>
  n(`select ((select count(*) from public.client_id_photo_consents) + (select count(*) from public.client_id_photo_audit) + (select count(*) from public.studio_client_id_photo_switch_log))::int n`);

/**
 * Runs the down on ONE dedicated connection, so a transaction-local confirmation reaches it (a pooled query could land on another
 * connection). The file opens its own transaction; inside adminTx that is a harmless nested BEGIN and its COMMIT ends the transaction.
 * A refusal rolls back on the same connection.
 */
async function runDown(confirm?: string): Promise<void> {
  await adminTx(async (query) => {
    if (confirm !== undefined) await query(`select set_config('hone.confirm_destroy_consent_evidence', $1, true)`, [confirm]);
    await query(down);
  });
}

let A: SeededStudio;
let wording: { version: string; sha: string };

async function seedConsentAndPhoto(): Promise<{ clientId: string; path: string }> {
  const clientId = randomUUID();
  await q(`insert into public.clients (id, studio_id, name) values ($1,$2,'Client roundtrip')`, [clientId, A.studioId]);
  await q(`select public.set_client_id_photo_enabled($1, true, 'synthetic test')`, [A.studioId]);
  await userQuery(A.userId, `select public.record_client_id_photo_consent($1,$2,$3,'in_person','client')`, [clientId, wording.version, wording.sha]);
  const path = (await userQuery(A.userId, `select public.reserve_client_id_photo_path($1) p`, [clientId])).rows[0].p as string;
  await userQuery(A.userId, `select public.set_client_id_photo($1,$2,20000,512,512)`, [clientId, path]);
  return { clientId, path };
}

beforeAll(async () => {
  A = await seedStudio("idphoto-rt");
  // The seeded wording is UNAPPROVED; approve it (idempotent), then use whatever wording is CURRENT. In the shared database another suite may
  // already have approved a LATER version, which supersedes v1.1, and a consent is only accepted against the current one.
  await q(`select public.approve_client_id_photo_wording('v1.1')`);
  const cur = await userQuery(A.userId, `select version, wording_sha256 from public.client_id_photo_wording_current($1)`, [A.studioId]);
  expect(cur.rows, "an approved wording is current for the owner").toHaveLength(1);
  wording = { version: cur.rows[0].version, sha: cur.rows[0].wording_sha256 };
});

afterAll(async () => {
  // Whatever happened above, leave the database at the migration head.
  if ((await tableCount()) !== TABLES.length) await q(up);
  await closePool();
});

describe("0375 down file: what it covers", () => {
  it("the up creates seven tables and twenty-one functions, so the counts below are not vacuous", () => {
    expect(TABLES).toHaveLength(7);
    expect(FUNCTIONS).toHaveLength(21);
  });
});

/** Drain everything the down refuses on first, leaving consent evidence in place. */
async function drainStoreOnly(): Promise<void> {
  await q(`delete from public.client_id_photos`);
  await q(`delete from public.client_id_photo_pending_object_deletions`);
}

describe("0375 up / down / up", () => {
  it("down REFUSES while a stored photo exists, destroying nothing, even when the session confirms", async () => {
    const { clientId } = await seedConsentAndPhoto();
    expect(await n(`select count(*)::int n from public.client_id_photos where client_id=$1`, [clientId])).toBe(1);
    await expect(runDown("yes")).rejects.toThrow(/stored identification photos still exist/);
    expect(await tableCount()).toBe(7);
    expect((await functionNames()).size).toBe(21);
    expect(await n(`select count(*)::int n from public.client_id_photos where client_id=$1`, [clientId])).toBe(1);
    expect(await triggerCount()).toBe(2);
  });

  it("down REFUSES while a storage object is still queued for deletion, destroying nothing, even when the session confirms", async () => {
    // Remove every stored photo (the queue trigger queues each object), leaving only queued deletions behind.
    await q(`delete from public.client_id_photos`);
    expect(await n(`select count(*)::int n from public.client_id_photo_pending_object_deletions`)).toBeGreaterThan(0);
    await expect(runDown("yes")).rejects.toThrow(/storage objects are still queued for deletion/);
    expect(await tableCount()).toBe(7);
    expect((await functionNames()).size).toBe(21);
  });

  it("with the store drained but consent evidence present, down REFUSES unless the session confirms with exactly 'yes'", async () => {
    await drainStoreOnly();
    expect(await evidenceRows(), "there is consent evidence to protect").toBeGreaterThan(0);
    const before = await evidenceRows();
    await expect(runDown(), "no setting at all").rejects.toThrow(/consent, withdrawal, switch-log or audit rows exist/);
    await expect(runDown("no"), "the wrong value").rejects.toThrow(/consent, withdrawal, switch-log or audit rows exist/);
    await expect(runDown(""), "an empty value").rejects.toThrow(/consent, withdrawal, switch-log or audit rows exist/);
    await expect(runDown("YES"), "the value is exact").rejects.toThrow(/consent, withdrawal, switch-log or audit rows exist/);
    expect(await tableCount()).toBe(7);
    expect((await functionNames()).size).toBe(21);
    expect(await triggerCount()).toBe(2);
    expect(await evidenceRows(), "nothing was destroyed by a refusal").toBe(before);
  });

  it("with the session's confirmation, down drops the seven tables, the twenty-one functions and both triggers, leaves the setter revoked from EVERY role, and up re-applies", async () => {
    await drainStoreOnly();
    expect(await evidenceRows()).toBeGreaterThan(0);
    for (const role of ["authenticated", "anon", "service_role"]) expect(await canRun(role), `${role} before`).toBe(false);
    try {
      await runDown("yes");
      expect(await tableCount()).toBe(0);
      expect((await functionNames()).size).toBe(0);
      expect(await triggerCount()).toBe(0);
      // NOT granted back: no role can run the retired setter after the down.
      for (const role of ["authenticated", "anon", "service_role"]) expect(await canRun(role), `${role} after the down`).toBe(false);
      expect(await publicCanRun(), "public after the down").toBe(0);
    } finally {
      await q(up);
    }
    expect(await tableCount()).toBe(7);
    expect((await functionNames()).size).toBe(21);
    expect(await triggerCount()).toBe(2);
    for (const role of ["authenticated", "anon", "service_role"]) expect(await canRun(role), `${role} after the up`).toBe(false);
    expect(await publicCanRun()).toBe(0);
    // The consent evidence did NOT survive the round trip (the file's warning is true).
    expect(await evidenceRows()).toBe(0);
    const w = await q(`select approved_at from public.client_id_photo_wording_versions where version = 'v1.1'`);
    expect(w, "the wording is seeded again").toHaveLength(1);
    expect(w[0].approved_at, "and UNAPPROVED, as the migration seeds it").toBeNull();
  });

  it("with no consent evidence at all (fresh tables), down needs no confirmation, and up re-applies", async () => {
    expect(await evidenceRows(), "the previous case left the tables empty").toBe(0);
    try {
      await runDown();
      expect(await tableCount()).toBe(0);
      for (const role of ["authenticated", "anon", "service_role"]) expect(await canRun(role), role).toBe(false);
    } finally {
      await q(up);
    }
    expect(await tableCount()).toBe(7);
    expect(await triggerCount()).toBe(2);
  });
});
