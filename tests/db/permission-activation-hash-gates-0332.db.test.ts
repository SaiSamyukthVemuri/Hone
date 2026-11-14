import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, asUser, closePool, seedStudio } from "./helpers/harness";

// 0332 (Codex P2 on #1340): the activation-preview fingerprint includes the operator ship gates. Synthetic data only.
// 0287 is applied on hosted and frozen; 0332 replaces perm_activation_hash. The negative control re-installs 0287's ORIGINAL body inside this
// file, shows the defect (a flipped gate leaves the fingerprint unchanged), then restores 0332's body: one db reset proves both sides.

type J = Record<string, any>;
const GOOD = "Reviewed the front desk duties with the team";
const call = async (userId: string, sql: string, params: unknown[]): Promise<J> => asUser(userId, async (q) => (await q(sql, params)).rows[0].r as J);
const body = (file: string): string => {
  const src = readFileSync(file, "utf8");
  const i = src.indexOf("create or replace function public.perm_activation_hash(");
  expect(i, file).toBeGreaterThanOrEqual(0);
  return src.slice(i, src.indexOf("\n$$;", i) + 4);
};
const OLD = "supabase/migrations/0287_roles_permission_engine.sql";
const NEW = "supabase/migrations/0332_permission_activation_hash_includes_gates.sql";
const install = async (file: string) => { await adminQuery(body(file), []); };
const hash = async (studio: string, key: string) => (await adminQuery("select public.perm_activation_hash($1,$2::text[]) h", [studio, [key]])).rows[0].h as string;

let key = "";
let gate = "";
let saved: { released_at: string | null; release_tag: string; release_kind: string } | null = null;

beforeAll(async () => {
  const k = (await adminQuery(
    `select key, coalesce(gate_receptionist, gate_practitioner) gate from public.permission_catalog
      where owner_configurable and (gate_receptionist is not null or gate_practitioner is not null) order by (key = 'appt.edit_notes') desc, key limit 1`, [])).rows[0];
  expect(k, "a catalog key that names a ship gate").toBeTruthy();
  key = k.key; gate = k.gate;
  saved = (await adminQuery("select released_at::text released_at, release_tag, release_kind from public.permission_key_release where key=$1", [key])).rows[0] ?? null;
});
afterAll(async () => {
  await install(NEW); // always leave 0332 installed
  await adminQuery("delete from public.permission_key_release where key=$1", [key]);
  if (saved) await adminQuery("insert into public.permission_key_release(key,released_at,release_tag,release_kind) values ($1,$2,$3,$4)", [key, saved.released_at, saved.release_tag, saved.release_kind]);
  await closePool();
});

const setup = async (label: string) => {
  const s = await seedStudio(label);
  await adminQuery("update public.studio_permission_policy set basis='existing_snapshot' where studio_id=$1", [s.studioId]);
  await adminQuery("delete from public.permission_key_release where key=$1", [key]);
  await adminQuery("insert into public.permission_key_release(key,released_at,release_tag,release_kind) values ($1, now() - interval '1 hour', 'T0332', 'full')", [key]);
  return s;
};
const setGate = (studioId: string, met: boolean) =>
  adminQuery("insert into public.permission_ship_gates(studio_id,gate,met) values ($1,$2,$3) on conflict (studio_id,gate) do update set met=excluded.met", [studioId, gate, met]);

describe("0332: the activation preview fingerprint covers the ship gates", () => {
  it("a gate flipped after the preview changes the fingerprint, and a commit with the old preview is refused as stale", async () => {
    await install(NEW);
    const s = await setup("g332a");
    await setGate(s.studioId, false);
    const v = (await call(s.userId, "select public.get_role_permissions($1) as r", [s.studioId])).version as number;
    const seen = (await call(s.userId, "select public.preview_activation($1,$2::text[]) as r", [s.studioId, [key]])).preview_hash as string;
    expect(seen).toBe(await hash(s.studioId, key));
    await setGate(s.studioId, true); // the operator flips the gate between preview and commit
    expect(await hash(s.studioId, key)).not.toBe(seen);
    const refused = await call(s.userId, "select public.activate_released_permissions($1,$2::text[],$3,$4,$5,true) as r", [s.studioId, [key], v, GOOD, seen]);
    expect(refused).toMatchObject({ ok: false, code: "stale_preview" });
    expect(Number((await adminQuery("select count(*) n from public.permission_key_activation where studio_id=$1", [s.studioId])).rows[0].n)).toBe(0);
    // A fresh preview after the flip commits.
    const fresh = (await call(s.userId, "select public.preview_activation($1,$2::text[]) as r", [s.studioId, [key]])).preview_hash as string;
    expect(fresh).not.toBe(seen);
  });
  it("an absent gate row and a gate set to false fingerprint the same (absent = not met, as the resolver reads it)", async () => {
    await install(NEW);
    const s = await setup("g332b");
    const absent = await hash(s.studioId, key);
    await setGate(s.studioId, false);
    expect(await hash(s.studioId, key)).toBe(absent);
  });
  it("NEGATIVE CONTROL, 0287's original body: a flipped gate leaves the fingerprint UNCHANGED, which is the defect 0332 fixes", async () => {
    await install(OLD);
    try {
      const s = await setup("g332c");
      await setGate(s.studioId, false);
      const before = await hash(s.studioId, key);
      await setGate(s.studioId, true);
      expect(await hash(s.studioId, key)).toBe(before);
    } finally {
      await install(NEW);
    }
  });
  it("privilege parity with 0287: not executable by public, anon, authenticated or service_role", async () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      const r = await adminQuery("select has_function_privilege($1, 'public.perm_activation_hash(uuid,text[])', 'execute') p", [role]);
      expect(r.rows[0].p, role).toBe(false);
    }
    const pub = await adminQuery(`select count(*)::int n from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where p.oid = 'public.perm_activation_hash(uuid,text[])'::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE'`, []);
    expect(pub.rows[0].n).toBe(0);
  });
});
