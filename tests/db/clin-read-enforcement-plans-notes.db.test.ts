import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, asRole, asUser, closePool, seedMember, seedSession, seedStudio, type SeededStudio } from "./helpers/harness";

// 0335 (I3): plans, goals, notes, pinned notes, snapshots and amendments require membership AND clin.view_records; personal notes need
// client.view_personal_notes; budget context needs client.view_budget; clinical_audit_events needs clin.view_records AND rep.audit_log_view.
// Synthetic data only. Per table: owner, KEYED practitioner, RESTRICTED practitioner; plus independent keys, PENDING (snapshot) vs ACTIVATED (enforced),
// a user with no practitioner row, another studio, anon and service_role, a one-SELECT-policy-per-table census, and a negative control.

const MIGRATION = readFileSync("supabase/migrations/0335_clinical_read_enforcement_plans_notes.sql", "utf8");
const POLICY_STMTS = MIGRATION.replace(/--[^\n]*/g, "").split(";").filter((s) => /alter policy/.test(s)).map((s) => `${s.trim()};`);
const KEYS = ["clin.view_records", "client.view_personal_notes", "client.view_budget", "rep.audit_log_view"] as const;
type Key = (typeof KEYS)[number];

let saved: Array<{ key: string; released_at: string | null; release_tag: string; release_kind: string }> = [];

async function setRelease(key: Key, released: boolean): Promise<void> {
  await adminQuery("delete from public.permission_key_release where key=$1", [key]);
  await adminQuery("insert into public.permission_key_release(key,released_at,release_tag,release_kind) values ($1, $2, 'T0335', 'full')", [key, released ? "2000-01-01T00:00:00Z" : null]);
}
async function setStored(studioId: string, key: Key, scope: "studio" | "off"): Promise<void> {
  await adminQuery(
    "insert into public.studio_role_permissions(studio_id,role,key,scope,set_at) values ($1,'practitioner',$2,$3, now()) on conflict (studio_id,role,key) do update set scope=$3, set_at=now()",
    [studioId, key, scope],
  );
}

type Fix = { s: SeededStudio; member: { userId: string; practitionerId: string }; ids: Record<string, string> };
const RECORDS = ["treatment_plans", "treatment_plan_stages", "treatment_goals", "client_clinical_notes", "client_pinned_notes", "clinical_record_snapshots", "clinical_record_amendments"] as const;
const OWN_KEY = { client_personal_notes: "client.view_personal_notes", client_budget_context: "client.view_budget" } as const;
const ALL_TABLES = [...RECORDS, "client_personal_notes", "client_budget_context", "clinical_audit_events"] as const;

async function withRetiredInsertOpen(table: string, f: () => Promise<void>): Promise<void> {
  await adminQuery(`alter table public.${table} disable trigger ${table}_retired_no_insert`);
  try { await f(); } finally { await adminQuery(`alter table public.${table} enable trigger ${table}_retired_no_insert`); }
}

async function seedPlans(label: string): Promise<Fix> {
  const s = await seedStudio(label);
  const member = await seedMember(s, `${label}m`);
  const { sessionId } = await seedSession(s);
  const ids: Record<string, string> = {};
  const id = () => randomUUID();
  ids.treatment_plans = id();
  await adminQuery("insert into public.treatment_plans (id, studio_id, client_id, name) values ($1,$2,$3,'Synthetic plan')", [ids.treatment_plans, s.studioId, s.clientId]);
  ids.treatment_plan_stages = id();
  await adminQuery(
    "insert into public.treatment_plan_stages (id, plan_id, studio_id, how_often_unit, visit_length_minutes, stage_length_value, stage_length_unit) values ($1,$2,$3,'weekly',30,4,'weeks')",
    [ids.treatment_plan_stages, ids.treatment_plans, s.studioId],
  );
  ids.treatment_goals = id();
  await adminQuery("insert into public.treatment_goals (id, studio_id, client_id, estimated_total_minutes) values ($1,$2,$3,120)", [ids.treatment_goals, s.studioId, s.clientId]);
  ids.client_clinical_notes = (await adminQuery(
    "insert into public.client_clinical_notes (client_id, studio_id, practitioner_id, kind, body) values ($1,$2,$3,'consultation','synthetic note') returning id",
    [s.clientId, s.studioId, s.practitionerId],
  )).rows[0].id;
  ids.client_pinned_notes = (await adminQuery(
    "insert into public.client_pinned_notes (client_id, studio_id, text, created_by_practitioner_id) values ($1,$2,'synthetic pin',$3) returning id",
    [s.clientId, s.studioId, s.practitionerId],
  )).rows[0].id;
  ids.client_personal_notes = id();
  await adminQuery("insert into public.client_personal_notes (id, studio_id, client_id) values ($1,$2,$3)", [ids.client_personal_notes, s.studioId, s.clientId]);
  ids.client_budget_context = (await adminQuery(
    "insert into public.client_budget_context (client_id, studio_id, budget_level, budget_notes, updated_by_practitioner_id) values ($1,$2,'somewhat_limited','synthetic',$3) returning client_id",
    [s.clientId, s.studioId, s.practitionerId],
  )).rows[0].client_id; // client_budget_context is keyed by client_id and has no id column (T-1)
  // the retired ledgers: rows can only be created with the retirement INSERT guard briefly disabled (as the owner), exactly like the production legacy row
  await withRetiredInsertOpen("clinical_record_snapshots", async () => {
    ids.clinical_record_snapshots = (await adminQuery(
      "insert into public.clinical_record_snapshots (studio_id, session_id, version_no, snapshot, content_hash, finalized_by, finalized_at, signed) values ($1,$2,1,'{}'::jsonb,$3,$4, now(), true) returning id",
      [s.studioId, sessionId, "h0335" + sessionId.replace(/-/g, "").slice(0, 24), s.practitionerId],
    )).rows[0].id;
  });
  await withRetiredInsertOpen("clinical_record_amendments", async () => {
    ids.clinical_record_amendments = (await adminQuery(
      "insert into public.clinical_record_amendments (studio_id, session_id, applies_to_snapshot_id, amendment_type, reason, body, authored_by, content_hash) values ($1,$2,$3,'late_note','synthetic','synthetic',$4,$5) returning id",
      [s.studioId, sessionId, ids.clinical_record_snapshots, s.practitionerId, "a0335" + sessionId.replace(/-/g, "").slice(0, 24)],
    )).rows[0].id;
  });
  await withRetiredInsertOpen("clinical_audit_events", async () => {
    ids.clinical_audit_events = (await adminQuery(
      "insert into public.clinical_audit_events (studio_id, session_id, operation_type, actor_practitioner_id) values ($1,$2,'correction',$3) returning id",
      [s.studioId, sessionId, s.practitionerId],
    )).rows[0].id;
  });
  return { s, member, ids };
}

async function counts(userId: string, f: Fix, tables: readonly string[] = ALL_TABLES): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  await asUser(userId, async (q) => {
    for (const t of tables) out[t] = (await q(`select count(*)::int n from public.${t} where ${keyCol(t)}=$1`, [f.ids[t]])).rows[0].n;
  });
  return out;
}
// the row key column: client_budget_context has no id column, its primary key is client_id (T-1)
const keyCol = (t: string) => (t === "client_budget_context" ? "client_id" : "id");
const only = (tables: readonly string[], n: number) => Object.fromEntries(tables.map((t) => [t, n]));
const expectedFor = (readable: readonly string[]) => Object.fromEntries(ALL_TABLES.map((t) => [t, readable.includes(t) ? 1 : 0]));

beforeAll(async () => {
  saved = (await adminQuery("select key, released_at::text released_at, release_tag, release_kind from public.permission_key_release where key = any($1)", [KEYS])).rows;
});
afterAll(async () => {
  for (const stmt of POLICY_STMTS) await adminQuery(stmt).catch(() => undefined);
  await adminQuery("delete from public.permission_key_release where key = any($1)", [KEYS]);
  for (const r of saved) {
    await adminQuery("insert into public.permission_key_release(key,released_at,release_tag,release_kind) values ($1,$2,$3,$4)", [r.key, r.released_at, r.release_tag, r.release_kind]);
  }
  await closePool();
});

describe("0335, policy census: exactly ONE policy can grant SELECT on each table (a leftover membership-only policy would OR the gate away)", () => {
  it("each table has one SELECT/ALL policy, `authenticated` only, whose qual names clin_key_studios", async () => {
    for (const t of ALL_TABLES) {
      const r = await adminQuery(
        "select policyname, roles::text roles, cmd, qual from pg_policies where schemaname='public' and tablename=$1 and cmd in ('SELECT','ALL') and permissive='PERMISSIVE'",
        [t],
      );
      expect(r.rows.length, `${t}: ${JSON.stringify(r.rows.map((x: { policyname: string }) => x.policyname))}`).toBe(1);
      expect(r.rows[0].roles, t).toBe("{authenticated}");
      expect(r.rows[0].qual, t).toMatch(/clin_key_studios/);
    }
  });
});

describe("0335, ACTIVATED keys: membership AND the key", () => {
  beforeAll(async () => { for (const k of KEYS) await setRelease(k, true); });

  it("keyed practitioner reads every table except the audit events (rep.audit_log_view is Off for practitioners by default); the owner reads all ten", async () => {
    const f = await seedPlans("i335a");
    expect(await counts(f.member.userId, f)).toEqual(expectedFor([...RECORDS, "client_personal_notes", "client_budget_context"]));
    expect(await counts(f.s.userId, f)).toEqual(only(ALL_TABLES, 1));
  });

  it("clinical_audit_events needs BOTH keys: records without the audit key reads zero, the audit key without records reads zero, both reads one", async () => {
    const both = await seedPlans("i335b");
    await setStored(both.s.studioId, "rep.audit_log_view", "studio");
    expect((await counts(both.member.userId, both, ["clinical_audit_events"])).clinical_audit_events).toBe(1);
    const auditOnly = await seedPlans("i335c");
    await setStored(auditOnly.s.studioId, "rep.audit_log_view", "studio");
    await setStored(auditOnly.s.studioId, "clin.view_records", "off");
    expect((await counts(auditOnly.member.userId, auditOnly, ["clinical_audit_events"])).clinical_audit_events).toBe(0);
    const recordsOnly = await seedPlans("i335d");
    expect((await counts(recordsOnly.member.userId, recordsOnly, ["clinical_audit_events"])).clinical_audit_events).toBe(0);
  });

  it("clin.view_records denied: ZERO rows on the seven record tables (and the audit events); personal notes and budget are independent and still read; the owner is unaffected", async () => {
    const r = await seedPlans("i335e");
    await setStored(r.s.studioId, "clin.view_records", "off");
    expect(await counts(r.member.userId, r)).toEqual(expectedFor(["client_personal_notes", "client_budget_context"]));
    expect(await counts(r.s.userId, r)).toEqual(only(ALL_TABLES, 1));
  });

  it("client.view_personal_notes and client.view_budget are independent of each other and of clin.view_records", async () => {
    const p = await seedPlans("i335f");
    await setStored(p.s.studioId, "client.view_personal_notes", "off");
    expect(await counts(p.member.userId, p)).toEqual(expectedFor([...RECORDS, "client_budget_context"]));
    const b = await seedPlans("i335g");
    await setStored(b.s.studioId, "client.view_budget", "off");
    expect(await counts(b.member.userId, b)).toEqual(expectedFor([...RECORDS, "client_personal_notes"]));
  });

  it("another studio's member, a user with NO practitioner row, anon and an inactive practitioner read zero; service_role still reads", async () => {
    const f = await seedPlans("i335h");
    const other = await seedPlans("i335i");
    expect(await counts(other.member.userId, f)).toEqual(only(ALL_TABLES, 0));
    const strangerId = randomUUID();
    await adminQuery("insert into auth.users (id, email) values ($1,$2)", [strangerId, `i335-${strangerId.slice(0, 8)}@harness.local`]);
    expect(await counts(strangerId, f)).toEqual(only(ALL_TABLES, 0));
    // One transaction per table (T-2): a 42501 aborts the transaction it happens in.
    const anon: Record<string, number> = {};
    for (const t of ALL_TABLES) {
      anon[t] = await asRole("anon", async (q) => {
        try { return (await q(`select count(*)::int n from public.${t} where ${keyCol(t)}=$1`, [f.ids[t]])).rows[0].n as number; } catch (e) { if (!/permission denied/i.test(String(e))) throw e; return 0; }
      });
    }
    expect(anon).toEqual(only(ALL_TABLES, 0));
    const svc = await asRole("service_role", async (q) => {
      const o: Record<string, number> = {};
      for (const t of ALL_TABLES) o[t] = (await q(`select count(*)::int n from public.${t} where ${keyCol(t)}=$1`, [f.ids[t]])).rows[0].n;
      return o;
    });
    expect(svc).toEqual(only(ALL_TABLES, 1));
    await adminQuery("update public.practitioners set active=false where id=$1", [f.member.practitionerId]);
    expect(await counts(f.member.userId, f)).toEqual(only(ALL_TABLES, 0));
  });
});

describe("0335, PENDING keys: existing practitioners are unchanged (the snapshot applies), except the audit events (snapshot Off)", () => {
  it("with all four keys unreleased, a practitioner reads the nine unchanged tables, and the owner reads all ten", async () => {
    for (const k of KEYS) await setRelease(k, false);
    const f = await seedPlans("i335p");
    expect(await counts(f.member.userId, f)).toEqual(expectedFor([...RECORDS, "client_personal_notes", "client_budget_context"]));
    expect(await counts(f.s.userId, f)).toEqual(only(ALL_TABLES, 1));
  });
});

describe("0335, writes that depend on reading", () => {
  beforeAll(async () => { for (const k of KEYS) await setRelease(k, true); });

  it("a restricted practitioner cannot add a pinned note and read it back (INSERT ... RETURNING needs the SELECT policy); a keyed one can", async () => {
    const r = await seedPlans("i335w1");
    await setStored(r.s.studioId, "clin.view_records", "off");
    await asUser(r.member.userId, async (q) => {
      await expect(q("insert into public.client_pinned_notes (client_id, studio_id, text, created_by_practitioner_id) values ($1,$2,'x',$3) returning id", [r.s.clientId, r.s.studioId, r.member.practitionerId])).rejects.toMatchObject({ code: "42501" });
    });
    const k = await seedPlans("i335w2");
    await asUser(k.member.userId, async (q) => {
      const res = await q("insert into public.client_pinned_notes (client_id, studio_id, text, created_by_practitioner_id) values ($1,$2,'x',$3) returning id", [k.s.clientId, k.s.studioId, k.member.practitionerId]);
      expect(res.rows).toHaveLength(1);
    });
  });

  it("INVOKER trigger: a restricted practitioner cannot supersede a clinical note (the trigger reads the old note under the caller's policy); a keyed one can", async () => {
    const insertSuper = (f: Fix) => asUser(f.member.userId, (q) =>
      q("insert into public.client_clinical_notes (client_id, studio_id, practitioner_id, kind, body, supersedes_note_id) values ($1,$2,$3,'consultation','revised',$4)", [f.s.clientId, f.s.studioId, f.member.practitionerId, f.ids.client_clinical_notes]));
    const k = await seedPlans("i335w3");
    await expect(insertSuper(k)).resolves.toBeDefined();
    const r = await seedPlans("i335w4");
    await setStored(r.s.studioId, "clin.view_records", "off");
    await expect(insertSuper(r)).rejects.toThrow(/supersedes_note_id .* not found/);
  });
});

describe("0335, negative control: the OLD membership-only policy leaks to a restricted practitioner", () => {
  it("puts the old client_pinned_notes policy back, shows the leak, then the migration policy closes it again", async () => {
    for (const k of KEYS) await setRelease(k, true);
    const r = await seedPlans("i335n");
    await setStored(r.s.studioId, "clin.view_records", "off");
    expect((await counts(r.member.userId, r, ["client_pinned_notes"])).client_pinned_notes).toBe(0);
    await adminQuery("alter policy client_pinned_notes_studio_member_read on public.client_pinned_notes using (studio_id in (select studio_id from public.practitioners where user_id = auth.uid() and active = true))");
    try {
      expect((await counts(r.member.userId, r, ["client_pinned_notes"])).client_pinned_notes, "the old policy would leak the row").toBe(1);
    } finally {
      for (const stmt of POLICY_STMTS) await adminQuery(stmt);
    }
    expect((await counts(r.member.userId, r, ["client_pinned_notes"])).client_pinned_notes).toBe(0);
  });
});
