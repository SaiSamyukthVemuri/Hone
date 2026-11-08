import { afterAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { adminQuery, asRole, closePool, resolveLocalDbUrl, seedStudio } from "./helpers/harness";
import { waitUntilBlocked } from "./helpers/waitlist-concurrency";

const q = async <T>(text: string, params: unknown[] = []): Promise<T[]> =>
  (await adminQuery(text, params)).rows as T[];

// ===========================================================================
// 0324 -- the SEND enforces the allowance under the studio lock.
//
// Rule: live invitations that compete with the offered window, plus the one
// being sent, must not exceed `p_fit` (the consultations that fit, computed by
// the send server action at send time).
//
// What this file proves, and what it deliberately does NOT:
//   * the guard enforces the fit it is GIVEN, and refuses a missing one;
//   * two simultaneous sends with one slot left create exactly one invitation;
//   * a declined / released / expired / redeemed invitation stops counting at once;
//   * RESIDUAL, NOT CLOSED: the guard cannot recompute availability. A slot taken
//     between the sender's fit computation and the lock is not seen by it (see
//     "the residual race" below). Invitations do not reserve appointments.
// ===========================================================================

afterAll(async () => {
  await closePool();
});

type Row = Record<string, unknown> & { result: string; raw_token: string };
type Fixture = { studioId: string; userId: string; serviceId: string };

async function fixture(label: string): Promise<Fixture> {
  const s = await seedStudio(`a324-${label}`);
  const svc = await q<{ id: string }>(
    `insert into public.services (studio_id,name,default_duration_minutes,active,modality)
     values ($1,'Consultation',30,true,'consultation') returning id`,
    [s.studioId],
  );
  await q(`select * from public.open_new_client_waitlist_admission_round($1,$2,100)`, [s.studioId, s.userId]);
  return { studioId: s.studioId, userId: s.userId, serviceId: svc[0].id };
}

async function entry(f: Fixture, label: string): Promise<string> {
  const e = await q<{ result: string; entry_id: string }>(
    `select * from public.create_practitioner_waitlist_entry($1,$2,'Prospect',$3,null,null)`,
    [f.studioId, f.userId, `a324-${label}-${f.studioId.slice(0, 8)}@example.com`],
  );
  expect(e[0].result).toBe("created");
  return e[0].entry_id as string;
}

const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

const ADMIT = `select * from public.admit_new_client_waitlist_entry($1,$2,$3,$4,$5,$6,$7::smallint[],72,$8)`;

async function admit(
  f: Fixture,
  entryId: string,
  fit: number | null,
  opts: { from?: string; to?: string; weekdays?: number[] | null } = {},
) {
  const r = await q<Row>(ADMIT, [
    f.studioId,
    f.userId,
    entryId,
    f.serviceId,
    opts.from ?? day(1),
    opts.to ?? day(14),
    opts.weekdays ?? null,
    fit,
  ]);
  return r[0];
}

const liveCount = (studioId: string) =>
  q<{ n: number }>(
    `select count(*)::int as n from public.new_client_waitlist_invitations
      where studio_id = $1 and redeemed_at is null and expired_at is null
        and released_at is null and declined_at is null and expires_at > now()`,
    [studioId],
  ).then((r) => r[0].n);

const allInvitations = (studioId: string) =>
  q<{ n: number }>(`select count(*)::int as n from public.new_client_waitlist_invitations where studio_id = $1`, [studioId]).then(
    (r) => r[0].n,
  );

describe("0324 the guard enforces the fit it is given", () => {
  it("fit 0 refuses even with nothing outstanding", async () => {
    const f = await fixture("zero");
    const e = await entry(f, "zero");
    expect((await admit(f, e, 0)).result).toBe("no_capacity");
    expect(await allInvitations(f.studioId)).toBe(0);
  });

  it("a missing or negative fit is refused, never treated as no limit", async () => {
    const f = await fixture("nofit");
    const e = await entry(f, "nofit");
    expect((await admit(f, e, null)).result).toBe("invalid_fit");
    expect((await admit(f, e, -1)).result).toBe("invalid_fit");
    expect(await allInvitations(f.studioId)).toBe(0);
    // The eight-argument form no longer exists at all.
    const overloads = await q<{ n: number }>(
      `select count(*)::int as n from pg_proc p where p.pronamespace = 'public'::regnamespace
        and p.proname = 'admit_new_client_waitlist_entry'`,
    );
    expect(overloads[0].n).toBe(1);
  });

  it("fit 1 admits one and refuses the next; the refused entry is left untouched", async () => {
    const f = await fixture("one");
    const a = await entry(f, "a");
    const b = await entry(f, "b");
    expect((await admit(f, a, 1)).result).toBe("admitted");
    expect((await admit(f, b, 1)).result).toBe("no_capacity");
    expect(await liveCount(f.studioId)).toBe(1);
    const st = await q<{ status: string }>(`select status from public.new_client_waitlist_entries where id=$1`, [b]);
    expect(st[0].status).toBe("waiting");
  });

  it("fit 2 admits two and refuses the third", async () => {
    const f = await fixture("two");
    const [a, b, c] = [await entry(f, "a"), await entry(f, "b"), await entry(f, "c")];
    expect((await admit(f, a, 2)).result).toBe("admitted");
    expect((await admit(f, b, 2)).result).toBe("admitted");
    expect((await admit(f, c, 2)).result).toBe("no_capacity");
  });

  it("an invitation for other dates, or other weekdays, does not compete", async () => {
    const f = await fixture("scope");
    const [a, b, c] = [await entry(f, "a"), await entry(f, "b"), await entry(f, "c")];
    expect((await admit(f, a, 1, { from: day(1), to: day(3) })).result).toBe("admitted");
    // Disjoint dates: not competing.
    expect((await admit(f, b, 1, { from: day(20), to: day(22) })).result).toBe("admitted");
    // Same dates as `a`: competes.
    expect((await admit(f, c, 1, { from: day(1), to: day(3) })).result).toBe("no_capacity");
  });
});

describe("0324 an invitation stops counting the moment it stops being live", () => {
  async function withOne(label: string) {
    const f = await fixture(label);
    const a = await entry(f, "a");
    const first = await admit(f, a, 1);
    expect(first.result).toBe("admitted");
    const b = await entry(f, "b");
    // While it is live, the next send is refused.
    expect((await admit(f, b, 1)).result).toBe("no_capacity");
    return { f, a, b, first };
  }

  it("released", async () => {
    const { f, a, b } = await withOne("rel");
    const r = await q<{ r: string }>(`select public.release_new_client_waitlist_entry($1,$2,$3) as r`, [f.studioId, a, f.userId]);
    expect(r[0].r).toBe("released");
    expect((await admit(f, b, 1)).result).toBe("admitted");
  });

  it("expired", async () => {
    const { f, a, b } = await withOne("exp");
    await q(`update public.new_client_waitlist_invitations set expires_at = now() - interval '1 minute' where entry_id = $1`, [a]);
    expect((await admit(f, b, 1)).result).toBe("admitted");
  });

  it("redeemed", async () => {
    const { f, b, first } = await withOne("red");
    const r = await q<{ result: string }>(`select result from public.redeem_new_client_waitlist_invitation($1)`, [first.raw_token]);
    expect(r[0].result).toBeTruthy();
    expect((await admit(f, b, 1)).result).toBe("admitted");
  });

  it("declined", async () => {
    const { f, b, first } = await withOne("dec");
    const p = await q<{ raw_challenge: string }>(`select * from public.begin_waitlist_invitation_proof($1,20)`, [first.raw_token]);
    const c = await q<{ raw_capability: string }>(`select * from public.complete_waitlist_invitation_proof($1,$2)`, [first.raw_token, p[0].raw_challenge]);
    const d = await q<{ result: string }>(`select result from public.decline_new_client_waitlist_invitation($1,$2)`, [
      first.raw_token,
      c[0].raw_capability,
    ]);
    expect(d[0].result).toBe("declined");
    expect((await admit(f, b, 1)).result).toBe("admitted");
  });
});

describe("0324 two simultaneous sends with one invitation remaining", () => {
  it("create exactly one invitation; the other is refused no_capacity; nobody deadlocks", async () => {
    const f = await fixture("race");
    const a = await entry(f, "a");
    const b = await entry(f, "b");
    const A = new Client({ connectionString: resolveLocalDbUrl() });
    const B = new Client({ connectionString: resolveLocalDbUrl() });
    await A.connect();
    await B.connect();
    try {
      await A.query("set statement_timeout = 15000");
      await B.query("set statement_timeout = 15000");
      const pidB = (await B.query("select pg_backend_pid() as pid")).rows[0].pid as number;
      const args = (entryId: string) => [f.studioId, f.userId, entryId, f.serviceId, day(1), day(14), null, 1];

      // A sends and HOLDS its transaction open: it owns the studio lock.
      await A.query("begin");
      const ra = await A.query(ADMIT, args(a));
      expect(ra.rows[0].result).toBe("admitted");

      // B's send must park on that lock rather than count a stale zero.
      await B.query("begin");
      const pendingB = B.query(ADMIT, args(b));
      expect(await waitUntilBlocked(pidB, 8000), "B never parked on A's studio lock").not.toBeNull();

      await A.query("commit");
      const rb = await pendingB;
      await B.query("commit");

      expect(rb.rows[0].result).toBe("no_capacity");
    } finally {
      await A.query("rollback").catch(() => undefined);
      await B.query("rollback").catch(() => undefined);
      await Promise.all([A.end(), B.end()].map((c) => c.catch(() => undefined)));
    }
    expect(await allInvitations(f.studioId)).toBe(1);
    expect(await liveCount(f.studioId)).toBe(1);
  });
});

describe("0324 the residual race, proved as it stands", () => {
  async function withAvailability(label: string) {
    const f = await fixture(label);
    for (let d = 0; d < 7; d += 1) {
      await q(
        `insert into public.studio_availability_default (studio_id,day_of_week,is_open,open_time,close_time,practitioner_id)
         values ($1,$2,true,'08:00','20:00',null)`,
        [f.studioId, d],
      );
    }
    return f;
  }

  it("a fit that was computed as 0 is enforced even though the studio has open hours", async () => {
    const f = await withAvailability("fit0");
    const e = await entry(f, "e");
    expect((await admit(f, e, 0)).result).toBe("no_capacity");
  });

  it("a slot taken AFTER the fit was computed is not seen by the guard", async () => {
    const f = await withAvailability("gap");
    const e = await entry(f, "e");
    // The sender computed fit = 1 from the slot engine ...
    const fitComputedAtSend = 1;
    // ... then, before the studio lock, availability disappears (a booking, a block, a closed day).
    await q(`update public.studio_availability_default set is_open = false where studio_id = $1`, [f.studioId]);
    // The guard counts live invitations only. It cannot recompute availability, so it admits.
    // This is the named residual: availability can change, invitations don't reserve appointments.
    expect((await admit(f, e, fitComputedAtSend)).result).toBe("admitted");
  });
});

describe("0324 privileges", () => {
  const INTERNAL = "public.count_waitlist_competing_invitations_internal(uuid,date,date,smallint[])";
  const ADMIT_SIG = "public.admit_new_client_waitlist_entry(uuid,uuid,uuid,uuid,date,date,smallint[],integer,integer)";

  it("the internal count is executable by no role", async () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      const r = await q<{ ok: boolean }>(`select has_function_privilege($1, $2, 'EXECUTE') as ok`, [role, INTERNAL]);
      expect(r[0].ok, role).toBe(false);
    }
  });

  it("PUBLIC holds EXECUTE on neither function", async () => {
    const r = await q<{ n: number }>(
      `select count(*)::int as n from pg_proc p cross join lateral aclexplode(p.proacl) a
        where p.oid in ($1::regprocedure, $2::regprocedure) and a.grantee = 0`,
      [ADMIT_SIG, INTERNAL],
    );
    expect(r[0].n).toBe(0);
  });

  it("admit is executable by service_role only", async () => {
    const yes = await q<{ ok: boolean }>(`select has_function_privilege('service_role', $1, 'EXECUTE') as ok`, [ADMIT_SIG]);
    expect(yes[0].ok).toBe(true);
    for (const role of ["anon", "authenticated"]) {
      const r = await q<{ ok: boolean }>(`select has_function_privilege($1, $2, 'EXECUTE') as ok`, [role, ADMIT_SIG]);
      expect(r[0].ok, role).toBe(false);
    }
  });

  it("calling the internal count as service_role is refused at the privilege layer", async () => {
    const f = await fixture("priv");
    await expect(
      asRole("service_role", (query) =>
        query(`select public.count_waitlist_competing_invitations_internal($1,$2,$3,null)`, [f.studioId, day(1), day(3)]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
