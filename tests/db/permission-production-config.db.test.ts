import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, asUser, closePool, seedMember, seedStudio, type SeededStudio } from "./helpers/harness";

// Insurance AA-5: the engine in its PRODUCTION configuration. The release registry is put back to exactly what the migration seeds (every
// row PENDING, deny_only keys 'narrow'), WITHOUT releaseAllKeys, and restored afterwards. Synthetic values only.
// NOT RUN until the heavy slot is granted and 0287 has been applied to an owned isolated stack.

type J = Record<string, any>;
const GOOD = "Reviewed the front desk duties with the team";
const SEED: { key: string; kind: "full" | "narrow" }[] = [
  ...["appt.cancel", "appt.mark_no_show", "appt.edit_notes", "clin.view_records", "clin.view_photos", "clin.view_intake", "clin.view_aftercare", "clin.edit_records"].map((key) => ({ key, kind: "full" as const })),
  ...["appt.book", "appt.move", "appt.reassign", "avail.manage_own", "avail.manage_others", "avail.manage_studio_hours"].map((key) => ({ key, kind: "narrow" as const })),
];
const call = async (userId: string, sql: string, params: unknown[]): Promise<J> => asUser(userId, async (q) => (await q(sql, params)).rows[0].r as J);
const save = (u: string, s: string, v: number, changes: J, reason: string | null = GOOD) =>
  call(u, "select public.save_role_permissions($1,$2,$3::jsonb,$4,$5) as r", [s, v, JSON.stringify(changes), reason, true]);
const getp = (u: string, s: string) => call(u, "select public.get_role_permissions($1) as r", [s]);
const eff = async (s: SeededStudio, role: string, key: string) => (await adminQuery("select public.perm_effective_scope($1,$2,$3) e", [s.studioId, role, key])).rows[0].e as string;
const stored = (s: SeededStudio, key: string, scope: string, ageDays = 3) =>
  adminQuery("insert into public.studio_role_permissions(studio_id,role,key,scope,set_at) values ($1,'practitioner',$2,$3, now() - ($4 || ' days')::interval) on conflict (studio_id,role,key) do update set scope=excluded.scope, set_at=excluded.set_at", [s.studioId, key, scope, String(ageDays)]);
const snap = async (key: string) => (await adminQuery("select snapshot_practitioner s from public.permission_catalog where key=$1", [key])).rows[0].s as string;

let SAVED: J[] = [];
beforeAll(async () => {
  SAVED = (await adminQuery("select key, released_at::text released_at, release_tag, release_kind from public.permission_key_release")).rows;
  await adminQuery("delete from public.permission_key_release");
  for (const r of SEED) await adminQuery("insert into public.permission_key_release(key,released_at,release_tag,release_kind) values ($1,null,'R1-R2',$2)", [r.key, r.kind]);
});
afterAll(async () => {
  await adminQuery("delete from public.permission_key_release");
  for (const r of SAVED) await adminQuery("insert into public.permission_key_release(key,released_at,release_tag,release_kind) values ($1,$2,$3,$4)", [r.key, r.released_at, r.release_tag, r.release_kind]);
  await closePool();
});
const mark = (keys: string[], tag: string, kind = "full") => adminQuery("select public.mark_permissions_released($1::text[],$2,$3) n", [keys, tag, kind]);

describe("production configuration: releases are pending", () => {
  it("the observe key (appt.complete) has no release row and the seeded kinds match (checked before any case marks a key)", async () => {
    const rows = (await adminQuery("select key, release_kind, released_at from public.permission_key_release order by key")).rows;
    expect(rows.map((r) => r.key)).not.toContain("appt.complete");
    expect(rows.filter((r) => r.release_kind === "narrow").map((r) => r.key).sort()).toEqual(SEED.filter((r) => r.kind === "narrow").map((r) => r.key).sort());
  });

  it("clin.edit_records is seeded PENDING: an owner's Off has no effect, the chart stays editable, until the operator releases it", async () => {
    const s = await seedStudio("prod0e");
    await adminQuery("update public.studio_permission_policy set basis='existing_snapshot' where studio_id=$1", [s.studioId]);
    expect((await adminQuery("select release_kind, released_at from public.permission_key_release where key='clin.edit_records'")).rows[0]).toMatchObject({ release_kind: "full", released_at: null });
    await stored(s, "clin.edit_records", "off");
    expect(await eff(s, "practitioner", "clin.edit_records")).toBe(await snap("clin.edit_records"));
    expect((await getp(s.userId, s.studioId)).roles.practitioner["clin.edit_records"]).toMatchObject({ stored: "off", source: "unreleased" });
  });

  it("while pending, an owner's stored choice for a full key is inert and the practitioner keeps today's access", async () => {
    const s = await seedStudio("prod1");
    const m = await seedMember(s, "prod1");
    await adminQuery("update public.studio_permission_policy set basis='existing_snapshot' where studio_id=$1", [s.studioId]);
    await stored(s, "appt.cancel", "off");
    expect(await eff(s, "practitioner", "appt.cancel")).toBe(await snap("appt.cancel"));
    expect((await getp(s.userId, s.studioId)).roles.practitioner["appt.cancel"].source).toBe("unreleased");
    expect(m.userId).toBeTruthy();
  });

  it("marking a key released does NOT make an earlier stored choice active; it waits for the owner's activation", async () => {
    const s = await seedStudio("prod2");
    await adminQuery("update public.studio_permission_policy set basis='existing_snapshot' where studio_id=$1", [s.studioId]);
    await stored(s, "appt.mark_no_show", "off");
    await mark(["appt.mark_no_show"], "R1-R2", "full");
    expect(await eff(s, "practitioner", "appt.mark_no_show")).toBe(await snap("appt.mark_no_show"));
    expect((await getp(s.userId, s.studioId)).roles.practitioner["appt.mark_no_show"]).toMatchObject({ stored: "off", source: "inactive_until_activated" });
  });

  it("a pending narrow key ignores an owner's 'turn off' until it is released; a released narrow key applies a narrowing at once and holds a widening at the snapshot (AH1)", async () => {
    const s = await seedStudio("prod3");
    await adminQuery("update public.studio_permission_policy set basis='existing_snapshot' where studio_id=$1", [s.studioId]);
    const snapBook = await snap("appt.book");
    await stored(s, "appt.book", "off");
    expect(await eff(s, "practitioner", "appt.book")).toBe(snapBook); // still pending
    await mark(["appt.book"], "R1-R2", "narrow");
    expect(await eff(s, "practitioner", "appt.book")).toBe("off"); // narrowing applies at once, no activation
    // a widening beyond the snapshot stays at the snapshot
    await stored(s, "appt.book", "studio");
    expect(await eff(s, "practitioner", "appt.book")).toBe(snapBook);
    expect((await getp(s.userId, s.studioId)).roles.practitioner["appt.book"]).toMatchObject({ stored: "studio", effective: snapBook, source: "inactive_until_activated" });
  });

  it("a later FULL release under a new tag lets a widening take effect only after the owner activates it", async () => {
    const s = await seedStudio("prod4");
    await adminQuery("update public.studio_permission_policy set basis='existing_snapshot' where studio_id=$1", [s.studioId]);
    await mark(["appt.move"], "R1-R2", "narrow");
    await stored(s, "appt.move", "studio");
    const snapMove = await snap("appt.move");
    expect(await eff(s, "practitioner", "appt.move")).toBe(snapMove);
    await expect(mark(["appt.move"], "R1-R2", "full")).rejects.toThrow(/already_released/); // same tag
    await mark(["appt.move"], "R3", "full");
    await adminQuery("update public.studio_role_permissions set set_at = now() - interval '1 day' where studio_id=$1 and key='appt.move'", [s.studioId]);
    expect(await eff(s, "practitioner", "appt.move")).toBe(snapMove); // full release, not activated
    const v = (await getp(s.userId, s.studioId)).version as number;
    const hash = (await call(s.userId, "select public.preview_activation($1,$2::text[]) as r", [s.studioId, ["appt.move"]])).preview_hash;
    const r = await call(s.userId, "select public.activate_released_permissions($1,$2::text[],$3,$4,$5,true) as r", [s.studioId, ["appt.move"], v, GOOD, hash]);
    expect(r.ok).toBe(true);
    expect(await eff(s, "practitioner", "appt.move")).toBe("studio");
  });

  it("no API role can execute the operator command or read the release table", async () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      const r = await adminQuery("select has_function_privilege($1,'public.mark_permissions_released(text[],text,text)','execute') or has_function_privilege($1,'public.perm_activation_hash(uuid,text[])','execute') p", [role]);
      expect(r.rows[0].p, role).toBe(false);
    }
  });

  it("a release cannot be marked twice or downgraded; a bad kind or an empty list is refused", async () => {
    await expect(mark(["appt.cancel"], "X", "bogus")).rejects.toThrow();
    await mark(["appt.cancel"], "R1-R2", "full");
    await expect(mark(["appt.cancel"], "R9", "full")).rejects.toThrow(/already_released/);
    await expect(mark(["appt.cancel"], "R9", "narrow")).rejects.toThrow(/already_released/);
    await expect(mark([], "R9")).rejects.toThrow(/invalid_release/);
  });

  it("save refuses nothing it should accept: a pending key can still be saved (stored, inert) and an owner can Discard it", async () => {
    const s = await seedStudio("prod5");
    await adminQuery("update public.studio_permission_policy set basis='existing_snapshot' where studio_id=$1", [s.studioId]);
    const v0 = (await getp(s.userId, s.studioId)).version as number;
    const r = await save(s.userId, s.studioId, v0, { practitioner: { "clin.view_photos": "off" } });
    expect(r.ok).toBe(true);
    expect(await eff(s, "practitioner", "clin.view_photos")).toBe(await snap("clin.view_photos"));
  });
});
