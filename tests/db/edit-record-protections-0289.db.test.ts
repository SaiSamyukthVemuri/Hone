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
    // FINDING: no FK nulls this column today. 0179 replaced the original ON DELETE SET NULL with a composite ON DELETE RESTRICT, so a practitioner
    // who created a plan cannot be removed at all and the guard's cascade allowance is not reachable. It must still pass a genuine cascade if the
    // restriction is ever lifted: prove that in a rolled-back transaction that swaps in an ON DELETE SET NULL FK, removes the practitioner and
    // reads the nulled link.
    const rollback = new Error("rollback-sentinel");
    let seen: unknown = "unset";
    await expect(
      adminTx(async (q) => {
        await q("alter table public.treatment_plans drop constraint treatment_plans_created_by_same_studio_fk");
        await q("alter table public.treatment_plans add constraint tmp_created_by_set_null foreign key (created_by_practitioner_id) references public.practitioners(id) on delete set null");
        await q("delete from public.practitioners where id=$1", [on.m.practitionerId]);
        seen = ((await q("select created_by_practitioner_id c from public.treatment_plans where id=$1", [id])) as { rows: { c: unknown }[] }).rows[0].c;
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(seen).toBeNull();
    // and the refusal that exists today is the restricting FK, not the attribution guard
    await expect(adminQuery("delete from public.practitioners where id=$1", [on.m.practitionerId])).rejects.toMatchObject({ code: "23503" });
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
  // client_clinical_notes is append-only (its own trigger refuses any UPDATE before the edit guard is reached), so a note is exercised by INSERT.
  const touch = (t: string, id: string, c?: { s: SeededStudio; practitionerId: string }) =>
    t === "sessions" ? ["update public.sessions set next_session_note = 'Synthetic' where id = $1", [id]] as const
    : t === "client_clinical_notes" ? ["insert into public.client_clinical_notes (client_id, studio_id, practitioner_id, kind, body) values ($1,$2,$3,'consultation','Synthetic note')", [c!.s.clientId, c!.s.studioId, c!.practitionerId]] as const
    : [`update public.${t} set id = id where id = $1`, [id]] as const;

  it("edit OFF refuses a write to each of the eight chart tables; edit ON allows the same write", async () => {
    const off = await rows("e89t-off", "studio", "off");
    for (const t of TABLES) {
      const [sql, params] = touch(t, off.ids[t], { s: off.c.s, practitionerId: off.c.m.practitionerId });
      await expect(asMember(off.c.m.userId, async (q) => { await q(sql, [...params]); }), t).rejects.toMatchObject({ code: "42501" });
    }
    const on = await rows("e89t-on", "studio", "studio");
    for (const t of TABLES) {
      const [sql, params] = touch(t, on.ids[t], { s: on.c.s, practitionerId: on.c.m.practitionerId });
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

// Codex P1 4476158115: the edit guard authorised only the OLD row, so a practitioner who may edit studio A but not studio B could UPDATE a row from A
// into B (a plan stage to a plan in B, a session to B, ...) while changing clinical fields. The guard now also authorises the NEW scope.
describe("0289: a row cannot be moved into a studio where the caller may not edit (Codex 4476158115)", () => {
  // One signed-in user who is a practitioner in BOTH studios: edit ON in A, `editB` in B.
  async function twoStudios(label: string, editB: string) {
    const a = await setup(`${label}a`, "studio", "studio");
    const b = await seedStudio(`${label}b`);
    const bPractitioner = randomUUID();
    await adminQuery(
      "insert into public.practitioners (id, studio_id, user_id, display_name, email, role, active) values ($1,$2,$3,'Synthetic dual member',$4,'practitioner',true)",
      [bPractitioner, b.studioId, a.m.userId, `${label}-dual-${bPractitioner.slice(0, 8)}@harness.local`],
    );
    await adminQuery("update public.studio_permission_policy set basis='existing_snapshot' where studio_id=$1", [b.studioId]);
    await store(b, "clin.view_records", "studio");
    await store(b, "clin.edit_records", editB);
    const bSession = await seedSession(b);
    return { a, b, bSession, bPractitioner };
  }
  // Rows in studio A on the tables a user may UPDATE (client_clinical_notes is append-only: its own trigger refuses any UPDATE).
  async function rowsInA(a: Awaited<ReturnType<typeof setup>>) {
    const ids: Record<string, string> = { sessions: a.sessionId, session_blocks: a.blockId };
    ids.session_block_areas = randomUUID();
    await adminQuery("insert into public.session_block_areas (id, studio_id, session_block_id, area, laterality, display_order) values ($1,$2,$3,'Chin','left',0)", [ids.session_block_areas, a.s.studioId, a.blockId]);
    ids.electrolysis_entries = randomUUID();
    await adminQuery("insert into public.electrolysis_entries (id, session_id, block_id, area) values ($1,$2,$3,'Chin')", [ids.electrolysis_entries, a.sessionId, a.blockId]);
    const laserSession = randomUUID();
    await adminQuery("insert into public.sessions (id, studio_id, client_id, practitioner_id, modality) values ($1,$2,$3,$4,'laser')", [laserSession, a.s.studioId, a.s.clientId, a.s.practitionerId]);
    ids.laser_entries = randomUUID();
    await adminQuery("insert into public.laser_entries (id, session_id, zone) values ($1,$2,'upper lip')", [ids.laser_entries, laserSession]);
    ids.treatment_plans = randomUUID();
    await adminQuery("insert into public.treatment_plans (id, client_id, studio_id, name, suggested_visit_count) values ($1,$2,$3,'Synthetic plan',4)", [ids.treatment_plans, a.s.clientId, a.s.studioId]);
    // a plan WITHOUT stages, for the plan-move case (a plan that has stages cannot change studio at all: see the lineage tests)
    ids.treatment_plans_bare = randomUUID();
    await adminQuery("insert into public.treatment_plans (id, client_id, studio_id, name, suggested_visit_count) values ($1,$2,$3,'Synthetic bare plan',4)", [ids.treatment_plans_bare, a.s.clientId, a.s.studioId]);
    ids.treatment_plan_stages = randomUUID();
    await adminQuery("insert into public.treatment_plan_stages (id, plan_id, studio_id, how_often_unit, visit_length_minutes, stage_length_value, stage_length_unit) values ($1,$2,$3,'weekly',30,4,'weeks')", [ids.treatment_plan_stages, ids.treatment_plans, a.s.studioId]);
    return { ids, laserSession };
  }
  // Runs as the signed-in dual member (auth.uid() set), as the table owner so the triggers are the layer under test (see the parity test above).
  const asMember = (userId: string, fn: (q: (t: string, p?: unknown[]) => Promise<unknown>) => Promise<void>) =>
    adminTx(async (q) => {
      await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated" })]);
      await fn((t, p = []) => q(t, p));
    });

  it("a plan stage moved to a plan in a studio with edit OFF is refused, with a clinical change in the same UPDATE (the reported case)", async () => {
    const x = await twoStudios("e89mv1", "off");
    const { ids } = await rowsInA(x.a);
    const planB = randomUUID();
    await adminQuery("insert into public.treatment_plans (id, client_id, studio_id, name, suggested_visit_count) values ($1,$2,$3,'Synthetic plan B',4)", [planB, x.b.clientId, x.b.studioId]);
    // through the real API role and RLS: the policy only needs membership in both studios
    await expect(
      asUser(x.a.m.userId, (q) => q("update public.treatment_plan_stages set plan_id=$2, stage_length_value=9 where id=$1", [ids.treatment_plan_stages, planB])),
    ).rejects.toMatchObject({ code: "42501", message: expect.stringContaining("edit_records_required") });
    const row = (await adminQuery("select plan_id, studio_id, stage_length_value from public.treatment_plan_stages where id=$1", [ids.treatment_plan_stages])).rows[0];
    expect(row.studio_id).toBe(x.a.s.studioId);
    expect(row.stage_length_value).toBe(4);
    expect(row.plan_id).toBe(ids.treatment_plans);
  });

  it("NEGATIVE CONTROL: with edit ON in both studios the same move is allowed, so the refusal above is the guard and not some other constraint", async () => {
    const x = await twoStudios("e89mv2", "studio");
    const { ids } = await rowsInA(x.a);
    const planB = randomUUID();
    await adminQuery("insert into public.treatment_plans (id, client_id, studio_id, name, suggested_visit_count) values ($1,$2,$3,'Synthetic plan B',4)", [planB, x.b.clientId, x.b.studioId]);
    await asUser(x.a.m.userId, (q) => q("update public.treatment_plan_stages set plan_id=$2, stage_length_value=9 where id=$1", [ids.treatment_plan_stages, planB]));
    const row = (await adminQuery("select plan_id, studio_id, stage_length_value from public.treatment_plan_stages where id=$1", [ids.treatment_plan_stages])).rows[0];
    expect(row.plan_id).toBe(planB);
    expect(row.studio_id).toBe(x.b.studioId);
  });

  // Privacy EQ-1 and the lineage rule (OPS decision, 5 Nov). A stage and a treated area carry their OWN studio_id, derived from the plan / block only when
  // plan_id / session_block_id is written (0034, 0128), so before the lineage guard an UPDATE of studio_id ALONE left the child in studio B under a parent in
  // studio A. That was already possible in production (no FK, no RLS check, a trigger that fires only on `update of plan_id`); it is now refused for every
  // caller, on INSERT and UPDATE, whatever the edit key says.
  const LINEAGE = { code: "23514", message: expect.stringContaining("chart_lineage_mismatch") };
  for (const editB of ["off", "studio"] as const) {
    it(`LINEAGE (edit ${editB === "off" ? "OFF" : "ON"} in the destination): a stage moved by its studio_id ALONE is refused; an area is kept in its block's studio`, async () => {
      const x = await twoStudios(`e89ln${editB === "off" ? "0" : "1"}`, editB);
      const { ids } = await rowsInA(x.a);
      await expect(
        asMember(x.a.m.userId, async (q) => { await q("update public.treatment_plan_stages set studio_id=$2 where id=$1", [ids.treatment_plan_stages, x.b.studioId]); }),
      ).rejects.toMatchObject(LINEAGE);
      await expect(
        asUser(x.a.m.userId, (q) => q("update public.treatment_plan_stages set studio_id=$2 where id=$1", [ids.treatment_plan_stages, x.b.studioId])),
      ).rejects.toMatchObject(LINEAGE);
      // An area is protected twice: 0159 re-derives its studio on `update of studio_id` (so the write is corrected to the block's studio rather than refused),
      // and the lineage guard refuses any mismatch that gets past it. Either way the area cannot end up in another studio than its block.
      await asMember(x.a.m.userId, async (q) => { await q("update public.session_block_areas set studio_id=$2 where id=$1", [ids.session_block_areas, x.b.studioId]); });
      const st = (await adminQuery("select studio_id, plan_id from public.treatment_plan_stages where id=$1", [ids.treatment_plan_stages])).rows[0];
      expect(st).toMatchObject({ studio_id: x.a.s.studioId, plan_id: ids.treatment_plans });
      const ar = (await adminQuery("select studio_id, session_block_id from public.session_block_areas where id=$1", [ids.session_block_areas])).rows[0];
      expect(ar).toMatchObject({ studio_id: x.a.s.studioId, session_block_id: x.a.blockId });
    });

    it(`LINEAGE (edit ${editB === "off" ? "OFF" : "ON"}): the parent side, a plan that has stages cannot change studio and leave them behind (a block is already fixed by 0160)`, async () => {
      const x = await twoStudios(`e89lp${editB === "off" ? "0" : "1"}`, editB);
      const { ids } = await rowsInA(x.a);
      await expect(
        asMember(x.a.m.userId, async (q) => { await q("update public.treatment_plans set studio_id=$2, client_id=$3 where id=$1", [ids.treatment_plans, x.b.studioId, x.b.clientId]); }),
      ).rejects.toMatchObject(LINEAGE);
      expect((await adminQuery("select studio_id from public.treatment_plans where id=$1", [ids.treatment_plans])).rows[0].studio_id).toBe(x.a.s.studioId);
    });
  }

  it("LINEAGE NEGATIVE CONTROL: same-studio writes are allowed (an unchanged studio_id, a re-parent inside the studio, a spoofed INSERT corrected to the parent's studio)", async () => {
    const x = await twoStudios("e89ln2", "off");
    const { ids } = await rowsInA(x.a);
    // writing the studio the row already has is not a move
    await asMember(x.a.m.userId, async (q) => { await q("update public.treatment_plan_stages set studio_id=$2 where id=$1", [ids.treatment_plan_stages, x.a.s.studioId]); });
    await asMember(x.a.m.userId, async (q) => { await q("update public.session_block_areas set studio_id=$2, display_order=3 where id=$1", [ids.session_block_areas, x.a.s.studioId]); });
    // re-parenting a stage to another plan of the SAME studio (studio_id re-derived from the plan)
    await asUser(x.a.m.userId, (q) => q("update public.treatment_plan_stages set plan_id=$2, stage_length_value=9 where id=$1", [ids.treatment_plan_stages, ids.treatment_plans_bare]));
    const st = (await adminQuery("select studio_id, plan_id, stage_length_value from public.treatment_plan_stages where id=$1", [ids.treatment_plan_stages])).rows[0];
    expect(st).toMatchObject({ studio_id: x.a.s.studioId, plan_id: ids.treatment_plans_bare, stage_length_value: 9 });
    // a new stage / area that NAMES the other studio is stored under its parent's studio (the 0034 / 0128 derive triggers), never under the spoofed one
    const sid = randomUUID();
    await asUser(x.a.m.userId, (q) => q("insert into public.treatment_plan_stages (id, plan_id, studio_id, how_often_unit, visit_length_minutes, stage_length_value, stage_length_unit) values ($1,$2,$3,'weekly',30,4,'weeks')", [sid, ids.treatment_plans, x.b.studioId]));
    expect((await adminQuery("select studio_id from public.treatment_plan_stages where id=$1", [sid])).rows[0].studio_id).toBe(x.a.s.studioId);
    const aid = randomUUID();
    await asMember(x.a.m.userId, async (q) => { await q("insert into public.session_block_areas (id, studio_id, session_block_id, area, laterality, display_order) values ($1,$2,$3,'Lip','right',1)", [aid, x.b.studioId, x.a.blockId]); }); // areas: direct DML is revoked from the API roles (0169)
    expect((await adminQuery("select studio_id from public.session_block_areas where id=$1", [aid])).rows[0].studio_id).toBe(x.a.s.studioId);
  });

  it("every other chart table: a move into the edit-OFF studio is refused wherever the same move is possible with edit ON", async () => {
    const MOVES: Record<string, (x: Awaited<ReturnType<typeof twoStudios>>, ids: Record<string, string>) => readonly [string, unknown[]]> = {
      sessions: (x, ids) => ["update public.sessions set studio_id=$2, client_id=$3 where id=$1", [ids.sessions, x.b.studioId, x.b.clientId]],
      session_blocks: (x, ids) => ["update public.session_blocks set session_id=$2 where id=$1", [ids.session_blocks, x.bSession.sessionId]],
      session_block_areas: (x, ids) => ["update public.session_block_areas set session_block_id=$2, studio_id=$3 where id=$1", [ids.session_block_areas, x.bSession.blockId, x.b.studioId]],
      electrolysis_entries: (x, ids) => ["update public.electrolysis_entries set session_id=$2, block_id=$3 where id=$1", [ids.electrolysis_entries, x.bSession.sessionId, x.bSession.blockId]],
      laser_entries: (x, ids) => ["update public.laser_entries set session_id=$2 where id=$1", [ids.laser_entries, x.bSession.sessionId]],
      treatment_plans: (x, ids) => ["update public.treatment_plans set studio_id=$2, client_id=$3 where id=$1", [ids.treatment_plans_bare, x.b.studioId, x.b.clientId]],
    };
    const movable: string[] = [];
    // CONTROL first: edit ON in both studios, each move on its own fresh rows. Record which moves the schema allows at all.
    for (const [t, move] of Object.entries(MOVES)) {
      const x = await twoStudios(`e89mc${t.slice(0, 4)}`, "studio");
      const { ids } = await rowsInA(x.a);
      const [sql, params] = move(x, ids);
      try {
        await asMember(x.a.m.userId, async (q) => { await q(sql, params); });
        movable.push(t);
      } catch {
        /* this move is refused by another constraint even with edit ON: nothing for the guard to add */
      }
    }
    // The destination-scope check must hold on every move the schema allows.
    for (const t of movable) {
      const x = await twoStudios(`e89mr${t.slice(0, 4)}`, "off");
      const { ids } = await rowsInA(x.a);
      const [sql, params] = MOVES[t](x, ids);
      await expect(asMember(x.a.m.userId, async (q) => { await q(sql, params); }), t).rejects.toMatchObject({ code: "42501", message: expect.stringContaining("edit_records_required") });
    }
    // Pin the set, so a schema change that makes a table movable (or not) is a visible decision, not a silent gap.
    expect(movable.sort()).toEqual(EXPECTED_MOVABLE);
  });
});
// The moves the schema allows at all with edit ON in both studios (measured on a fresh 255|0289 stack). The others (sessions, session_blocks, entries)
// are refused by other constraints even then, so there is nothing for the guard to add; a schema change that moves this set must be a decision.
const EXPECTED_MOVABLE: string[] = ["session_block_areas", "treatment_plans"];
