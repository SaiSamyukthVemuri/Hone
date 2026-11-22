import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, asRole, asUser, closePool, seedMember, seedStudio } from "./helpers/harness";

// The access-event record (restore audit). Synthetic ids only. Each claim has a control that would fail if the record were missing or wrong:
//  * a real change in EITHER direction writes exactly one record (who, to whom, which action, which studio);
//  * a request that changes nothing writes none; a refusal writes none; the return values are exactly the ones the command always had;
//  * eight concurrent removals of the same member write ONE record (the row lock serialises them and the later ones find the value already changed);
//  * no API role can read or write the table; the command is still callable by the service role only.

afterAll(async () => {
  await closePool();
});

const setActive = async (studioId: string, actor: string, target: string, active: boolean | null): Promise<string> =>
  (await adminQuery("select public.set_practitioner_active_locked($1,$2,$3,$4) as r", [studioId, actor, target, active])).rows[0].r;
const events = async (studioId: string) =>
  (await adminQuery("select actor_practitioner_id a, target_practitioner_id t, action, studio_id s from public.practitioner_access_events where studio_id=$1 order by created_at, id", [studioId])).rows;

describe("practitioner_access_events: one record per real change, both directions", () => {
  it("remove then restore: two records, in order, with the owner as actor and the member as target", async () => {
    const A = await seedStudio("pae-both");
    const m = await seedMember(A, "pae-both-m");
    expect(await events(A.studioId)).toHaveLength(0);
    expect(await setActive(A.studioId, A.practitionerId, m.practitionerId, false)).toBe("ok");
    expect(await setActive(A.studioId, A.practitionerId, m.practitionerId, true)).toBe("ok");
    const rows = await events(A.studioId);
    expect(rows.map((r) => r.action)).toEqual(["removed", "restored"]);
    for (const r of rows) {
      expect(r.a).toBe(A.practitionerId);
      expect(r.t).toBe(m.practitionerId);
      expect(r.s).toBe(A.studioId);
    }
    expect((await adminQuery("select active from public.practitioners where id=$1", [m.practitionerId])).rows[0].active).toBe(true);
  });

  it("a request that changes nothing writes nothing (already removed; already active; null counts as false)", async () => {
    const A = await seedStudio("pae-noop");
    const m = await seedMember(A, "pae-noop-m");
    expect(await setActive(A.studioId, A.practitionerId, m.practitionerId, true)).toBe("ok"); // already active
    expect(await events(A.studioId)).toHaveLength(0);
    expect(await setActive(A.studioId, A.practitionerId, m.practitionerId, null)).toBe("ok"); // null = false: a real removal
    expect((await events(A.studioId)).map((r) => r.action)).toEqual(["removed"]);
    expect(await setActive(A.studioId, A.practitionerId, m.practitionerId, false)).toBe("ok"); // already removed
    expect(await setActive(A.studioId, A.practitionerId, m.practitionerId, null)).toBe("ok");
    expect(await events(A.studioId)).toHaveLength(1);
  });

  it("eight concurrent removals of the same member write exactly one record; eight concurrent restores afterwards write exactly one more", async () => {
    const A = await seedStudio("pae-conc");
    const m = await seedMember(A, "pae-conc-m");
    const r1 = await Promise.all(Array.from({ length: 8 }, () => setActive(A.studioId, A.practitionerId, m.practitionerId, false)));
    expect(r1.every((r) => r === "ok")).toBe(true);
    expect((await events(A.studioId)).map((r) => r.action)).toEqual(["removed"]);
    const r2 = await Promise.all(Array.from({ length: 8 }, () => setActive(A.studioId, A.practitionerId, m.practitionerId, true)));
    expect(r2.every((r) => r === "ok")).toBe(true);
    expect((await events(A.studioId)).map((r) => r.action)).toEqual(["removed", "restored"]);
  });

  it("refusals write nothing and return the same codes as before", async () => {
    const A = await seedStudio("pae-refuse");
    const B = await seedStudio("pae-refuse-b");
    const m = await seedMember(A, "pae-refuse-m");
    const m2 = await seedMember(A, "pae-refuse-m2");
    expect(await setActive(A.studioId, A.practitionerId, A.practitionerId, false)).toBe("cannot_modify_owner"); // self
    expect(await setActive(A.studioId, A.practitionerId, randomUUID(), false)).toBe("invalid_practitioner");
    expect(await setActive(A.studioId, A.practitionerId, B.practitionerId, false)).toBe("invalid_practitioner"); // another studio's owner
    const notOwner = await setActive(A.studioId, m.practitionerId, m2.practitionerId, false); // a member acting
    expect(notOwner).not.toBe("ok");
    expect(await events(A.studioId)).toHaveLength(0);
    expect(await events(B.studioId)).toHaveLength(0);
    expect((await adminQuery("select active from public.practitioners where id=$1", [m2.practitionerId])).rows[0].active).toBe(true);
  });

  it("the records of one studio are never written under another", async () => {
    const A = await seedStudio("pae-iso-a");
    const B = await seedStudio("pae-iso-b");
    const m = await seedMember(A, "pae-iso-m");
    await setActive(A.studioId, A.practitionerId, m.practitionerId, false);
    expect(await events(A.studioId)).toHaveLength(1);
    expect(await events(B.studioId)).toHaveLength(0);
  });
});

describe("practitioner_access_events: shape and privileges", () => {
  it("holds only ids, the action and the time (no name, email, client or free-text column)", async () => {
    const cols = (await adminQuery("select column_name from information_schema.columns where table_schema='public' and table_name='practitioner_access_events' order by column_name")).rows.map((r) => r.column_name);
    expect(cols).toEqual(["action", "actor_practitioner_id", "created_at", "id", "studio_id", "target_practitioner_id"]);
  });

  it("row level security is enabled and forced, and there is no policy", async () => {
    const t = (await adminQuery("select relrowsecurity r, relforcerowsecurity f from pg_class where oid='public.practitioner_access_events'::regclass")).rows[0];
    expect(t).toEqual({ r: true, f: true });
    expect(Number((await adminQuery("select count(*) n from pg_policies where schemaname='public' and tablename='practitioner_access_events'")).rows[0].n)).toBe(0);
  });

  it("anon, authenticated and public hold no privilege; the service role may only read", async () => {
    const privs = ["select", "insert", "update", "delete", "truncate", "references", "trigger"];
    for (const role of ["anon", "authenticated"]) {
      for (const p of privs) {
        const r = await adminQuery("select has_table_privilege($1, 'public.practitioner_access_events', $2) h", [role, p]);
        expect(r.rows[0].h, `${role} ${p}`).toBe(false);
      }
    }
    expect((await adminQuery("select has_table_privilege('service_role','public.practitioner_access_events','select') h")).rows[0].h).toBe(true);
    for (const p of ["insert", "update", "delete", "truncate"]) {
      expect((await adminQuery("select has_table_privilege('service_role','public.practitioner_access_events',$1) h", [p])).rows[0].h, `service_role ${p}`).toBe(false);
    }
  });

  it("a signed-in owner and a signed-in member are refused (42501) on read and on insert", async () => {
    const A = await seedStudio("pae-priv");
    const m = await seedMember(A, "pae-priv-m");
    await setActive(A.studioId, A.practitionerId, m.practitionerId, false);
    for (const userId of [A.userId, m.userId]) {
      await expect(asUser(userId, (q) => q("select * from public.practitioner_access_events"))).rejects.toMatchObject({ code: "42501" });
      await expect(
        asUser(userId, (q) => q("insert into public.practitioner_access_events (studio_id, action) values ($1,'removed')", [A.studioId])),
      ).rejects.toMatchObject({ code: "42501" });
    }
    await expect(asRole("anon", (q) => q("select * from public.practitioner_access_events"))).rejects.toMatchObject({ code: "42501" });
  });

  it("the command is callable by the service role only", async () => {
    const sig = "public.set_practitioner_active_locked(uuid,uuid,uuid,boolean)";
    for (const [role, want] of [["anon", false], ["authenticated", false], ["service_role", true]] as const) {
      expect((await adminQuery("select has_function_privilege($1, $2, 'execute') h", [role, sig])).rows[0].h, role).toBe(want);
    }
    const f = (await adminQuery("select prosecdef d, proconfig c, pg_get_userbyid(proowner) o from pg_proc where oid=$1::regprocedure", [sig])).rows[0];
    expect(f.d).toBe(true);
    expect(f.c).toEqual(["search_path=pg_catalog, pg_temp"]);
    expect(f.o).toBe("postgres");
  });
});
