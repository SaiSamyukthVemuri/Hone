import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, asRole, asUser, closePool, seedMember, seedStudio, type SeededStudio } from "./helpers/harness";

// 0334 (I2): intake answers, signed consents and policy acknowledgements require membership AND clin.view_intake; the status-only projection
// intake_status_for_clients serves clin.view_intake_status OR clin.view_intake and never returns the answers. Synthetic data only. Three states per
// table (owner, KEYED practitioner, RESTRICTED practitioner), plus cross-studio, no-practitioner stranger, anon and service_role, PENDING (unchanged)
// versus ACTIVATED (enforced) keys, and a negative control that puts the old policy back.

const MIGRATION = readFileSync("supabase/migrations/0334_clinical_read_enforcement_intake_consent.sql", "utf8");
const POLICY_STMTS = MIGRATION.replace(/--[^\n]*/g, "").split(";").filter((s) => /alter policy/.test(s)).map((s) => `${s.trim()};`);
const KEYS = ["clin.view_intake", "clin.view_intake_status"] as const;
type Key = (typeof KEYS)[number];
const SECRET = "SYNTHETIC-INTAKE-ANSWER-0334";

let saved: Array<{ key: string; released_at: string | null; release_tag: string; release_kind: string }> = [];

async function setRelease(key: Key, released: boolean): Promise<void> {
  await adminQuery("delete from public.permission_key_release where key=$1", [key]);
  await adminQuery(
    "insert into public.permission_key_release(key,released_at,release_tag,release_kind) values ($1, $2, 'T0334', 'full')",
    [key, released ? "2000-01-01T00:00:00Z" : null],
  );
}
async function deny(studioId: string, key: Key): Promise<void> {
  await adminQuery(
    "insert into public.studio_role_permissions(studio_id,role,key,scope,set_at) values ($1,'practitioner',$2,'off', now()) on conflict (studio_id,role,key) do update set scope='off', set_at=now()",
    [studioId, key],
  );
}

type Fix = { s: SeededStudio; member: { userId: string; practitionerId: string }; formId: string; sigId: string; ackId: string };
async function seedIntake(label: string): Promise<Fix> {
  const s = await seedStudio(label);
  const member = await seedMember(s, `${label}m`);
  const formId = randomUUID();
  // an old reviewed form, a NEWER submitted form carrying the secret answer, and a still newer DELETED in-progress form (must not win)
  await adminQuery(
    "insert into public.client_intake_forms(studio_id, client_id, status, responses, created_at) values ($1,$2,'reviewed','{}'::jsonb, now() - interval '3 days')",
    [s.studioId, s.clientId],
  );
  await adminQuery(
    "insert into public.client_intake_forms(id, studio_id, client_id, status, responses, created_at) values ($1,$2,$3,'submitted',$4::jsonb, now() - interval '2 days')",
    [formId, s.studioId, s.clientId, JSON.stringify({ allergies: SECRET })],
  );
  await adminQuery(
    "insert into public.client_intake_forms(studio_id, client_id, status, responses, created_at, deleted_at) values ($1,$2,'in_progress','{}'::jsonb, now() - interval '1 day', now())",
    [s.studioId, s.clientId],
  );
  const tmplId = randomUUID();
  await adminQuery("insert into public.consent_form_templates(id, studio_id, title, body, version) values ($1,$2,'Synthetic consent','body',1)", [tmplId, s.studioId]);
  const sigId = randomUUID();
  await adminQuery(
    "insert into public.client_consent_signatures(id, studio_id, client_id, template_id, template_title_snapshot, template_body_snapshot, template_version, template_hash, signature_name) values ($1,$2,$3,$4,'Synthetic consent','body',1,'hash-0334','Synthetic Client')",
    [sigId, s.studioId, s.clientId, tmplId],
  );
  const appt = randomUUID();
  await adminQuery(
    "insert into public.appointments(id, studio_id, client_id, practitioner_id, starts_at, ends_at, duration_minutes, status) values ($1,$2,$3,$4, now(), now() + interval '1 hour', 60, 'confirmed')",
    [appt, s.studioId, s.clientId, s.practitionerId],
  );
  const ackId = randomUUID();
  await adminQuery(
    "insert into public.appointment_policy_acknowledgements(id, studio_id, appointment_id, client_id, action, policy_snapshot_hash) values ($1,$2,$3,$4,'cancel','policy-hash-0334')",
    [ackId, s.studioId, appt, s.clientId],
  );
  return { s, member, formId, sigId, ackId };
}

const TABLES: Array<[string, (f: Fix) => string]> = [
  ["client_intake_forms", (f) => f.formId],
  ["client_consent_signatures", (f) => f.sigId],
  ["appointment_policy_acknowledgements", (f) => f.ackId],
];
async function tableCounts(userId: string, f: Fix): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  await asUser(userId, async (q) => {
    for (const [t, id] of TABLES) out[t] = (await q(`select count(*)::int n from public.${t} where id=$1`, [id(f)])).rows[0].n;
  });
  return out;
}
const allTables = (n: number) => Object.fromEntries(TABLES.map(([t]) => [t, n]));

type Proj = { client_id: string; status: string; created_at: string };
async function project(userId: string, f: Fix, ids: string[] | null = null): Promise<Proj[]> {
  let rows: Proj[] = [];
  await asUser(userId, async (q) => {
    rows = (await q("select * from public.intake_status_for_clients($1::uuid, $2::uuid[])", [f.s.studioId, ids])).rows as Proj[];
  });
  return rows;
}

beforeAll(async () => {
  saved = (await adminQuery("select key, released_at::text released_at, release_tag, release_kind from public.permission_key_release where key = any($1)", [KEYS])).rows;
});
afterAll(async () => {
  for (const stmt of POLICY_STMTS) await adminQuery(stmt).catch(() => undefined); // leave the 0334 policies installed whatever a test did
  await adminQuery("delete from public.permission_key_release where key = any($1)", [KEYS]);
  for (const r of saved) {
    await adminQuery("insert into public.permission_key_release(key,released_at,release_tag,release_kind) values ($1,$2,$3,$4)", [r.key, r.released_at, r.release_tag, r.release_kind]);
  }
  await closePool();
});

describe("0334, ACTIVATED keys: membership AND clin.view_intake on the three content tables", () => {
  beforeAll(async () => { for (const k of KEYS) await setRelease(k, true); });

  it("keyed practitioner and owner read all three; a practitioner denied clin.view_intake reads ZERO rows of each (the owner of that studio is unaffected)", async () => {
    const f = await seedIntake("i334a");
    expect(await tableCounts(f.member.userId, f)).toEqual(allTables(1));
    expect(await tableCounts(f.s.userId, f)).toEqual(allTables(1));
    const r = await seedIntake("i334b");
    await deny(r.s.studioId, "clin.view_intake");
    expect(await tableCounts(r.member.userId, r)).toEqual(allTables(0));
    expect(await tableCounts(r.s.userId, r)).toEqual(allTables(1));
  });

  it("clin.view_intake_status does NOT open the content tables, and clin.view_intake alone does (independent keys)", async () => {
    const r = await seedIntake("i334c");
    await deny(r.s.studioId, "clin.view_intake");
    expect(await tableCounts(r.member.userId, r)).toEqual(allTables(0)); // status key still held
    const t = await seedIntake("i334d");
    await deny(t.s.studioId, "clin.view_intake_status");
    expect(await tableCounts(t.member.userId, t)).toEqual(allTables(1)); // answers key still held
  });

  it("a user of another studio, a user with NO practitioner row, anon, and a restricted member read zero; service_role still reads (background workflows)", async () => {
    const f = await seedIntake("i334e");
    const other = await seedIntake("i334f");
    expect(await tableCounts(other.member.userId, f)).toEqual(allTables(0));
    const strangerId = randomUUID();
    await adminQuery("insert into auth.users (id, email) values ($1,$2)", [strangerId, `i334-${strangerId.slice(0, 8)}@harness.local`]);
    expect(await tableCounts(strangerId, f)).toEqual(allTables(0));
    // anon either matches no policy (zero rows) or has no table privilege at all (I4, 0336, revokes the grants); both mean it reads nothing
    const anon = await asRole("anon", async (q) => {
      const o: Record<string, number> = {};
      for (const [t, id] of TABLES) {
        try { o[t] = (await q(`select count(*)::int n from public.${t} where id=$1`, [id(f)])).rows[0].n; } catch (e) { if (!/permission denied/i.test(String(e))) throw e; o[t] = 0; }
      }
      return o;
    });
    expect(anon).toEqual(allTables(0));
    const svc = await asRole("service_role", async (q) => {
      const o: Record<string, number> = {};
      for (const [t, id] of TABLES) o[t] = (await q(`select count(*)::int n from public.${t} where id=$1`, [id(f)])).rows[0].n;
      return o;
    });
    expect(svc).toEqual(allTables(1));
  });

  it("a restricted practitioner cannot UPDATE an intake row either (the UPDATE sees only rows the SELECT policy shows); a keyed one can", async () => {
    const r = await seedIntake("i334g");
    await deny(r.s.studioId, "clin.view_intake");
    await asUser(r.member.userId, async (q) => {
      const res = await q("update public.client_intake_forms set current_step = current_step where id=$1", [r.formId]);
      expect(res.rowCount).toBe(0);
    });
    const k = await seedIntake("i334h");
    await asUser(k.member.userId, async (q) => {
      const res = await q("update public.client_intake_forms set current_step = current_step where id=$1", [k.formId]);
      expect(res.rowCount).toBe(1);
    });
  });
});

describe("0334, PENDING keys: nothing changes for existing practitioners (the snapshot applies)", () => {
  it("with both keys unreleased, a practitioner still reads all three tables and the projection", async () => {
    for (const k of KEYS) await setRelease(k, false);
    const f = await seedIntake("i334p");
    expect(await tableCounts(f.member.userId, f)).toEqual(allTables(1));
    expect(await project(f.member.userId, f)).toHaveLength(1);
  });
});

describe("0334, the status projection", () => {
  beforeAll(async () => { for (const k of KEYS) await setRelease(k, true); });

  it("returns the newest NON-DELETED form per client: status and created_at, one row, and no answers column", async () => {
    const f = await seedIntake("i334s1");
    const rows = await project(f.member.userId, f);
    expect(rows).toHaveLength(1);
    expect(rows[0].client_id).toBe(f.s.clientId);
    expect(rows[0].status).toBe("submitted"); // the newer deleted in-progress form does not win; the older reviewed form does not either
    expect(Object.keys(rows[0]).sort()).toEqual(["client_id", "created_at", "status"]);
    expect(JSON.stringify(rows)).not.toContain(SECRET);
  });

  it("serves a status-only practitioner (answers key denied) who reads ZERO rows of the table; denied BOTH keys gets zero rows, not an error; the owner is served", async () => {
    const s = await seedIntake("i334s2");
    await deny(s.s.studioId, "clin.view_intake");
    expect(await tableCounts(s.member.userId, s)).toEqual(allTables(0));
    expect(await project(s.member.userId, s)).toHaveLength(1);
    await deny(s.s.studioId, "clin.view_intake_status");
    expect(await project(s.member.userId, s)).toEqual([]);
    expect(await project(s.s.userId, s)).toHaveLength(1);
  });

  it("answers-only practitioner (status key denied) is served: either key is enough", async () => {
    const t = await seedIntake("i334s3");
    await deny(t.s.studioId, "clin.view_intake_status");
    expect(await project(t.member.userId, t)).toHaveLength(1);
  });

  it("a client-id filter restricts the result; an id from another studio returns nothing; null means the whole studio", async () => {
    const f = await seedIntake("i334s4");
    const o = await seedIntake("i334s5");
    expect(await project(f.member.userId, f, [f.s.clientId])).toHaveLength(1);
    expect(await project(f.member.userId, f, [o.s.clientId])).toEqual([]);
    expect(await project(f.member.userId, f, [])).toEqual([]);
    expect(await project(f.member.userId, f, null)).toHaveLength(1);
  });

  it("a member of another studio, a stranger with no practitioner row, and a call naming an unknown studio get zero rows", async () => {
    const f = await seedIntake("i334s6");
    const o = await seedIntake("i334s7");
    expect(await project(o.member.userId, f)).toEqual([]);
    const strangerId = randomUUID();
    await adminQuery("insert into auth.users (id, email) values ($1,$2)", [strangerId, `i334s-${strangerId.slice(0, 8)}@harness.local`]);
    expect(await project(strangerId, f)).toEqual([]);
    await asUser(f.member.userId, async (q) => {
      expect((await q("select count(*)::int n from public.intake_status_for_clients($1::uuid, null)", [randomUUID()])).rows[0].n).toBe(0);
    });
  });

  it("an INACTIVE practitioner is served nothing (defence in depth: the key check already needs an active membership)", async () => {
    const f = await seedIntake("i334s8");
    expect(await project(f.member.userId, f)).toHaveLength(1);
    await adminQuery("update public.practitioners set active=false where id=$1", [f.member.practitionerId]);
    expect(await project(f.member.userId, f)).toEqual([]);
  });

  it("EXECUTE is authenticated only: anon and service_role are refused by name", async () => {
    const f = await seedIntake("i334s9");
    for (const role of ["anon", "service_role"] as const) {
      await expect(asRole(role, (q) => q("select * from public.intake_status_for_clients($1::uuid, null)", [f.s.studioId])), role).rejects.toThrow(/permission denied/i);
    }
    const priv = (await adminQuery(
      "select has_function_privilege('authenticated','public.intake_status_for_clients(uuid,uuid[])','execute') a, has_function_privilege('anon','public.intake_status_for_clients(uuid,uuid[])','execute') n, has_function_privilege('service_role','public.intake_status_for_clients(uuid,uuid[])','execute') s, has_function_privilege('public','public.intake_status_for_clients(uuid,uuid[])','execute') p",
    )).rows[0];
    expect(priv).toEqual({ a: true, n: false, s: false, p: false });
  });
});

describe("0334, negative control: the OLD membership-only policy leaks to a restricted practitioner", () => {
  it("puts the old client_intake_forms policy back, shows the leak, then the migration policy closes it again", async () => {
    for (const k of KEYS) await setRelease(k, true);
    const r = await seedIntake("i334n");
    await deny(r.s.studioId, "clin.view_intake");
    expect((await tableCounts(r.member.userId, r)).client_intake_forms).toBe(0);
    await adminQuery("alter policy client_intake_forms_member_select on public.client_intake_forms using (public.is_studio_member(studio_id))");
    try {
      expect((await tableCounts(r.member.userId, r)).client_intake_forms, "the old policy would leak the row").toBe(1);
    } finally {
      for (const stmt of POLICY_STMTS) await adminQuery(stmt);
    }
    expect((await tableCounts(r.member.userId, r)).client_intake_forms).toBe(0);
  });
});
