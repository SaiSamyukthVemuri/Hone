import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, closePool, seedStudio } from "./helpers/harness";

const q = async <T>(text: string, params: unknown[] = []): Promise<T[]> =>
  (await adminQuery(text, params)).rows as T[];

// ===========================================================================
// The flag-OFF decline (0192) releases the entry. The owner's "Return to
// waitlist" (requeue) puts the SAME row back: id and joined_at never change
// (0188), so the person keeps their original place ahead of anyone who joined
// later. This is the owner-assisted path the declined-times card points at.
// ===========================================================================

afterAll(async () => {
  await closePool();
});

async function seed(label: string) {
  const s = await seedStudio(`dqp-${label}`);
  const svc = await q<{ id: string }>(
    `insert into public.services (studio_id,name,default_duration_minutes,active,modality)
     values ($1,'Consultation',30,true,'consultation') returning id`,
    [s.studioId],
  );
  await q(`select * from public.open_new_client_waitlist_admission_round($1,$2,20)`, [s.studioId, s.userId]);
  return { studioId: s.studioId, userId: s.userId, serviceId: svc[0].id };
}

async function create(f: { studioId: string; userId: string }, label: string) {
  const e = await q<any>(
    `select * from public.create_practitioner_waitlist_entry($1,$2,'Prospect ${label}',$3,null,null)`,
    [f.studioId, f.userId, `dqp-${label}-${f.studioId.slice(0, 8)}@example.com`],
  );
  expect(e[0].result).toBe("created");
  return e[0].entry_id as string;
}

const row = (id: string) =>
  q<{ id: string; status: string; joined_at: string; released_at: string | null }>(
    `select id, status, joined_at, released_at from public.new_client_waitlist_entries where id=$1`,
    [id],
  ).then((r) => r[0]);

describe("decline (flag off) then requeue keeps the original place", () => {
  it("same id, same joined_at, back to waiting, and ahead of a later joiner", async () => {
    const f = await seed("a");
    const early = await create(f, "early");
    const later = await create(f, "later");
    const before = await row(early);

    const from = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const a = await q<any>(
      `select * from public.admit_new_client_waitlist_entry($1,$2,$3,$4,$5,$6,null,72)`,
      [f.studioId, f.userId, early, f.serviceId, from, to],
    );
    expect(a[0].result).toBe("admitted");
    const b = await q<any>(`select * from public.begin_waitlist_invitation_proof($1,20)`, [a[0].raw_token]);
    const c = await q<any>(`select * from public.complete_waitlist_invitation_proof($1,$2)`, [
      a[0].raw_token,
      b[0].raw_challenge,
    ]);
    const d = await q<{ result: string }>(
      `select result from public.decline_new_client_waitlist_invitation($1,$2)`,
      [a[0].raw_token, c[0].raw_capability],
    );
    expect(d[0].result).toBe("declined");

    const released = await row(early);
    expect(released.status).toBe("released");
    // The signal the owner card derives from: the decline stamps ONE instant on both rows.
    const inv = await q<{ same: boolean }>(
      `select (i.declined_at = e.released_at) as same
         from public.new_client_waitlist_invitations i
         join public.new_client_waitlist_entries e on e.id = i.entry_id
        where e.id = $1`,
      [early],
    );
    expect(inv).toEqual([{ same: true }]);

    const r = await q<{ r: string }>(`select public.requeue_new_client_waitlist_entry($1,$2,$3) as r`, [
      f.studioId,
      early,
      f.userId,
    ]);
    expect(r[0].r).toBe("requeued");

    const after = await row(early);
    expect(after.id).toBe(before.id);
    expect(after.status).toBe("waiting");
    expect(new Date(after.joined_at).getTime()).toBe(new Date(before.joined_at).getTime());

    const order = await q<{ id: string }>(
      `select id from public.new_client_waitlist_entries
        where studio_id=$1 and id = any($2::uuid[]) order by joined_at, id`,
      [f.studioId, [later, early]],
    );
    expect(order.map((o) => o.id)).toEqual([early, later]);

    // One person, one row.
    const n = await q<{ n: number }>(
      `select count(*)::int as n from public.new_client_waitlist_entries where studio_id=$1 and name='Prospect early'`,
      [f.studioId],
    );
    expect(n[0].n).toBe(1);
  });
});
