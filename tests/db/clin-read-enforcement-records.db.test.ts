import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, asRole, asUser, closePool, seedMember, seedSession, seedStudio, type SeededStudio } from "./helpers/harness";

// 0333 (I1): the treatment-record SELECT policies require membership AND the permission key (clin.view_records / clin.view_photos).
// Synthetic data only. Three states are proved per table: owner, KEYED practitioner, RESTRICTED practitioner; plus cross-studio, anon,
// service-role, receptionist, PENDING key (unchanged) and ACTIVATED key (enforced), and a negative control that puts the old policy back.

const MIGRATION = readFileSync("supabase/migrations/0333_clinical_read_enforcement_records.sql", "utf8");
const KEYS = ["clin.view_records", "clin.view_photos"] as const;
type Key = (typeof KEYS)[number];

let saved: Array<{ key: string; released_at: string | null; release_tag: string; release_kind: string }> = [];

async function setRelease(key: Key, released: boolean): Promise<void> {
  await adminQuery("delete from public.permission_key_release where key=$1", [key]);
  await adminQuery(
    "insert into public.permission_key_release(key,released_at,release_tag,release_kind) values ($1, $2, 'T0333', 'full')",
    [key, released ? "2000-01-01T00:00:00Z" : null],
  );
}
async function deny(studioId: string, key: Key): Promise<void> {
  await adminQuery(
    "insert into public.studio_role_permissions(studio_id,role,key,scope,set_at) values ($1,'practitioner',$2,'off', now()) on conflict (studio_id,role,key) do update set scope='off', set_at=now()",
    [studioId, key],
  );
}

type Fix = { s: SeededStudio; member: { userId: string; practitionerId: string }; sessionId: string; blockId: string };
async function seedClinical(label: string): Promise<Fix> {
  const s = await seedStudio(label);
  const member = await seedMember(s, `${label}m`);
  const { sessionId, blockId } = await seedSession(s);
  await adminQuery("insert into public.electrolysis_entries(session_id, area) values ($1,'lip')", [sessionId]);
  await adminQuery("insert into public.laser_entries(session_id, zone) values ($1,'leg')", [sessionId]);
  await adminQuery("insert into public.session_audit(session_id, field) values ($1,'note')", [sessionId]);
  await adminQuery("insert into public.photos(studio_id, client_id, session_id, storage_path) values ($1,$2,$3,'synthetic/p.jpg')", [s.studioId, s.clientId, sessionId]);
  await adminQuery(
    "insert into public.treatment_images(studio_id, client_id, session_id, storage_path, content_type, size_bytes) select $1::uuid, $2::uuid, $3::uuid, $1::uuid::text || '/' || $2::uuid::text || '/t.jpg','image/jpeg',10",
    [s.studioId, s.clientId, sessionId],
  );
  return { s, member, sessionId, blockId };
}

// table -> the predicate that scopes a count to ONE fixture
const RECORD_TABLES: Array<[string, (f: Fix) => [string, unknown]]> = [
  ["sessions", (f) => ["id = $1", f.sessionId]],
  ["session_blocks", (f) => ["session_id = $1", f.sessionId]],
  ["electrolysis_entries", (f) => ["session_id = $1", f.sessionId]],
  ["laser_entries", (f) => ["session_id = $1", f.sessionId]],
  ["session_audit", (f) => ["session_id = $1", f.sessionId]],
];
const PHOTO_TABLES: Array<[string, (f: Fix) => [string, unknown]]> = [
  ["photos", (f) => ["studio_id = $1", f.s.studioId]],
  ["treatment_images", (f) => ["studio_id = $1", f.s.studioId]],
];

async function counts(userId: string, tables: typeof RECORD_TABLES, f: Fix): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  await asUser(userId, async (q) => {
    for (const [t, where] of tables) {
      const [pred, val] = where(f);
      out[t] = (await q(`select count(*)::int n from public.${t} where ${pred}`, [val])).rows[0].n;
    }
  });
  return out;
}
const all = (tables: typeof RECORD_TABLES, n: number) => Object.fromEntries(tables.map(([t]) => [t, n]));

beforeAll(async () => {
  saved = (await adminQuery("select key, released_at::text released_at, release_tag, release_kind from public.permission_key_release where key = any($1)", [KEYS])).rows;
});
afterAll(async () => {
  await adminQuery("delete from public.permission_key_release where key = any($1)", [KEYS]);
  for (const r of saved) {
    await adminQuery("insert into public.permission_key_release(key,released_at,release_tag,release_kind) values ($1,$2,$3,$4)", [r.key, r.released_at, r.release_tag, r.release_kind]);
  }
  await closePool();
});

describe("0333, ACTIVATED keys: membership AND the key", () => {
  let f: Fix;
  beforeAll(async () => {
    for (const k of KEYS) await setRelease(k, true);
    f = await seedClinical("c333a");
  });

  it("keyed practitioner (the default grants the key): every record and photo table is readable", async () => {
    expect(await counts(f.member.userId, RECORD_TABLES, f)).toEqual(all(RECORD_TABLES, 1));
    expect(await counts(f.member.userId, PHOTO_TABLES, f)).toEqual(all(PHOTO_TABLES, 1));
  });

  it("owner: unchanged on every table", async () => {
    expect(await counts(f.s.userId, RECORD_TABLES, f)).toEqual(all(RECORD_TABLES, 1));
    expect(await counts(f.s.userId, PHOTO_TABLES, f)).toEqual(all(PHOTO_TABLES, 1));
  });

  it("restricted practitioner (clin.view_records off): ZERO rows on every record table, photos still readable (independent keys)", async () => {
    const r = await seedClinical("c333b");
    await deny(r.s.studioId, "clin.view_records");
    expect(await counts(r.member.userId, RECORD_TABLES, r)).toEqual(all(RECORD_TABLES, 0));
    expect(await counts(r.member.userId, PHOTO_TABLES, r)).toEqual(all(PHOTO_TABLES, 1));
    expect(await counts(r.s.userId, RECORD_TABLES, r)).toEqual(all(RECORD_TABLES, 1)); // the owner of the same studio is unaffected
  });

  it("restricted photos (clin.view_photos off): zero photo rows, records still readable", async () => {
    const r = await seedClinical("c333c");
    await deny(r.s.studioId, "clin.view_photos");
    expect(await counts(r.member.userId, PHOTO_TABLES, r)).toEqual(all(PHOTO_TABLES, 0));
    expect(await counts(r.member.userId, RECORD_TABLES, r)).toEqual(all(RECORD_TABLES, 1));
  });

  it("cross-studio: a keyed member of another studio reads zero rows of this one", async () => {
    const other = await seedClinical("c333x");
    expect(await counts(other.member.userId, RECORD_TABLES, f)).toEqual(all(RECORD_TABLES, 0));
    expect(await counts(other.s.userId, PHOTO_TABLES, f)).toEqual(all(PHOTO_TABLES, 0));
  });

  it("a receptionist reads nothing directly (no access is added) and keeps the 0274 desk projection", async () => {
    const r = await seedClinical("c333r");
    const recUser = randomUUID();
    await adminQuery("insert into auth.users(id,email) values ($1,$2)", [recUser, `rec-${recUser.slice(0, 8)}@harness.local`]);
    await adminQuery("insert into public.studio_receptionists(studio_id,user_id,display_name) values ($1,$2,'Synthetic Receptionist')", [r.s.studioId, recUser]);
    expect(await counts(recUser, RECORD_TABLES, r)).toEqual(all(RECORD_TABLES, 0));
    expect(await counts(recUser, PHOTO_TABLES, r)).toEqual(all(PHOTO_TABLES, 0));
    const dir = await asUser(recUser, (q) => q("select * from public.receptionist_client_directory($1, null, null, 'name', 0, 25)", [r.s.studioId]));
    expect(dir.rows.length).toBeGreaterThanOrEqual(1);
  });

  it("anon reads nothing on any of these tables", async () => {
    for (const [t] of [...RECORD_TABLES, ...PHOTO_TABLES]) {
      const n = await asRole("anon", async (q) => {
        try { return (await q(`select count(*)::int n from public.${t}`)).rows[0].n as number; } catch { return 0; } // a missing grant is also "nothing"
      });
      expect(n, t).toBe(0);
    }
  });

  it("service role (background jobs) reads every row", async () => {
    const n = await asRole("service_role", async (q) => (await q("select count(*)::int n from public.sessions where id = $1", [f.sessionId])).rows[0].n);
    expect(n).toBe(1);
  });

  it("NEGATIVE CONTROL: with sessions' old membership-only policy back, the restricted practitioner DOES read (the test can see the defect)", async () => {
    const r = await seedClinical("c333n");
    await deny(r.s.studioId, "clin.view_records");
    expect((await counts(r.member.userId, RECORD_TABLES, r)).sessions).toBe(0);
    await adminQuery(`alter policy "sessions: members select" on public.sessions using (public.is_studio_member(studio_id))`);
    try {
      expect((await counts(r.member.userId, RECORD_TABLES, r)).sessions).toBe(1);
    } finally {
      const stmt = MIGRATION.match(/alter policy "sessions: members select"[\s\S]*?;/)![0];
      await adminQuery(stmt);
    }
    expect((await counts(r.member.userId, RECORD_TABLES, r)).sessions).toBe(0);
  });
});

describe("0333, PENDING keys: existing staff are unchanged (the activation state is honoured)", () => {
  it("an owner's stored denial does NOT apply while the key is pending: the practitioner keeps reading", async () => {
    for (const k of KEYS) await setRelease(k, false);
    const f = await seedClinical("c333p");
    await deny(f.s.studioId, "clin.view_records");
    await deny(f.s.studioId, "clin.view_photos");
    expect(await counts(f.member.userId, RECORD_TABLES, f)).toEqual(all(RECORD_TABLES, 1));
    expect(await counts(f.member.userId, PHOTO_TABLES, f)).toEqual(all(PHOTO_TABLES, 1));
    // the same studio the moment the key is released: the denial now holds
    for (const k of KEYS) await setRelease(k, true);
    expect(await counts(f.member.userId, RECORD_TABLES, f)).toEqual(all(RECORD_TABLES, 0));
  });
});

describe("0333, shape: policies and privileges", () => {
  const POLICIES: Array<[string, string, string]> = [
    ["sessions", "sessions: members select", "clin.view_records"],
    ["session_blocks", "session_blocks_member_select", "clin.view_records"],
    ["session_block_areas", "session_block_areas_member_select", "clin.view_records"],
    ["session_copy_operations", "session_copy_operations: members select", "clin.view_records"],
    ["treatment_area_create_claims", "treatment_area_create_claims_member_select", "clin.view_records"],
    ["treatment_setup_captures", "treatment_setup_captures_member_select", "clin.view_records"],
    ["treatment_setup_readings", "treatment_setup_readings_member_select", "clin.view_records"],
    ["treatment_setup_submissions", "treatment_setup_submissions_member_select", "clin.view_records"],
    ["imported_treatment_memories", "imported_treatment_memories: members select", "clin.view_records"],
    ["imported_treatment_memory_audit_events", "imported_treatment_memory_audit_events: members select", "clin.view_records"],
    ["treatment_reading_change_events", "treatment_reading_change_events_clinical_select", "clin.view_records"],
    ["treatment_images", "treatment_images: members select", "clin.view_photos"],
    ["photos", "photos: members select", "clin.view_photos"],
  ];
  const SESSION_KEYED: Array<[string, string]> = [
    ["electrolysis_entries", "electrolysis_entries: members select"],
    ["laser_entries", "laser_entries: members select"],
    ["session_audit", "session_audit_studio_member_read"],
  ];

  it.each(POLICIES)("%s: the SELECT policy is authenticated-only, names the key and has no membership-only branch", async (table, name, key) => {
    const r = await adminQuery("select roles::text roles, qual from pg_policies where schemaname='public' and tablename=$1 and policyname=$2", [table, name]);
    expect(r.rows.length, `${table} policy`).toBe(1);
    expect(r.rows[0].roles).toBe("{authenticated}");
    expect(r.rows[0].qual).toContain("clin_key_studios");
    expect(r.rows[0].qual).toContain(key);
    expect(r.rows[0].qual).not.toContain("is_studio_member");
  });

  it.each(SESSION_KEYED)("%s: follows sessions' own policy, never wider than its session", async (table, name) => {
    const r = await adminQuery("select roles::text roles, qual from pg_policies where schemaname='public' and tablename=$1 and policyname=$2", [table, name]);
    expect(r.rows[0].roles).toBe("{authenticated}");
    expect(r.rows[0].qual).toMatch(/sessions/);
    expect(r.rows[0].qual).not.toContain("is_studio_member");
    expect(r.rows[0].qual).not.toContain("session_is_visible");
  });

  it("clin_key_studios is executable by authenticated only (revoked from public, anon, service_role by name)", async () => {
    expect((await adminQuery("select has_function_privilege('authenticated','public.clin_key_studios(text)','execute') p", [])).rows[0].p).toBe(true);
    for (const role of ["anon", "service_role"]) {
      expect((await adminQuery("select has_function_privilege($1,'public.clin_key_studios(text)','execute') p", [role])).rows[0].p, role).toBe(false);
    }
    const pub = await adminQuery(
      `select count(*)::int n from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        where p.oid = 'public.clin_key_studios(text)'::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE'`, []);
    expect(pub.rows[0].n).toBe(0);
  });

  it("the helper is SECURITY DEFINER with an empty search_path and is stable", async () => {
    const r = await adminQuery("select prosecdef, provolatile, proconfig::text cfg from pg_proc where oid = 'public.clin_key_studios(text)'::regprocedure", []);
    expect(r.rows[0]).toMatchObject({ prosecdef: true, provolatile: "s" });
    expect(r.rows[0].cfg).toContain("search_path=");
  });

  it("an unknown key or no session returns no studios (fail closed)", async () => {
    const s = await seedStudio("c333u");
    const n = await asUser(s.userId, async (q) => (await q("select count(*)::int n from public.clin_key_studios('no.such.key')")).rows[0].n);
    expect(n).toBe(0);
    const anon = await adminQuery("select count(*)::int n from public.clin_key_studios('clin.view_records')", []);
    expect(anon.rows[0].n).toBe(0);
  });
});

// ---- G1: the other nine record tables, behaviourally (one synthetic row each) ----------------------------------------------------------
type Seeded = Array<{ table: string; id: string }>;
async function seedNineTables(f: Fix): Promise<Seeded> {
  const s = f.s;
  const out: Seeded = [];
  const add = async (table: string, sql: string, params: unknown[]) => {
    const r = await adminQuery(`${sql} returning id`, params);
    out.push({ table, id: r.rows[0].id as string });
  };
  await add("session_block_areas", "insert into public.session_block_areas(session_block_id, studio_id, area, laterality) values ($1,$2,'lip','midline')", [f.blockId, s.studioId]);
  const sourceSession = (await seedSession(s)).sessionId;
  await add(
    "session_copy_operations",
    "insert into public.session_copy_operations(studio_id, target_session_id, source_session_id, created_by_practitioner_id, idempotency_key, request_hash, source_fingerprint, copied_block_count) values ($1,$2,$3,$4,'idem-333-key','h','f',0)",
    [s.studioId, f.sessionId, sourceSession, s.practitionerId],
  );
  const machine = randomUUID();
  await adminQuery("insert into public.studio_machines(id, studio_id, machine_profile_id, machine_profile_version, display_name) values ($1,$2,'synthetic:333',1,'Synthetic machine')", [machine, s.studioId]);
  await add(
    "treatment_setup_submissions",
    "insert into public.treatment_setup_submissions(studio_id, session_block_id, studio_machine_id, machine_profile_id, machine_profile_version, mode_key, idempotency_key, payload_digest) values ($1,$2,$3,'synthetic:333',1,'galvanic','idem-333-sub',repeat('a',32))",
    [s.studioId, f.blockId, machine],
  );
  await add(
    "treatment_area_create_claims",
    "insert into public.treatment_area_create_claims(studio_id, session_id, idempotency_key, payload_digest, block_id) values ($1,$2,'idem-333-claim',repeat('b',32),$3)",
    [s.studioId, f.sessionId, f.blockId],
  );
  await add(
    "treatment_setup_captures",
    "insert into public.treatment_setup_captures(studio_id, session_block_id, studio_machine_id, machine_profile_id, machine_profile_version, mode_key, group_key, revision) values ($1,$2,$3,'synthetic:333',1,'galvanic','g1',1)",
    [s.studioId, f.blockId, machine],
  );
  const captureId = out.find((r) => r.table === "treatment_setup_captures")!.id;
  await add(
    "treatment_setup_readings",
    "insert into public.treatment_setup_readings(studio_id, session_block_id, capture_id, studio_machine_id, machine_profile_id, machine_profile_version, mode_key, group_key, field_key, value_numeric, native_unit, decimals, observation_source) values ($1,$2,$4,$3,'synthetic:333',1,'galvanic','g1','preset',1,'none',0,'practitioner-entered')",
    [s.studioId, f.blockId, machine, captureId],
  );
  const batch = randomUUID();
  await adminQuery("insert into public.import_batches(id, studio_id) values ($1,$2)", [batch, s.studioId]);
  await add("imported_treatment_memories", "insert into public.imported_treatment_memories(studio_id, client_id, import_batch_id) values ($1,$2,$3)", [s.studioId, s.clientId, batch]);
  await add(
    "imported_treatment_memory_audit_events",
    "insert into public.imported_treatment_memory_audit_events(studio_id, record_type, record_id, action) values ($1,'import_batch',$2,'created')",
    [s.studioId, batch],
  );
  await add(
    "treatment_reading_change_events",
    "insert into public.treatment_reading_change_events(studio_id, session_id, client_id, source_table, source_id, actor_practitioner_id, actor_user_id, actor_display_name, changed_fields, changes) values ($1,$2,$3,'session_blocks',$4,$5,$6,'Synthetic',array['area'],'{}'::jsonb)",
    [s.studioId, f.sessionId, s.clientId, f.blockId, s.practitionerId, s.userId],
  );
  return out;
}
const countRow = async (userId: string, table: string, id: string): Promise<number> =>
  asUser(userId, async (q) => (await q(`select count(*)::int n from public.${table} where id = $1`, [id])).rows[0].n);

describe("0333, G1: the nine remaining record tables, behaviourally", () => {
  it("keyed member sees each row, the owner sees each row, the restricted member gets zero", async () => {
    for (const k of KEYS) await setRelease(k, true);
    const f = await seedClinical("c333g1");
    const rows = await seedNineTables(f);
    expect(rows.map((r) => r.table).sort()).toEqual([
      "imported_treatment_memories", "imported_treatment_memory_audit_events", "session_block_areas", "session_copy_operations",
      "treatment_area_create_claims", "treatment_reading_change_events", "treatment_setup_captures", "treatment_setup_readings", "treatment_setup_submissions",
    ]);
    for (const r of rows) {
      expect(await countRow(f.member.userId, r.table, r.id), `keyed ${r.table}`).toBe(1);
      expect(await countRow(f.s.userId, r.table, r.id), `owner ${r.table}`).toBe(1);
    }
    await deny(f.s.studioId, "clin.view_records");
    for (const r of rows) {
      expect(await countRow(f.member.userId, r.table, r.id), `restricted ${r.table}`).toBe(0);
      expect(await countRow(f.s.userId, r.table, r.id), `owner after denial ${r.table}`).toBe(1);
    }
    const other = await seedClinical("c333g1x");
    for (const r of rows) expect(await countRow(other.member.userId, r.table, r.id), `cross-studio ${r.table}`).toBe(0);
  });
});

describe("0333, G2: the helper requires an ACTIVE practitioner", () => {
  it("an inactive practitioner who holds the key reads zero rows (mutation: dropping pr.active from the helper fails here)", async () => {
    for (const k of KEYS) await setRelease(k, true);
    const f = await seedClinical("c333g2");
    expect(await counts(f.member.userId, RECORD_TABLES, f)).toEqual(all(RECORD_TABLES, 1));
    await adminQuery("update public.practitioners set active=false where id=$1", [f.member.practitionerId]);
    expect(await counts(f.member.userId, RECORD_TABLES, f)).toEqual(all(RECORD_TABLES, 0));
    expect(await counts(f.member.userId, PHOTO_TABLES, f)).toEqual(all(PHOTO_TABLES, 0));
  });
});

describe("0333, G5: a user in two studios reads only the studio where the key is held", () => {
  it("keyed in A, restricted in B: rows of A visible, rows of B zero (and B's owner still sees B)", async () => {
    for (const k of KEYS) await setRelease(k, true);
    const a = await seedClinical("c333g5a");
    const b = await seedClinical("c333g5b");
    await adminQuery(
      "insert into public.practitioners(id, studio_id, user_id, display_name, email, role, active) values ($1,$2,$3,'Two-studio user','two-studio@harness.local','practitioner',true)",
      [randomUUID(), b.s.studioId, a.member.userId],
    );
    await deny(b.s.studioId, "clin.view_records");
    expect(await counts(a.member.userId, RECORD_TABLES, a)).toEqual(all(RECORD_TABLES, 1));
    expect(await counts(a.member.userId, RECORD_TABLES, b)).toEqual(all(RECORD_TABLES, 0));
    expect(await counts(b.s.userId, RECORD_TABLES, b)).toEqual(all(RECORD_TABLES, 1));
  });
});

describe("0333, G7: the receptionist desk projection still works as a receptionist", () => {
  it("receptionist_calendar_v2 returns the appointment and receptionist_studio_timezone returns the zone", async () => {
    for (const k of KEYS) await setRelease(k, true);
    const f = await seedClinical("c333g7");
    const appt = randomUUID();
    await adminQuery(
      "insert into public.appointments(id, studio_id, client_id, practitioner_id, starts_at, ends_at, duration_minutes, status) values ($1,$2,$3,$4,'2031-03-03T15:00:00Z','2031-03-03T16:00:00Z',60,'confirmed')",
      [appt, f.s.studioId, f.s.clientId, f.s.practitionerId],
    );
    await adminQuery("update public.sessions set appointment_id=$2 where id=$1", [f.sessionId, appt]);
    const recUser = randomUUID();
    await adminQuery("insert into auth.users(id,email) values ($1,$2)", [recUser, `rec7-${recUser.slice(0, 8)}@harness.local`]);
    await adminQuery("insert into public.studio_receptionists(studio_id,user_id,display_name) values ($1,$2,'Synthetic Receptionist')", [f.s.studioId, recUser]);
    await deny(f.s.studioId, "clin.view_records"); // even with the clinical key off for practitioners, the desk projection is a definer read
    const cal = await asUser(recUser, (q) => q("select * from public.receptionist_calendar_v2($1,'2031-03-01T00:00:00Z','2031-03-10T00:00:00Z')", [f.s.studioId]));
    expect(cal.rows.map((r) => r.appointment_id)).toContain(appt);
    const tz = await asUser(recUser, (q) => q("select public.receptionist_studio_timezone($1) as tz", [f.s.studioId]));
    expect(typeof tz.rows[0].tz).toBe("string");
    expect(tz.rows[0].tz.length).toBeGreaterThan(0);
  });
});
