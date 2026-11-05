import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { releaseAllKeys } from "./helpers/permission-release";
import { adminQuery, asUser, closePool, seedStudio, type SeededStudio } from "./helpers/harness";

// 0287 (held), Codex P2 4476120256: a role reset deleted the stored choices but captured only the EFFECTIVE maps, so deleting a stored denial on a key
// that is not released yet (or pending activation) changed no effective scope and was invisible in the preview and in the audit. The reset now
// captures the stored choices before the delete, lists every removed one in the preview ('stored_removed') and writes the audit in the same per-key
// {stored, effective} shape a save writes. Synthetic values only. NOT RUN until the heavy slot is granted and 0287 is applied to an owned stack.

type J = Record<string, any>;
const GOOD_REASON = "Reset the front desk to the studio basis";
const KEY = "clin.view_records";
const call = (userId: string, sql: string, params: unknown[]): Promise<J> => asUser(userId, async (q) => (await q(sql, params)).rows[0].r as J);
const releaseRow = async () => (await adminQuery("select key, released_at::text released_at, release_tag, release_kind from public.permission_key_release where key=$1", [KEY])).rows[0] as J | undefined;
const store = (s: SeededStudio, scope: string) =>
  adminQuery(
    "insert into public.studio_role_permissions(studio_id,role,key,scope) values ($1,'practitioner',$2,$3) on conflict (studio_id,role,key) do update set scope=excluded.scope",
    [s.studioId, KEY, scope],
  );
async function studio(label: string): Promise<SeededStudio> {
  const s = await seedStudio(label);
  await adminQuery("update public.studio_permission_policy set basis='existing_snapshot' where studio_id=$1", [s.studioId]);
  return s;
}

let saved: J | undefined;
beforeAll(async () => {
  await releaseAllKeys();
  saved = await releaseRow();
});
afterAll(async () => {
  // put the release row back exactly as found, whatever a test did to it
  await adminQuery("delete from public.permission_key_release where key=$1", [KEY]);
  if (saved) await adminQuery("insert into public.permission_key_release(key,released_at,release_tag,release_kind) values ($1,$2,$3,$4)", [KEY, saved.released_at, saved.release_tag, saved.release_kind]);
  await closePool();
});

describe("a reset shows and records the stored choices it removes (Codex 4476120256)", () => {
  it("an UNRELEASED key: the stored Off changes no effective scope, yet the preview lists its removal and the audit records it", async () => {
    const s = await studio("rsa-unrel");
    await store(s, "off");
    await adminQuery("delete from public.permission_key_release where key=$1", [KEY]); // no release row: the stored Off is inert
    try {
      const pv = await call(s.userId, "select public.preview_reset($1,'practitioner') as r", [s.studioId]);
      expect(pv.ok).toBe(true);
      const removed = pv.stored_removed.practitioner.find((x: J) => x.key === KEY);
      expect(removed).toMatchObject({ key: KEY, stored: "off" });
      expect(removed.effective_before).toBe(removed.effective_after); // the very case the effective maps could not show
      expect(removed.effective_before).not.toBe("off"); // the Off was not in force
      expect(pv.changes.practitioner.some((c: J) => c.key === KEY)).toBe(false);

      const done = await call(s.userId, "select public.reset_role_to_defaults($1,'practitioner',$2,$3,true) as r", [s.studioId, pv.version, GOOD_REASON]);
      expect(done).toMatchObject({ ok: true });
      expect(done.stored_removed.practitioner.some((x: J) => x.key === KEY && x.stored === "off")).toBe(true);
      expect((await adminQuery("select count(*) n from public.studio_role_permissions where studio_id=$1 and key=$2", [s.studioId, KEY])).rows[0].n).toBe("0");

      const au = (await adminQuery("select before, after from public.permission_audit where studio_id=$1 and kind='role_reset'", [s.studioId])).rows;
      expect(au).toHaveLength(1);
      expect(au[0].before[KEY]).toEqual({ stored: "off", effective: removed.effective_before });
      expect(au[0].after[KEY]).toEqual({ stored: null, effective: removed.effective_after });
    } finally {
      if (saved) await adminQuery("insert into public.permission_key_release(key,released_at,release_tag,release_kind) values ($1,$2,$3,$4) on conflict (key) do update set released_at=excluded.released_at, release_tag=excluded.release_tag, release_kind=excluded.release_kind", [KEY, saved.released_at, saved.release_tag, saved.release_kind]);
    }
  });

  it("CONTROL: on a RELEASED key the same Off is in force; the reset lists it AND shows the effective change", async () => {
    const s = await studio("rsa-rel");
    await store(s, "off");
    const pv = await call(s.userId, "select public.preview_reset($1,'practitioner') as r", [s.studioId]);
    const removed = pv.stored_removed.practitioner.find((x: J) => x.key === KEY);
    expect(removed).toMatchObject({ stored: "off", effective_before: "off" });
    expect(removed.effective_after).not.toBe("off");
    expect(pv.changes.practitioner.some((c: J) => c.key === KEY)).toBe(true);
    const done = await call(s.userId, "select public.reset_role_to_defaults($1,'practitioner',$2,$3,true) as r", [s.studioId, pv.version, GOOD_REASON]);
    expect(done).toMatchObject({ ok: true });
    const au = (await adminQuery("select before, after from public.permission_audit where studio_id=$1 and kind='role_reset'", [s.studioId])).rows[0];
    expect(au.before[KEY]).toEqual({ stored: "off", effective: "off" });
    expect(au.after[KEY].stored).toBeNull();
    expect(au.after[KEY].effective).toBe(removed.effective_after);
  });

  it("keys that were neither stored nor changed are not in the audit images (same per-key shape as a save)", async () => {
    const s = await studio("rsa-only");
    await store(s, "off");
    const pv = await call(s.userId, "select public.preview_reset($1,'practitioner') as r", [s.studioId]);
    await call(s.userId, "select public.reset_role_to_defaults($1,'practitioner',$2,$3,true) as r", [s.studioId, pv.version, GOOD_REASON]);
    const au = (await adminQuery("select before, after from public.permission_audit where studio_id=$1 and kind='role_reset'", [s.studioId])).rows[0];
    expect(Object.keys(au.before)).toContain(KEY);
    for (const [k, v] of Object.entries<J>(au.before)) {
      expect(Object.keys(v).sort(), k).toEqual(["effective", "stored"]);
      expect(Object.keys(au.after[k] ?? {}).sort(), k).toEqual(["effective", "stored"]);
    }
    expect(Object.keys(au.before).sort()).toEqual(Object.keys(au.after).sort());
  });

  it("an adopt writes the per-key shape too, with stored unchanged on both sides", async () => {
    const s = await studio("rsa-adopt");
    await store(s, "off");
    const pv = await call(s.userId, "select public.preview_adopt_new_defaults($1) as r", [s.studioId]);
    expect(pv.ok).toBe(true);
    expect(pv.stored_removed).toEqual({ practitioner: [], receptionist: [] });
    const done = await call(s.userId, "select public.adopt_new_defaults($1,$2,$3,true) as r", [s.studioId, pv.version, GOOD_REASON]);
    expect(done).toMatchObject({ ok: true });
    const rows = (await adminQuery("select role, before, after from public.permission_audit where studio_id=$1 and kind='defaults_adopted'", [s.studioId])).rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      for (const [k, v] of Object.entries<J>(r.before)) {
        expect(Object.keys(v).sort(), k).toEqual(["effective", "stored"]);
        expect(r.after[k].stored, k).toBe(v.stored); // adopt never touches stored choices
      }
    }
  });
});
