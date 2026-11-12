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
    "insert into public.treatment_images(studio_id, client_id, session_id, storage_path, content_type, size_bytes) values ($1,$2,$3,'synthetic/t.jpg','image/jpeg',10)",
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
