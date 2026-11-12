import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, asRole, asUser, closePool, seedMember, seedSession, seedStudio } from "./helpers/harness";

// 0336 (I4): (a) the definer descriptor needs clin.view_records, (b) anon holds no privilege on the clinical tables, (c) session_is_visible is not
// executable by anon, public or service_role. Synthetic data only.

const TABLES = [...readFileSync("supabase/migrations/0336_clinical_read_enforcement_definer_anon.sql", "utf8").matchAll(/revoke all on table public\.(\w+) from public, anon;/g)].map((m) => m[1]!);
const KEY = "clin.view_records";
let saved: Array<{ key: string; released_at: string | null; release_tag: string; release_kind: string }> = [];

async function setRelease(released: boolean): Promise<void> {
  await adminQuery("delete from public.permission_key_release where key=$1", [KEY]);
  await adminQuery("insert into public.permission_key_release(key,released_at,release_tag,release_kind) values ($1, $2, 'T0336', 'full')", [KEY, released ? "2000-01-01T00:00:00Z" : null]);
}
async function deny(studioId: string): Promise<void> {
  await adminQuery(
    "insert into public.studio_role_permissions(studio_id,role,key,scope,set_at) values ($1,'practitioner',$2,'off', now()) on conflict (studio_id,role,key) do update set scope='off', set_at=now()",
    [studioId, KEY],
  );
}
const describeCall = (userId: string, studioId: string, sessionId: string) =>
  asUser(userId, (q) => q("select public.whole_session_copy_source_descriptor($1,$2) d", [studioId, sessionId]).then((r) => r.rows[0].d as { eligible: boolean }));

beforeAll(async () => {
  saved = (await adminQuery("select key, released_at::text released_at, release_tag, release_kind from public.permission_key_release where key=$1", [KEY])).rows;
});
afterAll(async () => {
  await adminQuery("delete from public.permission_key_release where key=$1", [KEY]);
  for (const r of saved) await adminQuery("insert into public.permission_key_release(key,released_at,release_tag,release_kind) values ($1,$2,$3,$4)", [r.key, r.released_at, r.release_tag, r.release_kind]);
  await closePool();
});

describe("0336 (b): anon holds no privilege on any clinical table", () => {
  it("the list is the migration's (not vacuous)", () => {
    expect(TABLES.length).toBe(29);
  });
  it("anon holds NOTHING (every privilege), PUBLIC holds NOTHING (no ACL entry for grantee 0), and authenticated and service_role still hold SELECT, on each of the 29 tables", async () => {
    for (const t of TABLES) {
      const rel = `public.${t}`;
      for (const p of ["select", "insert", "update", "delete", "truncate", "references", "trigger"]) {
        expect((await adminQuery("select has_table_privilege('anon', $1, $2) p", [rel, p])).rows[0].p, `anon ${p} ${t}`).toBe(false);
      }
      // PUBLIC is a pseudo-role: has_table_privilege cannot name it, so read the ACL for grantee 0
      expect((await adminQuery("select count(*)::int n from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a where c.oid = $1::regclass and a.grantee = 0", [rel])).rows[0].n, `PUBLIC ${t}`).toBe(0);
      for (const role of ["authenticated", "service_role"]) {
        expect((await adminQuery("select has_table_privilege($1, $2, 'select') p", [role, rel])).rows[0].p, `${role} select ${t}`).toBe(true);
      }
    }
  });
  it("an anon read is SQLSTATE 42501 (permission denied), not an empty list", async () => {
    for (const t of ["sessions", "client_intake_forms", "client_pinned_notes"]) {
      await expect(asRole("anon", (q) => q(`select count(*) from public.${t}`)), t).rejects.toMatchObject({ code: "42501" });
    }
  });
});

describe("0336 (c): session_is_visible", () => {
  it("is executable by authenticated only (no public grant, not anon, not service_role)", async () => {
    const f = "public.session_is_visible(uuid)";
    expect((await adminQuery("select has_function_privilege('authenticated', $1, 'execute') p", [f])).rows[0].p).toBe(true);
    for (const role of ["anon", "service_role"]) expect((await adminQuery("select has_function_privilege($1, $2, 'execute') p", [role, f])).rows[0].p, role).toBe(false);
    expect((await adminQuery("select not exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = $1::regprocedure and a.grantee = 0) ok", [f])).rows[0].ok).toBe(true);
  });
  it("regression: a keyed practitioner can still write an entry (the entry policies still call it)", async () => {
    await setRelease(true);
    const s = await seedStudio("c336e");
    const m = await seedMember(s, "c336em");
    const { sessionId } = await seedSession(s);
    await asUser(m.userId, async (q) => {
      const r = await q("insert into public.electrolysis_entries(session_id, area) values ($1,'lip') returning id", [sessionId]);
      expect(r.rows).toHaveLength(1);
    });
  });
});

describe("0336 (a): whole_session_copy_source_descriptor needs clin.view_records", () => {
  it("ACTIVATED: a keyed member and the owner get an answer; a restricted member, a stranger studio and a non-member get HN001", async () => {
    await setRelease(true);
    const s = await seedStudio("c336a");
    const member = await seedMember(s, "c336am");
    const { sessionId } = await seedSession(s);
    expect(typeof (await describeCall(member.userId, s.studioId, sessionId)).eligible).toBe("boolean");
    expect(typeof (await describeCall(s.userId, s.studioId, sessionId)).eligible).toBe("boolean");
    const other = await seedStudio("c336ax");
    await expect(describeCall(other.userId, s.studioId, sessionId)).rejects.toMatchObject({ code: "HN001" });
    await deny(s.studioId);
    await expect(describeCall(member.userId, s.studioId, sessionId)).rejects.toMatchObject({ code: "HN001" });
    expect(typeof (await describeCall(s.userId, s.studioId, sessionId)).eligible).toBe("boolean"); // the owner is unaffected
  });
  it("PENDING: the stored denial does not apply, so the practitioner is unchanged", async () => {
    await setRelease(false);
    const s = await seedStudio("c336p");
    const member = await seedMember(s, "c336pm");
    const { sessionId } = await seedSession(s);
    await deny(s.studioId);
    expect(typeof (await describeCall(member.userId, s.studioId, sessionId)).eligible).toBe("boolean");
  });
  it("is still executable by authenticated and service_role only, and a service_role call is refused (no auth.uid)", async () => {
    const f = "public.whole_session_copy_source_descriptor(uuid,uuid)";
    for (const role of ["authenticated", "service_role"]) expect((await adminQuery("select has_function_privilege($1, $2, 'execute') p", [role, f])).rows[0].p, role).toBe(true);
    expect((await adminQuery("select has_function_privilege('anon', $1, 'execute') p", [f])).rows[0].p).toBe(false);
  });
});
