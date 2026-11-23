import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { adminQuery, closePool, seedStudio, userQuery, type SeededStudio } from "./helpers/harness";

// 0375 up / down / up on the shared test database. The down is EMERGENCY-ONLY: it destroys consent evidence and refuses while any stored
// photo row or pending storage deletion exists. This file replays the down and then the up, and always leaves the database at the migration
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

/** A refused down leaves its explicit transaction open and aborted on that connection; close it. */
async function runDown(): Promise<void> {
  try {
    await q(down);
  } catch (e) {
    await q("rollback").catch(() => undefined);
    throw e;
  }
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
  const w = await q(`select version, wording_sha256 from public.client_id_photo_wording_versions where version = 'v1.1'`);
  wording = { version: w[0].version, sha: w[0].wording_sha256 };
  await q(`select public.approve_client_id_photo_wording('v1.1')`);
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

describe("0375 up / down / up", () => {
  it("down REFUSES while a stored photo exists, destroying nothing", async () => {
    const { clientId } = await seedConsentAndPhoto();
    expect(await n(`select count(*)::int n from public.client_id_photos where client_id=$1`, [clientId])).toBe(1);
    await expect(runDown()).rejects.toThrow(/stored identification photos still exist/);
    expect(await tableCount()).toBe(7);
    expect((await functionNames()).size).toBe(21);
    expect(await n(`select count(*)::int n from public.client_id_photos where client_id=$1`, [clientId])).toBe(1);
    expect(await triggerCount()).toBe(2);
  });

  it("down REFUSES while a storage object is still queued for deletion, destroying nothing", async () => {
    // Remove every stored photo (the queue trigger queues each object), leaving only queued deletions behind.
    await q(`delete from public.client_id_photos`);
    expect(await n(`select count(*)::int n from public.client_id_photo_pending_object_deletions`)).toBeGreaterThan(0);
    await expect(runDown()).rejects.toThrow(/storage objects are still queued for deletion/);
    expect(await tableCount()).toBe(7);
    expect((await functionNames()).size).toBe(21);
  });

  it("with everything drained, down drops the seven tables, the twenty-one functions and both triggers, restores the setter's old grants, and up re-applies", async () => {
    await q(`delete from public.client_id_photos`);
    await q(`delete from public.client_id_photo_pending_object_deletions`);
    const consents = await n(`select count(*)::int n from public.client_id_photo_consents`);
    expect(consents, "there is consent evidence for the down to destroy").toBeGreaterThan(0);
    expect(await canRun("authenticated"), "0375 revoked the setter from every role").toBe(false);
    try {
      await runDown();
      expect(await tableCount()).toBe(0);
      expect((await functionNames()).size).toBe(0);
      expect(await triggerCount()).toBe(0);
      // Back to what 0231 left: authenticated only.
      expect(await canRun("authenticated")).toBe(true);
      expect(await canRun("anon")).toBe(false);
      expect(await canRun("service_role")).toBe(false);
      expect(await publicCanRun()).toBe(0);
    } finally {
      await q(up);
    }
    expect(await tableCount()).toBe(7);
    expect((await functionNames()).size).toBe(21);
    expect(await triggerCount()).toBe(2);
    // The setter is retired again, and the consent evidence did NOT survive the round trip (the file's warning is true).
    for (const role of ["authenticated", "anon", "service_role"]) expect(await canRun(role), role).toBe(false);
    expect(await publicCanRun()).toBe(0);
    expect(await n(`select count(*)::int n from public.client_id_photo_consents`)).toBe(0);
    const w = await q(`select approved_at from public.client_id_photo_wording_versions where version = 'v1.1'`);
    expect(w, "the wording is seeded again").toHaveLength(1);
    expect(w[0].approved_at, "and UNAPPROVED, as the migration seeds it").toBeNull();
  });
});
