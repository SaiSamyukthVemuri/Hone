import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, asRole, asUser, closePool, seedStudio } from "./helpers/harness";

const q = async <T>(text: string, params: unknown[] = []): Promise<T[]> =>
  (await adminQuery(text, params)).rows as T[];

// ===========================================================================
// HON-7 C1 — the capacity panel's invitation count, against REAL GRANTS.
//
// The first version read new_client_waitlist_invitations through the admin
// (service_role) client. 0188 grants SELECT on that table to `authenticated`
// alone, behind the owner policy, so service_role was refused (42501) and the
// panel always answered "couldn't check". The unit tests mocked past the
// grants. This runs the SAME select the action issues, as the roles involved.
// ===========================================================================

afterAll(async () => {
  await closePool();
});

// The exact filter chain in window-capacity-actions.ts.
const COUNT = `
  select count(*)::int as n
    from public.new_client_waitlist_invitations
   where studio_id = $1
     and redeemed_at is null and expired_at is null
     and released_at is null and declined_at is null
     and expires_at > now()`;

async function invitedStudio(label: string) {
  const s = await seedStudio(`c1-${label}`);
  const svc = await q<{ id: string }>(
    `insert into public.services (studio_id,name,default_duration_minutes,active,modality)
     values ($1,'Consultation',30,true,'consultation') returning id`,
    [s.studioId],
  );
  await q(`select * from public.open_new_client_waitlist_admission_round($1,$2,20)`, [s.studioId, s.userId]);
  const e = await q<any>(
    `select * from public.create_practitioner_waitlist_entry($1,$2,'Prospect',$3,null,null)`,
    [s.studioId, s.userId, `c1-${label}-${s.studioId.slice(0, 8)}@example.com`],
  );
  const from = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const to = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
  const a = await q<any>(
    `select * from public.admit_new_client_waitlist_entry($1,$2,$3,$4,$5,$6,null,72,1000)`,
    [s.studioId, s.userId, e[0].entry_id, svc[0].id, from, to],
  );
  expect(a[0].result).toBe("admitted");
  return s;
}

describe("capacity panel invitation count", () => {
  it("the owner's own session can run the count and sees its live invitation", async () => {
    const s = await invitedStudio("own");
    const rows = await asUser(s.userId, (query) => query(COUNT, [s.studioId]));
    expect(rows.rows[0].n).toBe(1);
  });

  it("another studio's owner sees none of it (RLS), and no error", async () => {
    const s = await invitedStudio("a");
    const other = await seedStudio("c1-other");
    const rows = await asUser(other.userId, (query) => query(COUNT, [s.studioId]));
    expect(rows.rows[0].n).toBe(0);
  });

  it("service_role CANNOT run it: the admin-client path this replaced was refused at the privilege layer", async () => {
    const s = await invitedStudio("svc");
    await expect(asRole("service_role", (query) => query(COUNT, [s.studioId]))).rejects.toMatchObject({
      code: "42501",
    });
  });
});

describe("waitlist_invitation_bookings privileges (0313), by role name", () => {
  const priv = async (role: string, p: string) =>
    (await q<{ ok: boolean }>(`select has_table_privilege($1,'public.waitlist_invitation_bookings',$2) as ok`, [role, p]))[0].ok;

  it("RLS is on and anon, authenticated and service_role hold no privilege at all", async () => {
    const rls = await q<{ r: boolean }>(
      `select relrowsecurity as r from pg_class where oid = 'public.waitlist_invitation_bookings'::regclass`,
    );
    expect(rls[0].r).toBe(true);
    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        expect(await priv(role, p), `${role} ${p}`).toBe(false);
      }
    }
  });

  it("a member of another studio (and the owner) sees nothing through the API roles", async () => {
    const s = await invitedStudio("bk");
    const other = await seedStudio("c1-bk-other");
    for (const uid of [s.userId, other.userId]) {
      await expect(
        asUser(uid, (query) => query(`select count(*) from public.waitlist_invitation_bookings`)),
      ).rejects.toMatchObject({ code: "42501" });
    }
  });
});
