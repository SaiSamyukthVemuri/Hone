import { afterAll, describe, expect, it } from "vitest";

import {
  adminQuery,
  asUser,
  closePool,
  seedMember,
  seedStudio,
} from "./helpers/harness";

// 0273 — practitioner-scoped calendar display preferences. CI DB lane only;
// this file has not been run locally.

afterAll(async () => {
  await closePool();
});

const setPrefs = (userId: string, studioId: string, patch: unknown) =>
  asUser(userId, async (q) => {
    const r = await q(`select public.set_own_calendar_preferences($1,$2::jsonb) as id`, [
      studioId,
      JSON.stringify(patch),
    ]);
    return r.rows[0].id as string | null;
  });

const myRows = (userId: string) =>
  asUser(userId, async (q) => {
    const r = await q(
      `select time_format_override as tf, default_calendar_view as v, birthday_display as bd, birthday_color as bc
         from public.practitioner_calendar_preferences`,
    );
    return r.rows;
  });

describe("0273 · practitioner calendar preferences", () => {
  it("stores the caller's own choices against their own practitioner", async () => {
    const studio = await seedStudio("cp-own");
    const id = await setPrefs(studio.userId, studio.studioId, {
      time_format: "24h", default_view: "week", birthday_display: "hide", birthday_color: "blue",
    });
    expect(id).toBe(studio.practitionerId);
    expect(await myRows(studio.userId)).toEqual([{ tf: "24h", v: "week", bd: "hide", bc: "blue" }]);
  });

  it("applies a present key, clears a JSON null to the studio value, and leaves an absent key alone", async () => {
    const studio = await seedStudio("cp-patch");
    await setPrefs(studio.userId, studio.studioId, { time_format: "24h", default_view: "day" });
    await setPrefs(studio.userId, studio.studioId, { default_view: null, birthday_display: "show" });
    expect(await myRows(studio.userId)).toEqual([{ tf: "24h", v: null, bd: "show", bc: null }]);
  });

  it("never touches the studio-wide values", async () => {
    const studio = await seedStudio("cp-studio");
    const before = await adminQuery(
      `select time_format_preference, birthday_reminder_color from public.studios where id = $1`,
      [studio.studioId],
    );
    await setPrefs(studio.userId, studio.studioId, { time_format: "24h", birthday_color: "green" });
    const after = await adminQuery(
      `select time_format_preference, birthday_reminder_color from public.studios where id = $1`,
      [studio.studioId],
    );
    expect(after.rows).toEqual(before.rows);
  });

  it("isolates preferences: a colleague, the owner and another studio read zero rows", async () => {
    const studio = await seedStudio("cp-iso");
    const colleague = await seedMember(studio, "cp-colleague");
    await setPrefs(colleague.userId, studio.studioId, { time_format: "24h" });
    expect(await myRows(studio.userId)).toEqual([]);
    expect(await myRows(colleague.userId)).toHaveLength(1);
    const other = await seedStudio("cp-iso-other");
    expect(await myRows(other.userId)).toEqual([]);
  });

  it("returns NULL and writes nothing for a studio the caller is not an active member of", async () => {
    const studio = await seedStudio("cp-nm");
    const other = await seedStudio("cp-nm-other");
    expect(await setPrefs(other.userId, studio.studioId, { time_format: "24h" })).toBeNull();
    const n = await adminQuery(
      `select count(*)::int as n from public.practitioner_calendar_preferences where studio_id = $1`,
      [studio.studioId],
    );
    expect(n.rows[0].n).toBe(0);
  });

  it("refuses an empty patch, an unknown key, a bad value and a non-object, writing nothing", async () => {
    const studio = await seedStudio("cp-bad");
    for (const patch of [
      {}, [], null, "x",
      { nope: "x" },
      { time_format: "36h" }, { time_format: 24 }, { default_view: "year" },
      { birthday_display: "maybe" }, { birthday_color: "pink" },
      { time_format: "24h", nope: "x" },
    ]) {
      await expect(setPrefs(studio.userId, studio.studioId, patch)).rejects.toThrow();
    }
    expect(await myRows(studio.userId)).toEqual([]);
  });

  it("is unwritable through the table by every API role", async () => {
    const studio = await seedStudio("cp-tbl");
    await setPrefs(studio.userId, studio.studioId, { time_format: "24h" });
    for (const sql of [
      `insert into public.practitioner_calendar_preferences (practitioner_id, studio_id) values ('${studio.practitionerId}', '${studio.studioId}')`,
      `update public.practitioner_calendar_preferences set time_format_override = '12h'`,
      `delete from public.practitioner_calendar_preferences`,
    ]) {
      await expect(asUser(studio.userId, (q) => q(sql))).rejects.toThrow(/permission denied|row-level/i);
    }
    expect(await myRows(studio.userId)).toEqual([{ tf: "24h", v: null, bd: null, bc: null }]);
  });

  it("grants: no API role may write the table; only authenticated may select it or run the command", async () => {
    const rows = await adminQuery(
      `select r.rolname as role,
              has_function_privilege(r.oid, 'public.set_own_calendar_preferences(uuid,jsonb)', 'execute') as cmd,
              has_table_privilege(r.oid, 'public.practitioner_calendar_preferences', 'select') as sel,
              has_table_privilege(r.oid, 'public.practitioner_calendar_preferences', 'insert') as ins,
              has_table_privilege(r.oid, 'public.practitioner_calendar_preferences', 'update') as upd,
              has_table_privilege(r.oid, 'public.practitioner_calendar_preferences', 'delete') as del
         from pg_roles r where r.rolname in ('anon','authenticated','service_role') order by 1`,
    );
    const by = Object.fromEntries(rows.rows.map((r: Record<string, unknown>) => [r.role as string, r]));
    expect(by.anon).toMatchObject({ cmd: false, sel: false, ins: false, upd: false, del: false });
    expect(by.service_role).toMatchObject({ cmd: false, sel: false, ins: false, upd: false, del: false });
    expect(by.authenticated).toMatchObject({ cmd: true, sel: true, ins: false, upd: false, del: false });
    const pub = await adminQuery(
      `select p.proacl::text as acl from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'set_own_calendar_preferences'`,
    );
    for (const r of pub.rows) expect(r.acl).not.toMatch(/(^\{|,)=X/);
  });

  it("goes with the practitioner it belongs to", async () => {
    const studio = await seedStudio("cp-cascade");
    const colleague = await seedMember(studio, "cp-gone");
    await setPrefs(colleague.userId, studio.studioId, { time_format: "24h" });
    await adminQuery(`delete from public.practitioners where id = $1`, [colleague.practitionerId]);
    const n = await adminQuery(
      `select count(*)::int as n from public.practitioner_calendar_preferences where practitioner_id = $1`,
      [colleague.practitionerId],
    );
    expect(n.rows[0].n).toBe(0);
  });
});
