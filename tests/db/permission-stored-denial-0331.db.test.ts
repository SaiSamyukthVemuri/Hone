import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, closePool, seedStudio } from "./helpers/harness";

// 0331 (Codex P2 on #1335): a stored DENIAL beats the new-studio default before its key is activated. Synthetic data only.
// 0287 is applied on hosted and frozen; 0331 replaces perm_base_scope and perm_scope_source. The negative control re-installs 0287's ORIGINAL
// bodies inside this file, shows the defect, then restores 0331's bodies, so one db reset proves both sides.

const body = (file: string, fn: string): string => {
  const src = readFileSync(file, "utf8");
  const i = src.indexOf(`create or replace function public.${fn}(`);
  expect(i, `${fn} in ${file}`).toBeGreaterThanOrEqual(0);
  return src.slice(i, src.indexOf("\n$$;", i) + 4);
};
const OLD = "supabase/migrations/0287_roles_permission_engine.sql";
const NEW = "supabase/migrations/0331_permission_stored_denial_before_default.sql";
const FNS = ["perm_base_scope", "perm_scope_source"] as const;
const install = async (file: string) => { for (const fn of FNS) await adminQuery(body(file, fn), []); };

let key = "";
let newDefault = "";
let saved: { released_at: string | null; release_tag: string; release_kind: string } | null = null;

beforeAll(async () => {
  const k = (await adminQuery(
    `select key, new_practitioner from public.permission_catalog
      where owner_configurable and offered_practitioner and gate_practitioner is null and requires = '{}' and new_practitioner <> 'off'
      order by key limit 1`, [])).rows[0];
  expect(k).toBeTruthy();
  key = k.key; newDefault = k.new_practitioner;
  saved = (await adminQuery("select released_at::text released_at, release_tag, release_kind from public.permission_key_release where key=$1", [key])).rows[0] ?? null;
});
afterAll(async () => {
  await install(NEW); // always leave 0331 installed
  await adminQuery("delete from public.permission_key_release where key=$1", [key]);
  if (saved) await adminQuery("insert into public.permission_key_release(key,released_at,release_tag,release_kind) values ($1,$2,$3,$4)", [key, saved.released_at, saved.release_tag, saved.release_kind]);
  await closePool();
});

const setup = async (label: string, storedAgeDays: number | null) => {
  const s = await seedStudio(label);
  await adminQuery("update public.studio_permission_policy set basis='new_studio', basis_at=now() where studio_id=$1", [s.studioId]);
  await adminQuery("delete from public.permission_key_release where key=$1", [key]);
  await adminQuery("insert into public.permission_key_release(key,released_at,release_tag,release_kind) values ($1, now() - interval '1 hour', 'T0331', 'full')", [key]);
  if (storedAgeDays !== null) {
    await adminQuery("insert into public.studio_role_permissions(studio_id,role,key,scope,set_at) values ($1,'practitioner',$2,'off', now() - ($3 || ' days')::interval)", [s.studioId, key, String(storedAgeDays)]);
  }
  return s;
};
const read = async (studioId: string) =>
  (await adminQuery("select public.perm_base_scope($1,'practitioner',$2) b, public.perm_scope_source($1,'practitioner',$2) src", [studioId, key])).rows[0];

describe("0331: a stored denial beats the new-studio default before activation", () => {
  it("with 0331 installed: a saved 'off' that pre-dates the release applies, and is reported as stored", async () => {
    await install(NEW);
    const s = await setup("d331a", 3);
    expect(await read(s.studioId)).toMatchObject({ b: "off", src: "stored" });
  });
  it("with 0331 installed: no stored value still gets the new-studio default (nothing else changed)", async () => {
    await install(NEW);
    const s = await setup("d331b", null);
    expect(await read(s.studioId)).toMatchObject({ b: newDefault, src: "default" });
  });
  it("NEGATIVE CONTROL, 0287's original bodies: the same studio gets the DEFAULT, which is the defect 0331 fixes", async () => {
    await install(OLD);
    try {
      const s = await setup("d331c", 3);
      const r = await read(s.studioId);
      expect(r.b).toBe(newDefault); // the denial is lost
      expect(r.src).not.toBe("stored");
    } finally {
      await install(NEW);
    }
  });
  it("privilege parity with 0287: neither helper is executable by public, anon, authenticated or service_role", async () => {
    for (const fn of FNS) {
      for (const role of ["anon", "authenticated", "service_role"]) {
        const r = await adminQuery(`select has_function_privilege($1, 'public.${fn}(uuid,text,text)', 'execute') p`, [role]);
        expect(r.rows[0].p, `${role} on ${fn}`).toBe(false);
      }
      const pub = await adminQuery(`select count(*)::int n from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        where p.oid = 'public.${fn}(uuid,text,text)'::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE'`, []);
      expect(pub.rows[0].n, `PUBLIC on ${fn}`).toBe(0);
    }
  });
});
