// Behavioural proof for migration 0353 (waitlist single legal name, v2 completion command). Synthetic values only.
// Mirrors the helpers of tests/db/waitlist-profile-and-sms-consent-authority.db.test.ts (legacyEntry, issueGrant).
import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, asRole, closePool, seedStudio } from "./helpers/harness";

afterAll(closePool);

const V2 = "public.complete_waitlist_profile_by_grant_v2(text, text, text, text[], text, text, boolean, boolean)";
const V1 = "public.complete_waitlist_profile_by_grant(text, text, text, text[], text, text, boolean)";

async function legacyEntry(studioId: string, phone: string | null = null) {
  const r = await adminQuery(
    `insert into public.new_client_waitlist_entries (studio_id, name, email, phone) values ($1,$2,$3,$4) returning id`,
    [studioId, "Old Name", `legacy-${Math.random().toString(16).slice(2)}@example.com`, phone],
  );
  return r.rows[0].id as string;
}
async function issueGrant(studioId: string, entryId: string, actorUserId: string) {
  const r = await adminQuery(`select * from public.issue_waitlist_preference_grant($1,$2,$3,$4)`, [studioId, entryId, actorUserId, 48]);
  expect(r.rows[0].result).toBe("issued");
  return r.rows[0].raw_token as string;
}
async function v2(token: string, o: Partial<{ first: string; last: string; single: boolean; consent: boolean; mobile: string | null; pref: string; areas: string[] }> = {}) {
  const r = await adminQuery(`select public.complete_waitlist_profile_by_grant_v2($1,$2,$3,$4,$5,$6,$7,$8) as result`, [
    token, o.first ?? "Cher", o.last ?? "", o.areas ?? ["chin"], o.pref ?? "weekdays",
    o.mobile === undefined ? "647-555-1234" : o.mobile, o.consent ?? false, o.single ?? true,
  ]);
  return r.rows[0].result as string;
}
const row = async (id: string) =>
  (await adminQuery(`select first_name, last_name, single_legal_name, name, updated_at from public.new_client_waitlist_entries where id=$1`, [id])).rows[0];

describe("0353 waitlist single legal name (v2 command)", () => {
  it("column: additive, not null, default false, and every existing row is false", async () => {
    const s = await seedStudio("w353-col");
    const id = await legacyEntry(s.studioId);
    expect((await row(id)).single_legal_name).toBe(false);
    const c = await adminQuery(`select is_nullable, column_default from information_schema.columns where table_name='new_client_waitlist_entries' and column_name='single_legal_name'`);
    expect(c.rows[0]).toMatchObject({ is_nullable: "NO", column_default: "false" });
  });

  it("single name accepted: stored as NULL last name plus the flag, nothing invented", async () => {
    const s = await seedStudio("w353-ok");
    const id = await legacyEntry(s.studioId);
    expect(await v2(await issueGrant(s.studioId, id, s.userId))).toBe("accepted");
    const r = await row(id);
    expect(r.first_name).toBe("Cher");
    expect(r.last_name).toBeNull();
    expect(r.single_legal_name).toBe(true);
  });

  it("a last name WITH the flag is refused and nothing is written", async () => {
    const s = await seedStudio("w353-both");
    const id = await legacyEntry(s.studioId);
    const before = await row(id);
    expect(await v2(await issueGrant(s.studioId, id, s.userId), { last: "Jones" })).toBe("invalid_submission");
    expect(await row(id)).toEqual(before);
  });

  it("an empty last name WITHOUT the flag is refused (blank is never read as a single name)", async () => {
    const s = await seedStudio("w353-blank");
    const id = await legacyEntry(s.studioId);
    const token = await issueGrant(s.studioId, id, s.userId);
    expect(await v2(token, { single: false, last: "" })).toBe("invalid_submission");
    // The grant was not spent by a deficient submission: the retry works.
    expect(await v2(token, { single: false, last: "Jones" })).toBe("accepted");
    const r = await row(id);
    expect(r.last_name).toBe("Jones");
    expect(r.single_legal_name).toBe(false);
  });

  it("two-name through v2 equals today's shape (flag false, last name stored)", async () => {
    const s = await seedStudio("w353-two");
    const id = await legacyEntry(s.studioId);
    expect(await v2(await issueGrant(s.studioId, id, s.userId), { first: "Ada", last: "Lovelace", single: false })).toBe("accepted");
    expect(await row(id)).toMatchObject({ first_name: "Ada", last_name: "Lovelace", single_legal_name: false });
  });

  it("null flag or null token is refused", async () => {
    const r = await adminQuery(`select public.complete_waitlist_profile_by_grant_v2(null,'A','',array['chin'],'weekdays',null,false,true) as r`);
    expect(r.rows[0].r).toBe("refused");
    const s = await seedStudio("w353-null");
    const id = await legacyEntry(s.studioId);
    const t = await issueGrant(s.studioId, id, s.userId);
    const n = await adminQuery(`select public.complete_waitlist_profile_by_grant_v2($1,'A','',array['chin'],'weekdays','647-555-1234',false,null) as r`, [t]);
    expect(n.rows[0].r).toBe("refused");
  });

  it("idempotent replay: the same single-name submission on the spent grant is accepted and writes nothing", async () => {
    const s = await seedStudio("w353-replay");
    const id = await legacyEntry(s.studioId);
    const t = await issueGrant(s.studioId, id, s.userId);
    expect(await v2(t)).toBe("accepted");
    const before = await row(id);
    expect(await v2(t)).toBe("accepted");
    expect(await row(id)).toEqual(before);
  });

  it("replay compares the flag: a different answer on the spent grant is refused and nothing changes", async () => {
    const s = await seedStudio("w353-replay-diff");
    const id = await legacyEntry(s.studioId);
    const t = await issueGrant(s.studioId, id, s.userId);
    expect(await v2(t)).toBe("accepted");
    const before = await row(id);
    expect(await v2(t, { single: false, last: "Jones" })).toBe("refused");
    expect(await row(id)).toEqual(before);
  });

  it("check constraint: the flag true with a last name cannot be written by any path", async () => {
    const s = await seedStudio("w353-check");
    const id = await legacyEntry(s.studioId);
    await expect(
      adminQuery(`update public.new_client_waitlist_entries set single_legal_name=true, last_name='Jones' where id=$1`, [id]),
    ).rejects.toThrow();
  });

  it("v1 on a single-name row cannot complete it as two names by accident (it raises on the check; the app routes everything through v2 once enabled)", async () => {
    const s = await seedStudio("w353-v1");
    const id = await legacyEntry(s.studioId);
    expect(await v2(await issueGrant(s.studioId, id, s.userId))).toBe("accepted");
    const t2 = await issueGrant(s.studioId, id, s.userId);
    await expect(
      adminQuery(`select public.complete_waitlist_profile_by_grant($1,'Ada','Lovelace',array['chin'],'weekdays',null,false)`, [t2]),
    ).rejects.toThrow();
    expect((await row(id)).single_legal_name).toBe(true);
  });

  it("token binding: a grant for one entry cannot complete another", async () => {
    const s = await seedStudio("w353-bind");
    const a = await legacyEntry(s.studioId);
    const b = await legacyEntry(s.studioId);
    const ta = await issueGrant(s.studioId, a, s.userId);
    expect(await v2(ta)).toBe("accepted");
    expect((await row(b)).single_legal_name).toBe(false);
    expect(await v2("not-a-real-token-aaaaaaaaaaaaaaaaaaaaaaaa")).toBe("refused");
  });

  it("grants by name: service_role only; anon, authenticated and public cannot execute", async () => {
    const ok = await adminQuery(`select has_function_privilege('service_role', $1, 'EXECUTE') as ok`, [V2]);
    expect(ok.rows[0].ok).toBe(true);
    for (const role of ["anon", "authenticated"] as const) {
      const r = await adminQuery(`select has_function_privilege($1, $2, 'EXECUTE') as ok`, [role, V2]);
      expect(r.rows[0].ok, role).toBe(false);
    }
    const pub = await adminQuery(`select (select count(*) from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = $1::regprocedure and a.grantee = 0) as n`, [V2]);
    expect(Number(pub.rows[0].n)).toBe(0);
    await asRole("authenticated", async (q) => {
      await expect(q(`select public.complete_waitlist_profile_by_grant_v2('x','A','',array['chin'],'weekdays',null,false,true)`)).rejects.toThrow();
    });
  });

  it("M5 (Privacy): no browser role can write the new flag, by column privilege or by an update", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      const r = await adminQuery(
        `select has_column_privilege($1, 'public.new_client_waitlist_entries', 'single_legal_name', 'UPDATE') as u,
                has_column_privilege($1, 'public.new_client_waitlist_entries', 'single_legal_name', 'INSERT') as i`,
        [role],
      );
      expect(r.rows[0], role).toEqual({ u: false, i: false });
    }
    const s = await seedStudio("w353-m5");
    const id = await legacyEntry(s.studioId);
    await asRole("authenticated", async (q) => {
      await expect(q(`update public.new_client_waitlist_entries set single_legal_name = true where id = $1`, [id])).rejects.toThrow();
    });
    expect((await row(id)).single_legal_name).toBe(false);
  });

  it("v1 is unchanged: still refuses a blank family name", async () => {
    const s = await seedStudio("w353-v1-blank");
    const id = await legacyEntry(s.studioId);
    const t = await issueGrant(s.studioId, id, s.userId);
    const r = await adminQuery(`select public.complete_waitlist_profile_by_grant($1,'Cher','',array['chin'],'weekdays','647-555-1234',false) as r`, [t]);
    expect(r.rows[0].r).toBe("invalid_submission");
    void V1;
  });
});
