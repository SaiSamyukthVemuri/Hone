import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { releaseAllKeys } from "./helpers/permission-release";
import { adminQuery, asUser, closePool, seedMember, seedSession, seedStudio, type SeededStudio } from "./helpers/harness";

// 0289 (HELD, NQ-11/12): edit-key choke point, append-only chart history, attribution immutability, performer correction.
// Synthetic values only. NOT RUN until the heavy slot is granted and 0287 + 0289 are applied to an owned isolated stack.

beforeAll(async () => releaseAllKeys());
afterAll(async () => closePool());

const store = (s: SeededStudio, key: string, scope: string) =>
  adminQuery(
    "insert into public.studio_role_permissions(studio_id,role,key,scope) values ($1,'practitioner',$2,$3) on conflict (studio_id,role,key) do update set scope=excluded.scope",
    [s.studioId, key, scope],
  );

async function setup(label: string, view: string, edit: string) {
  const s = await seedStudio(label);
  const m = await seedMember(s, label);
  await adminQuery("update public.studio_permission_policy set basis='existing_snapshot' where studio_id=$1", [s.studioId]);
  await store(s, "clin.view_records", view);
  await store(s, "clin.edit_records", edit);
  return { s, m, ...(await seedSession(s)) };
}
const insertPlan = (userId: string, s: SeededStudio) =>
  asUser(userId, async (q) =>
    q("insert into public.treatment_plans (client_id, studio_id, name, suggested_visit_count) values ($1,$2,'Synthetic plan',4) returning id", [s.clientId, s.studioId]),
  );
const correct = (userId: string, sessionId: string, clientId: string, performer: string | null, reason: string) =>
  asUser(userId, async (q) => (await q("select public.correct_session_performer($1,$2,$3,$4) as r", [sessionId, clientId, performer, reason])).rows[0].r as boolean);
const revs = async (table: string, id: string) =>
  (await adminQuery("select op, changed_by, before_image, after_image from public.chart_revisions where table_name=$1 and row_id=$2 order by id", [table, id])).rows;

describe("0289: edit key at the database", () => {
  it("edit OFF refuses a direct plan write (42501 edit_records_required), edit ON allows it and records history", async () => {
    const off = await setup("e89off", "studio", "off");
    await expect(insertPlan(off.m.userId, off.s)).rejects.toMatchObject({ code: "42501", message: expect.stringContaining("edit_records_required") });
    expect(Number((await adminQuery("select count(*) n from public.treatment_plans where studio_id=$1", [off.s.studioId])).rows[0].n)).toBe(0);

    const on = await setup("e89on", "studio", "studio");
    const id = (await insertPlan(on.m.userId, on.s)).rows[0].id as string;
    const r = await revs("treatment_plans", id);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ op: "insert", changed_by: on.m.userId, before_image: null });
  });

  it("edit ON but view OFF is refused (NQ-10: the engine caps edit by view)", async () => {
    const v = await setup("e89view", "off", "studio");
    await expect(insertPlan(v.m.userId, v.s)).rejects.toMatchObject({ code: "42501" });
  });

  it("another studio's member is refused", async () => {
    const a = await setup("e89xa", "studio", "studio");
    const b = await setup("e89xb", "studio", "studio");
    await expect(insertPlan(b.m.userId, a.s)).rejects.toBeTruthy();
  });

  it("a removal (update of a plan) keeps its before-image; history rows cannot be changed or deleted", async () => {
    const on = await setup("e89rem", "studio", "studio");
    const id = (await insertPlan(on.m.userId, on.s)).rows[0].id as string;
    await asUser(on.m.userId, (q) => q("update public.treatment_plans set status='closed' where id=$1", [id]));
    const r = await revs("treatment_plans", id);
    expect(r.map((x) => x.op)).toEqual(["insert", "update"]);
    expect(r[1].before_image.status).toBe("active");
    expect(r[1].after_image.status).toBe("closed");
    await expect(adminQuery("update public.chart_revisions set op='insert' where row_id=$1", [id])).rejects.toMatchObject({ code: "55000" });
    await expect(adminQuery("delete from public.chart_revisions where row_id=$1", [id])).rejects.toMatchObject({ code: "55000" });
    await expect(adminQuery("truncate public.chart_revisions")).rejects.toMatchObject({ code: "55000" });
  });

  it("attribution on a plan cannot be rewritten", async () => {
    const on = await setup("e89attr", "studio", "studio");
    const id = randomUUID();
    await adminQuery("insert into public.treatment_plans (id, client_id, studio_id, name, suggested_visit_count, created_by_practitioner_id) values ($1,$2,$3,'Synthetic plan',4,$4)", [id, on.s.clientId, on.s.studioId, on.m.practitionerId]);
    await expect(
      adminQuery("update public.treatment_plans set created_by_practitioner_id=$2 where id=$1", [id, on.s.practitionerId]),
    ).rejects.toMatchObject({ code: "55000" });
  });
});

describe("0289: performer correction replaces the overwrite", () => {
  it("edit ON: corrects, preserves the original in history, records who/when/why", async () => {
    const t = await setup("e89cor", "studio", "studio");
    const original = (await adminQuery("select performed_by_practitioner_id p from public.sessions where id=$1", [t.sessionId])).rows[0].p as string | null;
    expect(await correct(t.m.userId, t.sessionId, t.s.clientId, t.m.practitionerId, "Entered under the wrong name")).toBe(true);
    const now = (await adminQuery("select performed_by_practitioner_id p from public.sessions where id=$1", [t.sessionId])).rows[0].p;
    expect(now).toBe(t.m.practitionerId);
    const c = (await adminQuery("select previous_performer_id, new_performer_id, corrected_by, reason from public.session_performer_corrections where session_id=$1", [t.sessionId])).rows;
    expect(c).toEqual([{ previous_performer_id: original, new_performer_id: t.m.practitionerId, corrected_by: t.m.userId, reason: "Entered under the wrong name" }]);
    const r = await revs("sessions", t.sessionId);
    expect(r.at(-1)!.before_image.performed_by_practitioner_id).toBe(original);
    expect(await correct(t.m.userId, t.sessionId, t.s.clientId, t.m.practitionerId, "Same again")).toBe(false);
  });

  it("refuses without edit, without a real reason, for a stranger, and the old overwrite command is gone for end users", async () => {
    const off = await setup("e89cof", "studio", "off");
    await expect(correct(off.m.userId, off.sessionId, off.s.clientId, off.m.practitionerId, "A real reason")).rejects.toMatchObject({ code: "42501" });
    const on = await setup("e89con", "studio", "studio");
    await expect(correct(on.m.userId, on.sessionId, on.s.clientId, on.m.practitionerId, "  n/a ")).rejects.toMatchObject({ code: "22023" });
    await expect(correct(on.m.userId, on.sessionId, on.s.clientId, on.s.practitionerId, "")).rejects.toMatchObject({ code: "22023" });
    await expect(
      asUser(on.m.userId, (q) => q("select public.set_session_performer($1,$2,$3)", [on.sessionId, on.s.clientId, on.m.practitionerId])),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      adminQuery("update public.sessions set performed_by_practitioner_id=$2 where id=$1", [on.sessionId, on.m.practitionerId]),
    ).rejects.toMatchObject({ code: "55000" });
  });
});

describe("0289: privileges (anon, authenticated and service_role named explicitly)", () => {
  it("helpers are not executable by any API role; only the correction command is, by authenticated", async () => {
    const fns = ["chart_revisions_append_only()", "chart_scope(text,jsonb)", "chart_write_guard()", "chart_revision_write()", "chart_attribution_guard()"];
    for (const f of fns)
      for (const role of ["anon", "authenticated", "service_role"]) {
        const r = await adminQuery("select has_function_privilege($1, $2, 'execute') ok", [role, `public.${f}`]);
        expect(r.rows[0].ok, `${role} ${f}`).toBe(false);
      }
    const sig = "public.correct_session_performer(uuid,uuid,uuid,text)";
    for (const [role, want] of [["anon", false], ["service_role", false], ["authenticated", true]] as const)
      expect((await adminQuery("select has_function_privilege($1, $2, 'execute') ok", [role, sig])).rows[0].ok, role).toBe(want);
    for (const t of ["chart_revisions", "session_performer_corrections"])
      for (const [role, priv, want] of [["anon", "select", false], ["authenticated", "insert", false], ["authenticated", "update", false], ["authenticated", "select", true]] as const)
        expect((await adminQuery("select has_table_privilege($1, $2, $3) ok", [role, `public.${t}`, priv])).rows[0].ok, `${role} ${priv} ${t}`).toBe(want);
  });
});
