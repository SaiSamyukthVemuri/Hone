import { afterAll, describe, expect, it } from "vitest";
import { CATALOG, type PermissionDef } from "@/lib/permissions/catalog";
import { adminQuery, asUser, closePool, seedMember, seedStudio } from "./helpers/harness";

// NQ-10 (Sam, 3 Nov): record editing REQUIRES record viewing. A saved clin.edit_records value is PRESERVED but INACTIVE while
// clin.view_records is off; it is never deleted and never re-enabled silently. Synthetic values only.
// NOT RUN until the heavy slot is granted and 0287 has been applied to an owned isolated stack.

const DEFS = CATALOG as readonly PermissionDef[];
const GOOD_REASON = "Reviewed the front desk duties with the team";
type J = Record<string, any>;
const call = async (userId: string, sql: string, params: unknown[]): Promise<J> => asUser(userId, async (q) => (await q(sql, params)).rows[0].r as J);
const getp = (u: string, s: string) => call(u, "select public.get_role_permissions($1) as r", [s]);
const save = (u: string, s: string, v: number | null, changes: J, reason: string | null = null, confirmed = false) =>
  call(u, "select public.save_role_permissions($1,$2,$3::jsonb,$4,$5) as r", [s, v, JSON.stringify(changes), reason, confirmed]);
const can = async (u: string, s: string, key: string) =>
  asUser(u, async (q) => (await q("select public.has_studio_permission($1,$2,null,null,null) as r", [s, key])).rows[0].r as boolean);
const rowCount = async (sql: string, p: unknown[]) => Number((await adminQuery(sql, p)).rows[0].n);

afterAll(async () => closePool());

describe("NQ-10: record editing requires record viewing (stored, but inactive while view is off)", () => {
  it("clin.edit_records stays STORED, resolves to off while clin.view_records is off, and returns when view returns", async () => {
    expect(DEFS.find((d) => d.key === "clin.edit_records")!.requires).toContain("clin.view_records");
    const s = await seedStudio("engine-nq10");
    const member = await seedMember(s, "nq10");
    const store = (key: string, scope: string) =>
      adminQuery("insert into public.studio_role_permissions(studio_id,role,key,scope) values ($1,'practitioner',$2,$3) on conflict (studio_id,role,key) do update set scope=excluded.scope", [s.studioId, key, scope]);
    await adminQuery("update public.studio_permission_policy set basis='existing_snapshot' where studio_id=$1", [s.studioId]);
    await store("clin.view_records", "studio");
    await store("clin.edit_records", "studio");
    expect(await can(member.userId, s.studioId, "clin.edit_records")).toBe(true);

    await store("clin.view_records", "off");
    const g = (await getp(s.userId, s.studioId)).roles.practitioner["clin.edit_records"];
    expect(g.stored).toBe("studio");
    expect(g.effective).toBe("off");
    expect(await can(member.userId, s.studioId, "clin.view_records")).toBe(false);
    expect(await can(member.userId, s.studioId, "clin.edit_records")).toBe(false);
    expect(await rowCount("select count(*) n from public.studio_role_permissions where studio_id=$1 and key='clin.edit_records' and scope='studio'", [s.studioId])).toBe(1);

    await store("clin.view_records", "studio");
    expect((await getp(s.userId, s.studioId)).roles.practitioner["clin.edit_records"].effective).toBe("studio");
    expect(await can(member.userId, s.studioId, "clin.edit_records")).toBe(true);
  });

  it("turning edit ON while view is off does not turn view on and names the prerequisite", async () => {
    const s = await seedStudio("engine-nq10b");
    await adminQuery("update public.studio_permission_policy set basis='existing_snapshot' where studio_id=$1", [s.studioId]);
    // Setup: the edit key's snapshot default is already "studio", so saving "studio" would be a no-op (nothing_changed) before the prerequisite
    // is judged. Store edit=off explicitly so that turning it on is a real change, and view=off so its prerequisite is unmet.
    for (const [key, scope] of [["clin.view_records", "off"], ["clin.edit_records", "off"]] as const) {
      await adminQuery("insert into public.studio_role_permissions(studio_id,role,key,scope) values ($1,'practitioner',$2,$3) on conflict (studio_id,role,key) do update set scope=excluded.scope", [s.studioId, key, scope]);
    }
    const ver = (await getp(s.userId, s.studioId)).version as number;
    const r = await save(s.userId, s.studioId, ver, { practitioner: { "clin.edit_records": "studio" } }, GOOD_REASON, true);
    expect(r).toMatchObject({ ok: false, code: "prerequisite_unmet", blocked_by: "clin.view_records" });
    expect((await getp(s.userId, s.studioId)).roles.practitioner["clin.view_records"].stored).toBe("off");
  });
});
