import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { releaseAllKeys } from "./helpers/permission-release";
import { adminQuery, adminTx, asUser, closePool, seedMember, seedSession, seedStudio, type SeededStudio } from "./helpers/harness";

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

describe("0289: guard ordering, attribution cascade, revision images (Codex 113/159, Privacy AI2-AI5)", () => {
  it("edit OFF still refuses a note and a plan stage inserted with studio_id OMITTED (the guard runs after studio derivation)", async () => {
    const off = await setup("e89omit", "studio", "off");
    await expect(
      asUser(off.m.userId, (q) =>
        q("insert into public.client_clinical_notes (client_id, practitioner_id, kind, body) values ($1,$2,'consultation','Synthetic note')", [off.s.clientId, off.m.practitionerId])),
    ).rejects.toMatchObject({ code: "42501", message: expect.stringContaining("edit_records_required") });
    const planId = randomUUID();
    await adminQuery("insert into public.treatment_plans (id, client_id, studio_id, name, suggested_visit_count) values ($1,$2,$3,'Synthetic plan',4)", [planId, off.s.clientId, off.s.studioId]);
    await expect(
      asUser(off.m.userId, (q) =>
        q("insert into public.treatment_plan_stages (plan_id, how_often_unit, visit_length_minutes, stage_length_value, stage_length_unit) values ($1,'weekly',30,4,'weeks')", [planId])),
    ).rejects.toMatchObject({ code: "42501" });
    expect(Number((await adminQuery("select count(*) n from public.client_clinical_notes where client_id=$1", [off.s.clientId])).rows[0].n)).toBe(0);
    expect(Number((await adminQuery("select count(*) n from public.treatment_plan_stages where plan_id=$1", [planId])).rows[0].n)).toBe(0);
    // edit ON accepts the same omitted-studio inserts
    const on = await setup("e89omiton", "studio", "studio");
    await asUser(on.m.userId, (q) =>
      q("insert into public.client_clinical_notes (client_id, practitioner_id, kind, body) values ($1,$2,'consultation','Synthetic note')", [on.s.clientId, on.m.practitionerId]));
  });

  it("an ON practitioner cannot CLEAR created_by_practitioner_id; a real practitioner removal (FK set null) passes", async () => {
    const on = await setup("e89null", "studio", "studio");
    const id = randomUUID();
    await adminQuery("insert into public.treatment_plans (id, client_id, studio_id, name, suggested_visit_count, created_by_practitioner_id) values ($1,$2,$3,'Synthetic plan',4,$4)", [id, on.s.clientId, on.s.studioId, on.m.practitionerId]);
    await expect(
      asUser(on.m.userId, (q) => q("update public.treatment_plans set created_by_practitioner_id=null where id=$1", [id])),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      adminQuery("update public.treatment_plans set created_by_practitioner_id=null where id=$1", [id]),
    ).rejects.toMatchObject({ code: "55000" });
    expect((await adminQuery("select created_by_practitioner_id c from public.treatment_plans where id=$1", [id])).rows[0].c).toBe(on.m.practitionerId);
    // the real cascade: removing the practitioner row nulls the link and is not refused
    await adminQuery("delete from public.practitioners where id=$1", [on.m.practitionerId]);
    expect((await adminQuery("select created_by_practitioner_id c from public.treatment_plans where id=$1", [id])).rows[0].c).toBeNull();
  });

  it("revision images carry no price or payment column; a performer correction record never blocks deleting its session", async () => {
    const on = await setup("e89img", "studio", "studio");
    await adminQuery("update public.sessions set price_paid_cents = 12345 where id=$1", [on.sessionId]);
    await adminQuery("update public.sessions set next_session_note = 'Synthetic next' where id=$1", [on.sessionId]);
    const r = await revs("sessions", on.sessionId);
    expect(r.length).toBeGreaterThan(0);
    for (const x of r) for (const img of [x.before_image, x.after_image]) if (img) expect(Object.keys(img).filter((k) => /price|cents|paid|amount|payment/i.test(k))).toEqual([]);
    expect((await adminQuery("select count(*) n from pg_constraint where conrelid='public.session_performer_corrections'::regclass and contype='f'")).rows[0].n).toBe("0");
  });
});

describe("0289: every covered table, parity (Privacy AI7)", () => {
  const TABLES = ["sessions", "session_blocks", "session_block_areas", "electrolysis_entries", "laser_entries", "treatment_plans", "treatment_plan_stages", "client_clinical_notes"] as const;

  async function rows(label: string, view: string, edit: string) {
    const c = await setup(label, view, edit);
    const laserSession = randomUUID();
    await adminQuery("insert into public.sessions (id, studio_id, client_id, practitioner_id, modality) values ($1,$2,$3,$4,'laser')", [laserSession, c.s.studioId, c.s.clientId, c.s.practitionerId]);
    const ids: Record<string, string> = { sessions: c.sessionId, session_blocks: c.blockId };
    ids.session_block_areas = randomUUID();
    await adminQuery("insert into public.session_block_areas (id, studio_id, session_block_id, area, laterality, display_order) values ($1,$2,$3,'Chin','left',0)", [ids.session_block_areas, c.s.studioId, c.blockId]);
    ids.electrolysis_entries = randomUUID();
    await adminQuery("insert into public.electrolysis_entries (id, session_id, block_id, area) values ($1,$2,$3,'Chin')", [ids.electrolysis_entries, c.sessionId, c.blockId]);
    ids.laser_entries = randomUUID();
    await adminQuery("insert into public.laser_entries (id, session_id, zone) values ($1,$2,'upper lip')", [ids.laser_entries, laserSession]);
    ids.treatment_plans = randomUUID();
    await adminQuery("insert into public.treatment_plans (id, client_id, studio_id, name, suggested_visit_count) values ($1,$2,$3,'Synthetic plan',4)", [ids.treatment_plans, c.s.clientId, c.s.studioId]);
    ids.treatment_plan_stages = randomUUID();
    await adminQuery("insert into public.treatment_plan_stages (id, plan_id, studio_id, how_often_unit, visit_length_minutes, stage_length_value, stage_length_unit) values ($1,$2,$3,'weekly',30,4,'weeks')", [ids.treatment_plan_stages, ids.treatment_plans, c.s.studioId]);
    ids.client_clinical_notes = randomUUID();
    await adminQuery("insert into public.client_clinical_notes (id, client_id, studio_id, practitioner_id, kind, body) values ($1,$2,$3,$4,'consultation','Synthetic note')", [ids.client_clinical_notes, c.s.clientId, c.s.studioId, c.m.practitionerId]);
    return { c, ids };
  }
  // Runs as the signed-in member (auth.uid() set) but WITHOUT the authenticated role, so the table triggers are exercised on tables whose
  // direct DML is revoked from the API roles (the edit guard is the layer under test, not the grants).
  const asMember = (userId: string, fn: (q: (t: string, p?: unknown[]) => Promise<unknown>) => Promise<void>) =>
    adminTx(async (q) => {
      await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated" })]);
      await fn((t, p = []) => q(t, p));
    });
  const touch = (t: string, id: string) =>
    t === "sessions" ? ["update public.sessions set next_session_note = 'Synthetic' where id = $1", [id]] as const : [`update public.${t} set id = id where id = $1`, [id]] as const;

  it("edit OFF refuses a write to each of the eight chart tables; edit ON allows the same write", async () => {
    const off = await rows("e89t-off", "studio", "off");
    for (const t of TABLES) {
      const [sql, params] = touch(t, off.ids[t]);
      await expect(asMember(off.c.m.userId, async (q) => { await q(sql, [...params]); }), t).rejects.toMatchObject({ code: "42501" });
    }
    const on = await rows("e89t-on", "studio", "studio");
    for (const t of TABLES) {
      const [sql, params] = touch(t, on.ids[t]);
      await asMember(on.c.m.userId, async (q) => { await q(sql, [...params]); });
    }
  });

  it("scope resolves for every table, from the row alone, to the right studio and client", async () => {
    const { c, ids } = await rows("e89t-scope", "studio", "studio");
    for (const t of TABLES) {
      const r = (await adminQuery(`select (public.chart_scope($1, to_jsonb(x))).studio_id sid, (public.chart_scope($1, to_jsonb(x))).client_id cid from public.${t} x where x.id = $2`, [t, ids[t]])).rows[0];
      expect(r.sid, t).toBe(c.s.studioId);
      expect(r.cid, t).toBe(c.s.clientId);
    }
  });

  it("parity: the guard, the history writer and the revisions CHECK cover exactly the same eight tables (and the corrections table is append-only)", async () => {
    const trg = async (name: string) => (await adminQuery("select c.relname t from pg_trigger g join pg_class c on c.oid=g.tgrelid where g.tgname=$1 and not g.tgisinternal order by 1", [name])).rows.map((r) => r.t);
    expect(await trg("zz_chart_write_guard_trg")).toEqual([...TABLES].sort());
    expect(await trg("chart_revision_write_trg")).toEqual([...TABLES].sort());
    const check = (await adminQuery("select pg_get_constraintdef(oid) d from pg_constraint where conrelid='public.chart_revisions'::regclass and contype='c' and pg_get_constraintdef(oid) like '%table_name%'")).rows[0].d as string;
    for (const t of TABLES) expect(check, t).toContain(`'${t}'`);
    expect((check.match(/'[a-z_]+'/g) ?? []).length).toBe(TABLES.length);
    const ap = (await adminQuery("select count(*) n from pg_trigger where tgrelid='public.session_performer_corrections'::regclass and not tgisinternal")).rows[0].n;
    expect(Number(ap)).toBe(2);
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
    // The 0167 overwrite command now only makes the FIRST attribution: with edit ON it sets a NULL performer once...
    await asUser(on.m.userId, (q) => q("select public.set_session_performer($1,$2,$3)", [on.sessionId, on.s.clientId, on.m.practitionerId]));
    // ...and refuses any later change or clear, pointing at the correction command; with edit OFF it is refused by the edit-key guard.
    await expect(
      asUser(on.m.userId, (q) => q("select public.set_session_performer($1,$2,$3)", [on.sessionId, on.s.clientId, on.s.practitionerId])),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      asUser(off.m.userId, (q) => q("select public.set_session_performer($1,$2,$3)", [off.sessionId, off.s.clientId, off.m.practitionerId])),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      adminQuery("update public.sessions set performed_by_practitioner_id=$2 where id=$1", [on.sessionId, on.s.practitionerId]),
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
