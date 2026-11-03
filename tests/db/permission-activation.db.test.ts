import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminQuery, asUser, closePool, seedMember, seedStudio, type SeededStudio } from "./helpers/harness";

// Activation rule (Sam, 3 Nov; held 0287). Synthetic values only.
// NOT RUN until the heavy slot is granted and 0287 has been applied to an owned isolated stack.

type J = Record<string, any>;
const GOOD = "Reviewed the front desk duties with the team";
const call = async (userId: string, sql: string, params: unknown[]): Promise<J> => asUser(userId, async (q) => (await q(sql, params)).rows[0].r as J);
const preview = (u: string, s: string) => call(u, "select public.preview_activation($1) as r", [s]);
const activate = (u: string, s: string, keys: string[] | null, v: number, reason: string | null = GOOD, confirmed = true) =>
  call(u, "select public.activate_released_permissions($1,$2::text[],$3,$4,$5) as r", [s, keys, v, reason, confirmed]);
const getp = (u: string, s: string) => call(u, "select public.get_role_permissions($1) as r", [s]);
const effMap = async (s: SeededStudio) =>
  (await adminQuery("select role, key, public.perm_effective_scope($1,role,key) as e from public.permission_catalog cross join (values ('practitioner'),('receptionist')) v(role) order by 1,2", [s.studioId])).rows;

let KEYS: { key: string; practitioner_new: string; practitioner_snap: string }[] = [];
let SAVED: { key: string; released_at: string; release_tag: string }[] = [];
afterAll(async () => {
  // Put the registry back exactly as found (other suites released every key long ago).
  await adminQuery("delete from public.permission_key_release where key = any($1)", [KEYS.map((k) => k.key)]);
  for (const r of SAVED) await adminQuery("insert into public.permission_key_release(key,released_at,release_tag) values ($1,$2,$3)", [r.key, r.released_at, r.release_tag]);
  await closePool();
});
beforeAll(async () => {
  // Practitioner-offered, owner-configurable keys with no prerequisite or gate, whose new-studio default differs from the snapshot.
  KEYS = (await adminQuery(
    `select key, new_practitioner as practitioner_new, snapshot_practitioner as practitioner_snap from public.permission_catalog
      where owner_configurable and offered_practitioner and gate_practitioner is null and requires = '{}' and new_practitioner <> snapshot_practitioner
      order by key limit 2`)).rows;
  expect(KEYS.length).toBe(2);
  SAVED = (await adminQuery("select key, released_at::text released_at, release_tag from public.permission_key_release where key = any($1)", [KEYS.map((k) => k.key)])).rows;
  await adminQuery("delete from public.permission_key_release where key = any($1)", [KEYS.map((k) => k.key)]);
});
const clearReleases = () => adminQuery("delete from public.permission_key_release where key = any($1)", [KEYS.map((k) => k.key)]);
const releaseNow = async (tag = "ACT-TEST") => { await clearReleases(); return adminQuery("insert into public.permission_key_release(key,released_at,release_tag) select unnest($1::text[]), now(), $2", [KEYS.map((k) => k.key), tag]); };
const dated = (s: SeededStudio, key: string, scope: string, ageDays: number) =>
  adminQuery("insert into public.studio_role_permissions(studio_id,role,key,scope,set_at) values ($1,'practitioner',$2,$3, now() - ($4 || ' days')::interval) on conflict (studio_id,role,key) do update set scope=excluded.scope, set_at=excluded.set_at", [s.studioId, key, scope, String(ageDays)]);

// Every case starts and ends with no release rows for the two test keys, so no case inherits (or leaks) another's registry state and a
// refusal case fails for the reason it names, not because of a duplicate-key error from a previous case.
beforeEach(() => clearReleases());
afterEach(() => clearReleases());

describe("activation rule", () => {
  it("Discard works: saving the snapshot value replaces an INACTIVE stored choice instead of reporting nothing_changed", async () => {
    const s = await seedStudio("act0");
    await adminQuery("update public.studio_permission_policy set basis='existing_snapshot' where studio_id=$1", [s.studioId]);
    const [k] = KEYS;
    await dated(s, k.key, k.practitioner_new, 3);
    await releaseNow();
    const g = await getp(s.userId, s.studioId);
    expect(g.roles.practitioner[k.key]).toMatchObject({ stored: k.practitioner_new, effective: k.practitioner_snap, source: "inactive_until_activated" });
    const r = await call(s.userId, "select public.save_role_permissions($1,$2,$3::jsonb,$4,$5) as r", [s.studioId, g.version, JSON.stringify({ practitioner: { [k.key]: k.practitioner_snap } }), GOOD, true]);
    expect(r.ok).toBe(true);
    expect((await adminQuery("select scope from public.studio_role_permissions where studio_id=$1 and role='practitioner' and key=$2", [s.studioId, k.key])).rows[0].scope).toBe(k.practitioner_snap);
    // saving the same value again is now a real no-op
    const g2 = await getp(s.userId, s.studioId);
    expect(await call(s.userId, "select public.save_role_permissions($1,$2,$3::jsonb,$4,$5) as r", [s.studioId, g2.version, JSON.stringify({ practitioner: { [k.key]: k.practitioner_snap } }), GOOD, true])).toMatchObject({ ok: false, code: "nothing_changed" });
  });

  it("storing an intended value before release is inert; inserting the release row alone changes NO effective access", async () => {
    const s = await seedStudio("act1");
    await adminQuery("update public.studio_permission_policy set basis='existing_snapshot' where studio_id=$1", [s.studioId]);
    const [k] = KEYS;
    await dated(s, k.key, k.practitioner_new, 3);
    const before = await effMap(s);
    expect(before.find((r) => r.role === "practitioner" && r.key === k.key)!.e).toBe(k.practitioner_snap);
    await releaseNow();
    expect(await effMap(s)).toEqual(before);
    expect((await getp(s.userId, s.studioId)).roles.practitioner[k.key]).toMatchObject({ stored: k.practitioner_new, effective: k.practitioner_snap, source: "inactive_until_activated" });
    await adminQuery("delete from public.permission_key_release where release_tag='ACT-TEST'");
  });

  it("an explicit owner activation changes exactly the previewed keys, and writes the activation rows and the audit row", async () => {
    const s = await seedStudio("act2");
    const m = await seedMember(s, "act2");
    await adminQuery("update public.studio_permission_policy set basis='existing_snapshot' where studio_id=$1", [s.studioId]);
    for (const k of KEYS) await dated(s, k.key, k.practitioner_new, 3);
    await releaseNow();
    const before = await effMap(s);
    const p = await preview(s.userId, s.studioId);
    expect(p.ok).toBe(true);
    expect(await effMap(s)).toEqual(before);
    expect(Number((await adminQuery("select count(*) n from public.permission_key_activation where studio_id=$1", [s.studioId])).rows[0].n)).toBe(0);
    const previewed = (p.changes.practitioner as J[]).map((c) => c.key).sort();
    expect(previewed).toEqual(KEYS.map((k) => k.key).sort());
    expect(p.affected.practitioner.count).toBeGreaterThan(0);

    // Insurance PY-1 applies to activation too: if the previewed result newly enables a sensitive key, an unconfirmed commit is refused.
    const sensitiveKeys: string[] = p.sensitive_keys ?? [];
    if (sensitiveKeys.includes(KEYS[0].key)) {
      expect(p.confirmation_required).toBe(true);
      expect(await activate(s.userId, s.studioId, [KEYS[0].key], p.version, GOOD, false)).toMatchObject({ ok: false, code: "sensitive_unconfirmed" });
      expect(await effMap(s)).toEqual(before);
    }
    const r = await activate(s.userId, s.studioId, [KEYS[0].key], p.version);
    expect(r.ok).toBe(true);
    const after = await effMap(s);
    const changed = after.filter((a, i) => a.e !== before[i].e).map((a) => `${a.role}:${a.key}`);
    expect(changed).toEqual([`practitioner:${KEYS[0].key}`]);
    expect((await adminQuery("select key, activated_by, policy_version from public.permission_key_activation where studio_id=$1", [s.studioId])).rows).toEqual([
      { key: KEYS[0].key, activated_by: s.userId, policy_version: String(r.new_version) },
    ]);
    const audit = (await adminQuery("select kind, reason, actor_user_id from public.permission_audit where studio_id=$1 and kind='permissions_activated'", [s.studioId])).rows;
    expect(audit.length).toBeGreaterThan(0);
    expect(audit[0]).toMatchObject({ reason: GOOD, actor_user_id: s.userId });
    expect(m.userId).toBeTruthy();
  });

  it("non-owners, other studios, stale versions, missing reasons and unreleased keys are refused", async () => {
    const s = await seedStudio("act3");
    const other = await seedStudio("act3b");
    const m = await seedMember(s, "act3");
    await releaseNow();
    const v = (await getp(s.userId, s.studioId)).version as number;
    expect(await activate(m.userId, s.studioId, [KEYS[0].key], v)).toMatchObject({ ok: false, code: "refused" });
    expect(await activate(other.userId, s.studioId, [KEYS[0].key], v)).toMatchObject({ ok: false, code: "refused" });
    expect(await preview(m.userId, s.studioId)).toMatchObject({ ok: false, code: "refused" });
    expect(await activate(s.userId, s.studioId, [KEYS[0].key], v + 5)).toMatchObject({ ok: false, code: "stale_version" });
    expect(await activate(s.userId, s.studioId, [KEYS[0].key], v, null)).toMatchObject({ ok: false, code: "reason_required" });
    expect(await activate(s.userId, s.studioId, ["no.such_key"], v)).toMatchObject({ ok: false, code: "unknown_key" });
    await adminQuery("delete from public.permission_key_release where key=$1", [KEYS[1].key]);
    expect(await activate(s.userId, s.studioId, [KEYS[1].key], v)).toMatchObject({ ok: false, code: "not_released" });
    expect(Number((await adminQuery("select count(*) n from public.permission_key_activation where studio_id=$1", [s.studioId])).rows[0].n)).toBe(0);
    await adminQuery("delete from public.permission_key_release where release_tag='ACT-TEST'");
  });

  it("a studio created AFTER a key's release takes the approved new-studio default; one created before does not until activation", async () => {
    const [k] = KEYS;
    await clearReleases();
    await adminQuery("insert into public.permission_key_release(key,released_at,release_tag) values ($1, now() - interval '1 hour', 'ACT-OLD')", [k.key]);
    const fresh = await seedStudio("act4");
    const m = await seedMember(fresh, "act4");
    expect(m.userId).toBeTruthy();
    expect((await adminQuery("select public.perm_effective_scope($1,'practitioner',$2) e", [fresh.studioId, k.key])).rows[0].e).toBe(k.practitioner_new);
    await adminQuery("update public.studio_permission_policy set basis_at = now() - interval '2 hours' where studio_id=$1", [fresh.studioId]);
    expect((await adminQuery("select public.perm_effective_scope($1,'practitioner',$2) e", [fresh.studioId, k.key])).rows[0].e).toBe(k.practitioner_snap);
    await adminQuery("delete from public.permission_key_release where release_tag='ACT-OLD'");
  });

  it("the release and activation tables are unreadable and unwritable by every API role", async () => {
    for (const t of ["permission_key_release", "permission_key_activation"])
      for (const role of ["anon", "authenticated", "service_role"]) {
        const r = await adminQuery("select has_table_privilege($1,$2,'select') or has_table_privilege($1,$2,'insert') or has_table_privilege($1,$2,'update') or has_table_privilege($1,$2,'delete') p", [role, `public.${t}`]);
        expect(r.rows[0].p, `${role} ${t}`).toBe(false);
      }
  });
});
