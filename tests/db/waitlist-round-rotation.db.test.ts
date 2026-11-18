import { afterAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { adminQuery, closePool, resolveLocalDbUrl, seedStudio } from "./helpers/harness";
import { waitUntilBlocked } from "./helpers/waitlist-concurrency";

const q = async <T>(text: string, params: unknown[] = []): Promise<T[]> =>
  (await adminQuery(text, params)).rows as T[];

// ===========================================================================
// 0324 -- A FULL ADMISSION ROUND MUST NOT GATE A SEND.
//
// Codex P2 on #1408: 0192 refuses to close a round while any offer it authorised
// is live (`live_offers_outstanding`), and refuses to issue from a full one
// (`round_full`). With the owner's round controls gone, a round that reached its
// allowance (redeemed seats count forever) blocked every send until every live
// offer settled, even when the studio-wide fit had room.
//
// The fix lives INSIDE the 9-argument admit, under the studio lock it already
// takes: after the fit guard, a full round is closed and a fresh one opened in
// the same transaction. 0192 is untouched. Safe because the fit guard counts
// live invitations STUDIO-WIDE across every round, so an offer left in a closed
// round still counts.
// ===========================================================================

afterAll(async () => {
  await closePool();
});

type Row = Record<string, unknown> & { result: string; raw_token: string };
type Fixture = { studioId: string; userId: string; serviceId: string };

/** A studio whose ONE open round has the given allowance (a legacy owner-typed round when small). */
async function fixture(label: string, roundAllowance: number): Promise<Fixture> {
  const s = await seedStudio(`r324-${label}`);
  const svc = await q<{ id: string }>(
    `insert into public.services (studio_id,name,default_duration_minutes,active,modality)
     values ($1,'Consultation',30,true,'consultation') returning id`,
    [s.studioId],
  );
  await q(`select * from public.open_new_client_waitlist_admission_round($1,$2,$3)`, [s.studioId, s.userId, roundAllowance]);
  return { studioId: s.studioId, userId: s.userId, serviceId: svc[0].id };
}

async function entry(f: Fixture, label: string): Promise<string> {
  const e = await q<{ result: string; entry_id: string }>(
    `select * from public.create_practitioner_waitlist_entry($1,$2,'Prospect',$3,null,null)`,
    [f.studioId, f.userId, `r324-${label}-${f.studioId.slice(0, 8)}@example.com`],
  );
  expect(e[0].result).toBe("created");
  return e[0].entry_id as string;
}

const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const ADMIT = `select * from public.admit_new_client_waitlist_entry($1,$2,$3,$4,$5,$6,$7::smallint[],72,$8)`;

async function admit(f: Fixture, entryId: string, fit: number, serviceId = f.serviceId) {
  const r = await q<Row>(ADMIT, [f.studioId, f.userId, entryId, serviceId, day(1), day(14), null, fit]);
  return r[0];
}

type Round = { id: string; allowance: number; closed_at: string | null; closed_by_practitioner_id: string | null };
const rounds = (studioId: string) =>
  q<Round>(
    `select id, allowance, closed_at, closed_by_practitioner_id from public.studio_waitlist_admission_rounds
      where studio_id = $1 order by opened_at, id`,
    [studioId],
  );
const openRounds = async (studioId: string) => (await rounds(studioId)).filter((r) => r.closed_at === null);

const liveCount = (studioId: string) =>
  q<{ n: number }>(
    `select count(*)::int as n from public.new_client_waitlist_invitations
      where studio_id = $1 and redeemed_at is null and expired_at is null
        and released_at is null and declined_at is null and expires_at > now()`,
    [studioId],
  ).then((r) => r[0].n);

/** A round of allowance 1 that is FULL because of one LIVE offer. */
async function fullRoundWithLiveOffer(label: string, allowance = 1) {
  const f = await fixture(label, allowance);
  const firstTokens: string[] = [];
  for (let i = 0; i < allowance; i++) {
    const e = await entry(f, `seed${i}`);
    const r = await admit(f, e, 50);
    expect(r.result).toBe("admitted");
    firstTokens.push(r.raw_token);
  }
  const before = await openRounds(f.studioId);
  expect(before).toHaveLength(1);
  // The pre-condition that makes the bug: 0192 will not close it.
  const closeTry = await q<{ close_new_client_waitlist_admission_round: string }>(
    `select public.close_new_client_waitlist_admission_round($1,$2) as close_new_client_waitlist_admission_round`,
    [f.studioId, f.userId],
  );
  expect(closeTry[0].close_new_client_waitlist_admission_round).toBe("live_offers_outstanding");
  return { f, firstTokens, fullRound: before[0] };
}

describe("a full round with live offers does not stop a send that the studio-wide fit allows", () => {
  it("full round + live offer + room -> admitted, in a fresh 100-seat round", async () => {
    const { f, fullRound } = await fullRoundWithLiveOffer("room");
    const e = await entry(f, "next");
    const r = await admit(f, e, 5);
    expect(r.result).toBe("admitted");

    const all = await rounds(f.studioId);
    expect(all).toHaveLength(2);
    const open = await openRounds(f.studioId);
    expect(open).toHaveLength(1);
    expect(open[0].id).not.toBe(fullRound.id);
    expect(open[0].allowance).toBe(100);
    const old = all.find((x) => x.id === fullRound.id)!;
    expect(old.closed_at).not.toBeNull();
    // Closed by the owner the database derived, never by a parameter.
    const owner = await q<{ id: string }>(`select id from public.practitioners where studio_id=$1 and user_id=$2`, [f.studioId, f.userId]);
    expect(old.closed_by_practitioner_id).toBe(owner[0].id);
    expect(await liveCount(f.studioId)).toBe(2);
  });

  it("a legacy small owner-typed round that is full of live offers -> admitted", async () => {
    const { f } = await fullRoundWithLiveOffer("legacy", 3);
    const e = await entry(f, "next");
    expect((await admit(f, e, 10)).result).toBe("admitted");
    expect(await openRounds(f.studioId)).toHaveLength(1);
    expect((await openRounds(f.studioId))[0].allowance).toBe(100);
  });

  it("full round + NO room -> no_capacity, and the round is left exactly as it was", async () => {
    const { f, fullRound } = await fullRoundWithLiveOffer("noroom");
    const e = await entry(f, "next");
    // fit 1 with one live competing offer: no_capacity takes precedence over round_full.
    expect((await admit(f, e, 1)).result).toBe("no_capacity");
    const open = await openRounds(f.studioId);
    expect(open).toHaveLength(1);
    expect(open[0].id).toBe(fullRound.id);
    expect(await rounds(f.studioId)).toHaveLength(1);
  });

  it("a send refused for another reason does not rotate the round", async () => {
    const { f, fullRound } = await fullRoundWithLiveOffer("refused");
    const e = await entry(f, "next");
    const bogusService = "00000000-0000-4000-8000-000000000000";
    const r = await admit(f, e, 5, bogusService);
    expect(r.result).not.toBe("admitted");
    const open = await openRounds(f.studioId);
    expect(open).toHaveLength(1);
    expect(open[0].id).toBe(fullRound.id);
    expect(await rounds(f.studioId)).toHaveLength(1);
  });

  it("an offer left behind in the closed round still counts in the guard and still redeems", async () => {
    const { f, firstTokens, fullRound } = await fullRoundWithLiveOffer("behind");
    const e2 = await entry(f, "second");
    expect((await admit(f, e2, 2)).result).toBe("admitted"); // rotates
    const e3 = await entry(f, "third");
    // fit 2, two live offers (one in the closed round): the guard still sees the left-behind one.
    expect((await admit(f, e3, 2)).result).toBe("no_capacity");

    const red = await q<{ result: string }>(`select result from public.redeem_new_client_waitlist_invitation($1)`, [firstTokens[0]]);
    expect(["invalid_token", "not_live"]).not.toContain(red[0].result);
    const inv = await q<{ redeemed_at: string | null; admission_round_id: string }>(
      `select redeemed_at, admission_round_id from public.new_client_waitlist_invitations where token_hash is not null and admission_round_id = $1`,
      [fullRound.id],
    );
    expect(inv).toHaveLength(1);
    expect(inv[0].redeemed_at).not.toBeNull();
  });
});

describe("rotation is conditional", () => {
  it("a round that is NOT full is never rotated", async () => {
    const f = await fixture("notfull", 100);
    const a = await entry(f, "a");
    const b = await entry(f, "b");
    expect((await admit(f, a, 5)).result).toBe("admitted");
    const before = await openRounds(f.studioId);
    expect((await admit(f, b, 5)).result).toBe("admitted");
    const after = await openRounds(f.studioId);
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(await rounds(f.studioId)).toHaveLength(1);
  });
});

describe("rotation racing a concurrent send", () => {
  it("two sends that both find the round full: one rotates, the other uses the fresh round and does not close it", async () => {
    const { f } = await fullRoundWithLiveOffer("bothfull");
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
      const args = (entryId: string) => [f.studioId, f.userId, entryId, f.serviceId, day(1), day(14), null, 5];
      await A.query("begin");
      expect((await A.query(ADMIT, args(a))).rows[0].result).toBe("admitted");
      await B.query("begin");
      const pendingB = B.query(ADMIT, args(b));
      expect(await waitUntilBlocked(pidB, 8000), "B never parked on A's studio lock").not.toBeNull();
      await A.query("commit");
      expect((await pendingB).rows[0].result).toBe("admitted");
      await B.query("commit");
    } finally {
      await A.query("rollback").catch(() => undefined);
      await B.query("rollback").catch(() => undefined);
      await Promise.all([A.end(), B.end()].map((c) => c.catch(() => undefined)));
    }
    expect(await liveCount(f.studioId)).toBe(3);
    expect(await openRounds(f.studioId)).toHaveLength(1);
    expect(await rounds(f.studioId)).toHaveLength(2);
  });

  it("two sends at the last seat of a full round: exactly one wins, the other no_capacity, no deadlock", async () => {
    const { f } = await fullRoundWithLiveOffer("race");
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
      const args = (entryId: string) => [f.studioId, f.userId, entryId, f.serviceId, day(1), day(14), null, 2];

      await A.query("begin");
      const ra = await A.query(ADMIT, args(a));
      expect(ra.rows[0].result).toBe("admitted"); // A rotated the round and holds the studio lock

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
    expect(await liveCount(f.studioId)).toBe(2);
    expect(await openRounds(f.studioId)).toHaveLength(1);
    expect(await rounds(f.studioId)).toHaveLength(2);
  });
});

describe("no new callable surface", () => {
  it("the round is rotated only inside admit: no rotate function exists, and admit stays service_role only", async () => {
    const fns = await q<{ proname: string }>(
      `select proname from pg_proc where pronamespace = 'public'::regnamespace and proname like '%rotate%admission%'`,
    );
    expect(fns).toEqual([]);
    const acl = await q<{ roles: string }>(
      `select coalesce((select string_agg(r, ',' order by r) from (values ('anon'),('authenticated'),('service_role')) x(r)
                         where has_function_privilege(x.r, p.oid, 'EXECUTE')), '') as roles
         from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'admit_new_client_waitlist_entry'`,
    );
    expect(acl).toEqual([{ roles: "service_role" }]);
  });
});
