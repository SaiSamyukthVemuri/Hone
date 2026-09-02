import { afterAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { adminQuery, closePool, resolveLocalDbUrl } from "./helpers/harness";

// 0189 — TTL decisions must use the WALL CLOCK, read AFTER the lock.
//
// THE DEFECT THIS FILE EXISTS TO KEEP CLOSED. PostgreSQL's `now()` is
// `transaction_timestamp()`: fixed at the instant the transaction began, and it
// never advances however long that transaction runs or waits. 0188 decided
// every TTL question with `now()`, so a transaction that BEGAN while an
// invitation was live decided as though it still were — and an expired
// invitation redeemed.
//
// WHY THIS IS NOT A SLEEP-ONLY PROBABILISTIC TEST. Every precondition is
// ASSERTED, never assumed: that the transaction really began before the
// deadline, that the wall clock really passed it, and — in the load-bearing
// case — that the redeeming backend was really BLOCKED on a lock, proved by
// polling pg_stat_activity until wait_event_type = 'Lock'. That is the same
// standard the public-reschedule concurrency proofs in this suite already use.
//
// Fixtures are isolated by run-unique identity, never by cleanup.

afterAll(async () => {
  await closePool();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function conn(): Promise<Client> {
  const c = new Client({ connectionString: resolveLocalDbUrl() });
  await c.connect();
  return c;
}

/** Poll pg_stat_activity until `pid` is genuinely waiting on a lock. */
async function waitUntilBlocked(pid: number, timeoutMs = 12000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await adminQuery(
      `select wait_event_type, wait_event from pg_stat_activity where pid = $1`,
      [pid],
    );
    if (r.rows[0]?.wait_event_type === "Lock") {
      return `${r.rows[0].wait_event_type}/${r.rows[0].wait_event}`;
    }
    await sleep(50);
  }
  return null;
}

/** Block until the SERVER's wall clock has passed `expiresAt`, and prove it. */
async function waitPastDeadline(expiresAt: Date): Promise<Date> {
  for (let i = 0; i < 800; i += 1) {
    const r = await adminQuery(
      `select clock_timestamp() as nowc, clock_timestamp() > $1::timestamptz as past`,
      [expiresAt.toISOString()],
    );
    if (r.rows[0].past) return r.rows[0].nowc as Date;
    await sleep(50);
  }
  throw new Error("the deadline never passed");
}

type Fixture = { studioId: string; userId: string; entryId: string; token: string; invId: string; expiresAt: Date };

async function seedStudioOwner(label: string) {
  const studioId = randomUUID();
  const userId = randomUUID();
  const practitionerId = randomUUID();
  const uniq = randomUUID().slice(0, 8);
  const mail = `${label}-${uniq}@harness.local`;
  await adminQuery(
    `insert into auth.users (id, email, aud, role) values ($1,$2,'authenticated','authenticated')`,
    [userId, mail],
  );
  await adminQuery(
    `insert into public.studios (id, name, slug, timezone, owner_email) values ($1,$2,$3,'UTC',$4)`,
    [studioId, `${label} ${uniq}`, `${label}-${uniq}`, mail],
  );
  await adminQuery(
    `insert into public.practitioners (id, studio_id, user_id, display_name, email, role, active)
     values ($1,$2,$3,$4,$5,'owner',true)`,
    [practitionerId, studioId, userId, `Owner ${uniq}`, mail],
  );
  return { studioId, userId, uniq };
}

/**
 * A live invitation whose window closes `seconds` from NOW.
 *
 * expires_at is frozen by 0188's append-only trigger, so moving it requires the
 * table owner with that trigger disabled — which is itself the proof that no
 * application role can manufacture or postpone an expiry.
 */
async function issueExpiringIn(label: string, seconds: number): Promise<Fixture> {
  const s = await seedStudioOwner(label);
  const j = await adminQuery(
    `select entry_id from public.join_new_client_waitlist($1,$2,$3,null)`,
    [s.studioId, `P ${s.uniq}`, `p-${s.uniq}@harness.local`],
  );
  const entryId = j.rows[0].entry_id as string;
  await adminQuery(`select public.claim_new_client_waitlist_entry($1,$2,$3)`, [
    s.studioId,
    entryId,
    s.userId,
  ]);
  const iss = await adminQuery(
    `select result, raw_token from public.issue_new_client_waitlist_invitation($1,$2,$3,72)`,
    [s.studioId, entryId, s.userId],
  );
  expect(iss.rows[0].result).toBe("invited");

  const upd = await withAppendOnlyDisabled(() =>
    adminQuery(
      `update public.new_client_waitlist_invitations
          set expires_at = clock_timestamp() + make_interval(secs => $2)
        where entry_id = $1 and redeemed_at is null and expired_at is null and released_at is null
        returning id, expires_at`,
      [entryId, seconds],
    ),
  );

  return {
    studioId: s.studioId,
    userId: s.userId,
    entryId,
    token: iss.rows[0].raw_token as string,
    invId: upd.rows[0].id as string,
    expiresAt: upd.rows[0].expires_at as Date,
  };
}

/**
 * Re-stamp the deadline to `seconds` from NOW.
 *
 * WHY THIS EXISTS. Seeding a short window and only THEN opening connections
 * makes the test depend on how long setup took: on a cold database straight
 * after `db reset` the window elapsed before the contending transaction had
 * even begun, and the run failed on its own precondition. Stamping the deadline
 * at the last moment removes setup duration from the measurement entirely.
 *
 * Must be called BEFORE any session locks the row, or it would block itself.
 */
async function withAppendOnlyDisabled<T>(fn: () => Promise<T>): Promise<T> {
  // try/finally IS LOAD-BEARING. An earlier draft called this while another
  // session held the row; the UPDATE blocked, the trigger stayed DISABLED, and
  // every later test in the file timed out behind the held ALTER TABLE lock.
  // The guard is cheap and the failure it prevents is not local to one test.
  await adminQuery(
    `alter table public.new_client_waitlist_invitations disable trigger new_client_waitlist_invitations_append_only`,
  );
  try {
    return await fn();
  } finally {
    await adminQuery(
      `alter table public.new_client_waitlist_invitations enable trigger new_client_waitlist_invitations_append_only`,
    );
  }
}

async function restampExpiry(invId: string, seconds: number): Promise<Date> {
  const u = await withAppendOnlyDisabled(() =>
    adminQuery(
      `update public.new_client_waitlist_invitations
          set expires_at = clock_timestamp() + make_interval(secs => $2)
        where id = $1 returning expires_at`,
      [invId, seconds],
    ),
  );
  return u.rows[0].expires_at as Date;
}

const stateOf = async (invId: string) =>
  (
    await adminQuery(
      `select redeemed_at, expired_at, released_at from public.new_client_waitlist_invitations where id=$1`,
      [invId],
    )
  ).rows[0] as { redeemed_at: Date | null; expired_at: Date | null; released_at: Date | null };

const entryStatus = async (entryId: string) =>
  (await adminQuery(`select status from public.new_client_waitlist_entries where id=$1`, [entryId]))
    .rows[0].status as string;

// ---------------------------------------------------------------------------
describe("A — before the deadline, with no wait", () => {
  it("redeems", async () => {
    const f = await issueExpiringIn("wc-a", 120);
    const r = await adminQuery(
      `select result from public.redeem_new_client_waitlist_invitation($1)`,
      [f.token],
    );
    expect(r.rows[0].result).toBe("redeemed");
    const st = await stateOf(f.invId);
    expect(st.redeemed_at).not.toBeNull();
    // The stamp is the DECISION instant, not the transaction start.
    expect(st.redeemed_at!.getTime()).toBeLessThanOrEqual(f.expiresAt.getTime());
  });
});

describe("B — after the deadline, transaction also starts after it", () => {
  it("refuses, exactly as it always did", async () => {
    const f = await issueExpiringIn("wc-b", 1);
    await waitPastDeadline(f.expiresAt);
    const r = await adminQuery(
      `select result from public.redeem_new_client_waitlist_invitation($1)`,
      [f.token],
    );
    expect(r.rows[0].result).toBe("invalid_token");
    expect((await stateOf(f.invId)).redeemed_at).toBeNull();
  });
});

describe("C — THE LOAD-BEARING CASE: begins before, blocks, released after", () => {
  it("refuses a redemption whose window closed while it waited on a lock", async () => {
    const f = await issueExpiringIn("wc-c", 6);

    // The deadline is stamped BEFORE anything locks the row, so setup duration
    // cannot consume the window and this call cannot block on a holder.
    const deadline = await restampExpiry(f.invId, CROSS_DEADLINE_SECONDS);

    // TX-A holds the invitation row so redemption cannot complete.
    const a = await conn();
    await a.query("begin");
    await a.query(
      `select 1 from public.new_client_waitlist_invitations where id = $1 for update`,
      [f.invId],
    );

    // TX-B begins while the invitation is still LIVE.
    const b = await conn();
    await b.query("begin");
    const t0 = (await b.query(`select transaction_timestamp() as t, pg_backend_pid() as pid`))
      .rows[0] as { t: Date; pid: number };
    expect(
      t0.t.getTime(),
      "PRECONDITION: the redeeming transaction must begin BEFORE the deadline",
    ).toBeLessThan(deadline.getTime());

    // Fire the redemption WITHOUT awaiting it, then prove it is really blocked.
    const pending = b.query(
      `select result from public.redeem_new_client_waitlist_invitation($1)`,
      [f.token],
    );
    const ev = await waitUntilBlocked(t0.pid);
    expect(ev, "the redeeming backend never actually blocked on a lock").not.toBeNull();
    expect(ev).toContain("Lock");

    // The window closes WHILE it waits.
    const releasedAt = await waitPastDeadline(deadline);
    expect(releasedAt.getTime()).toBeGreaterThan(deadline.getTime());

    // Release WITHOUT invalidating the invitation, so the only thing that can
    // refuse the redemption is the TTL itself.
    await a.query("rollback");
    await a.end();

    const r = (await pending).rows[0] as { result: string };
    await b.query("commit");
    await b.end();

    expect(
      r.result,
      "an invitation whose window closed while the redemption waited must NOT redeem",
    ).toBe("invalid_token");
    const st = await stateOf(f.invId);
    expect(st.redeemed_at).toBeNull();
    expect(await entryStatus(f.entryId)).toBe("invited");
  });
});

describe("D — NEGATIVE CONTROL: 0188's frozen predicate would have redeemed it", () => {
  it("the transaction-clock predicate admits the row the wall-clock one refuses", async () => {
    const f = await issueExpiringIn("wc-d", 3);

    const b = await conn();
    await b.query("begin");
    const t0 = (await b.query(`select transaction_timestamp() as t`)).rows[0] as { t: Date };
    expect(t0.t.getTime()).toBeLessThan(f.expiresAt.getTime());

    await waitPastDeadline(f.expiresAt);

    // Inside this transaction the two clocks now disagree, which is the whole
    // mechanism.
    const clocks = (await b.query(`select now() as n, clock_timestamp() as c`)).rows[0] as {
      n: Date;
      c: Date;
    };
    expect(clocks.n.getTime()).toBeLessThan(f.expiresAt.getTime());
    expect(clocks.c.getTime()).toBeGreaterThan(f.expiresAt.getTime());

    // 0188's EXACT guarded update, run inline. It is not a paraphrase: it is the
    // frozen predicate, and it still matches the row — so 0188 would have
    // redeemed an expired invitation here. Rolled back, so nothing is written.
    const would = await b.query(
      `update public.new_client_waitlist_invitations i
          set redeemed_at = now()
        where i.token_hash  = encode(extensions.digest($1, 'sha256'), 'hex')
          and i.redeemed_at is null
          and i.expired_at  is null
          and i.released_at is null
          and i.expires_at  > now()
      returning i.id`,
      [f.token],
    );
    expect(
      would.rowCount,
      "0188's predicate no longer reproduces the defect — this control is vacuous",
    ).toBe(1);
    await b.query("rollback");
    await b.end();

    // Nothing was written, and the REPAIRED command refuses the same row.
    expect((await stateOf(f.invId)).redeemed_at).toBeNull();
    const r = await adminQuery(
      `select result from public.redeem_new_client_waitlist_invitation($1)`,
      [f.token],
    );
    expect(r.rows[0].result).toBe("invalid_token");
  });
});

describe("E — the expiry command decides on the post-lock clock too", () => {
  it("reports `expired` for a window that closed while it waited on the entry mutex", async () => {
    // THE MIRROR-IMAGE DEFECT. expire() compares `expires_at <= now()`, so a
    // stale clock made it too CONSERVATIVE: it answered `not_expired` for an
    // invitation whose window had in fact closed while the call waited.
    const f = await issueExpiringIn("wc-e", 6);

    const deadline = await restampExpiry(f.invId, CROSS_DEADLINE_SECONDS);

    // TX-A holds the ENTRY row — the mutex expire() takes first.
    const a = await conn();
    await a.query("begin");
    await a.query(`select 1 from public.new_client_waitlist_entries where id = $1 for update`, [
      f.entryId,
    ]);

    const b = await conn();
    await b.query("begin");
    const t0 = (await b.query(`select transaction_timestamp() as t, pg_backend_pid() as pid`))
      .rows[0] as { t: Date; pid: number };
    expect(t0.t.getTime()).toBeLessThan(deadline.getTime());

    const pending = b.query(
      `select public.expire_new_client_waitlist_invitation($1,$2,$3) as r`,
      [f.studioId, f.entryId, f.userId],
    );
    const ev = await waitUntilBlocked(t0.pid);
    expect(ev, "the expiring backend never actually blocked on the entry mutex").not.toBeNull();

    await waitPastDeadline(deadline);
    await a.query("rollback");
    await a.end();

    const r = (await pending).rows[0] as { r: string };
    await b.query("commit");
    await b.end();

    expect(
      r.r,
      "the TTL elapsed while this call waited, so the truthful answer is `expired`",
    ).toBe("expired");
    const st = await stateOf(f.invId);
    expect(st.expired_at).not.toBeNull();
    expect(await entryStatus(f.entryId)).toBe("expired");
  });

  it("still refuses to expire a window that has NOT closed", async () => {
    // The 0188 repair this must not undo: expiry means the TTL elapsed, and is
    // not a second word for release.
    const f = await issueExpiringIn("wc-e2", 120);
    const r = await adminQuery(
      `select public.expire_new_client_waitlist_invitation($1,$2,$3) as r`,
      [f.studioId, f.entryId, f.userId],
    );
    expect(r.rows[0].r).toBe("not_expired");
    expect((await stateOf(f.invId)).expired_at).toBeNull();
    expect(await entryStatus(f.entryId)).toBe("invited");
  });
});

describe("F — redeem || expire across the deadline stays coherent", () => {
  it("yields exactly one terminal state, never both", async () => {
    const f = await issueExpiringIn("wc-f", 5);

    const deadline = await restampExpiry(f.invId, CROSS_DEADLINE_SECONDS);

    // A redemption begins while live and blocks behind the invitation holder.
    const a = await conn();
    await a.query("begin");
    await a.query(`select 1 from public.new_client_waitlist_invitations where id = $1 for update`, [
      f.invId,
    ]);

    const b = await conn();
    await b.query("begin");
    const t0 = (await b.query(`select transaction_timestamp() as t, pg_backend_pid() as pid`))
      .rows[0] as { t: Date; pid: number };
    expect(t0.t.getTime()).toBeLessThan(deadline.getTime());
    const redeeming = b.query(
      `select result from public.redeem_new_client_waitlist_invitation($1)`,
      [f.token],
    );
    expect(await waitUntilBlocked(t0.pid)).not.toBeNull();

    await waitPastDeadline(deadline);
    await a.query("rollback");
    await a.end();

    const redeemed = (await redeeming).rows[0] as { result: string };
    await b.query("commit");
    await b.end();

    // ...and only then does the operator expire it.
    const expired = await adminQuery(
      `select public.expire_new_client_waitlist_invitation($1,$2,$3) as r`,
      [f.studioId, f.entryId, f.userId],
    );

    expect(redeemed.result).toBe("invalid_token");
    expect(expired.rows[0].r).toBe("expired");

    const st = await stateOf(f.invId);
    // EXACTLY ONE outcome column is set. A dual terminal state is the shape
    // this asserts against.
    const set = [st.redeemed_at, st.expired_at, st.released_at].filter((x) => x !== null);
    expect(set).toHaveLength(1);
    expect(st.expired_at).not.toBeNull();
    expect(st.redeemed_at).toBeNull();
  });
});

describe("H — the deployed contract is unchanged apart from the body", () => {
  it("both signatures and return types are byte-identical to 0188's", async () => {
    const r = await adminQuery(
      `select p.proname,
              pg_get_function_identity_arguments(p.oid) as args,
              pg_get_function_result(p.oid)             as result,
              p.prosecdef                                as secdef,
              p.provolatile                              as volatile,
              array_to_string(p.proconfig, ',')          as config
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('redeem_new_client_waitlist_invitation',
                            'expire_new_client_waitlist_invitation')
        order by p.proname`,
    );
    expect(r.rows).toHaveLength(2);
    const [expire, redeem] = r.rows as Array<Record<string, string | boolean>>;

    expect(expire.args).toBe("p_studio_id uuid, p_entry_id uuid, p_actor_user_id uuid");
    expect(expire.result).toBe("text");
    expect(redeem.args).toBe("p_raw_token text");
    expect(redeem.result).toBe("TABLE(result text, studio_id uuid, entry_id uuid)");

    for (const fn of [expire, redeem]) {
      expect(fn.secdef, "SECURITY DEFINER was dropped").toBe(true);
      expect(fn.volatile, "volatility changed").toBe("v");
      expect(fn.config).toBe("search_path=pg_catalog, pg_temp");
    }
  });

  it("EXECUTE is held by service_role alone; anon and authenticated hold none", async () => {
    const r = await adminQuery(
      `select p.proname,
              has_function_privilege('anon',          p.oid, 'EXECUTE') as anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as authed,
              has_function_privilege('service_role',  p.oid, 'EXECUTE') as svc
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('redeem_new_client_waitlist_invitation',
                            'expire_new_client_waitlist_invitation')`,
    );
    expect(r.rows).toHaveLength(2);
    for (const row of r.rows as Array<Record<string, boolean>>) {
      expect(row.anon).toBe(false);
      expect(row.authed).toBe(false);
      expect(row.svc).toBe(true);
    }
  });

  it("token_hash is still unreadable by authenticated", async () => {
    // 0188's column-level posture must survive a function replacement.
    const r = await adminQuery(
      `select has_column_privilege('authenticated','public.new_client_waitlist_invitations','token_hash','SELECT') as t`,
    );
    expect(r.rows[0].t).toBe(false);
  });
});

// ===========================================================================
// 0189 P2 — THE EXPIRY DECISION MUST FOLLOW THE INVITATION LOCK, NOT ONLY THE
// ENTRY LOCK.
//
// The first draft of 0189 moved the clock read to just after 0188's ENTRY
// mutex. That is not far enough: the statement that actually serializes the
// terminal outcome is the INVITATION update, and it can block long after the
// clock was read. Measured on that draft — TTL already elapsed, a second
// session holding the invitation row, the holder rolling back 3.15 s later —
// expiry succeeded and stamped `expired_at` 3,150 ms BEFORE the lock that
// serialized it, and the interval is unbounded because a holder may wait
// arbitrarily long.
//
// The commit variant was worse: the pre-UPDATE "already redeemed" check ran
// before the invitation lock, so it read a snapshot without the competing
// redemption. The command then answered `not_expired` for an invitation that
// had been REDEEMED, leaving the entry `invited`.
// ===========================================================================

/** Lock an entry's current-cycle invitation from an independent session. */
async function holdInvitation(invId: string) {
  const c = await conn();
  await c.query("begin");
  await c.query(`select 1 from public.new_client_waitlist_invitations where id = $1 for update`, [
    invId,
  ]);
  return c;
}

/** An invitation whose TTL has ALREADY elapsed. The ttl CHECK is
 *  (expires_at > issued_at, within 7 days), so both anchors move together. */
async function issueAlreadyElapsed(label: string): Promise<Fixture> {
  const f = await issueExpiringIn(label, 60);
  const u = await withAppendOnlyDisabled(() =>
    adminQuery(
      `update public.new_client_waitlist_invitations
          set issued_at  = clock_timestamp() - interval '4 days',
              expires_at = clock_timestamp() - interval '1 minute'
        where id = $1 returning expires_at`,
      [f.invId],
    ),
  );
  return { ...f, expiresAt: u.rows[0].expires_at as Date };
}

const HOLD_MS = 2500;

/**
 * How far ahead the cross-deadline cases put their deadline.
 *
 * It has to outlast ALL the setup that happens after it is stamped — opening
 * connections, beginning the transaction, and PROVING the backend is blocked —
 * because the precondition is that the transaction begins while the invitation
 * is still live. At 6s this passed alone and on the full lane but failed once in
 * a four-file run on a cold database, which is a flaky test rather than a real
 * failure. The window is widened rather than the precondition relaxed: a test
 * that sometimes proves nothing is worse than a slow one.
 */
const CROSS_DEADLINE_SECONDS = 14;

describe("A — NEGATIVE CONTROL: the entry-lock-only shape produces stale provenance", () => {
  it("an early clock plus a blocked invitation update stamps before the serializing lock", async () => {
    // THE PRE-REPAIR SHAPE, RUN INLINE. Not a paraphrase of the old function: it
    // is the same order of operations — entry lock, THEN clock, THEN the
    // invitation update that blocks. If this control ever stops drifting, the
    // repair below has become untestable and this file says so.
    const f = await issueAlreadyElapsed("p2-neg");
    const holder = await holdInvitation(f.invId);

    const b = await conn();
    await b.query("begin");
    const pid = (await b.query(`select pg_backend_pid() as pid`)).rows[0].pid as number;

    // 1. entry mutex   2. clock   3. the update that will block
    await b.query(`select 1 from public.new_client_waitlist_entries where id = $1 for update`, [
      f.entryId,
    ]);
    const early = (await b.query(`select clock_timestamp() as t`)).rows[0].t as Date;
    const blocked = b.query(
      `update public.new_client_waitlist_invitations
          set expired_at = $2::timestamptz
        where entry_id = $1 and redeemed_at is null and expired_at is null and released_at is null
          and expires_at <= $2::timestamptz
        returning id`,
      [f.entryId, early.toISOString()],
    );
    expect(await waitUntilBlocked(pid), "the control never blocked").not.toBeNull();

    await sleep(HOLD_MS);
    const releaseBoundary = (await adminQuery(`select clock_timestamp() as t`)).rows[0].t as Date;
    await holder.query("rollback");
    await holder.end();

    const res = await blocked;
    expect(res.rowCount).toBe(1);
    await b.query("rollback");
    await b.end();

    const drift = releaseBoundary.getTime() - early.getTime();
    expect(
      drift,
      "the control is vacuous: the pre-repair shape no longer drifts, so B proves nothing",
    ).toBeGreaterThan(HOLD_MS - 500);
  });
});

describe("B — REPAIRED: the decision instant follows the invitation lock", () => {
  it("stamps expired_at at or after the moment the holder released", async () => {
    const f = await issueAlreadyElapsed("p2-b");
    const holder = await holdInvitation(f.invId);

    const b = await conn();
    await b.query("begin");
    const pid = (await b.query(`select pg_backend_pid() as pid`)).rows[0].pid as number;
    const pending = b.query(
      `select public.expire_new_client_waitlist_invitation($1,$2,$3) as r`,
      [f.studioId, f.entryId, f.userId],
    );
    expect(await waitUntilBlocked(pid), "expire never blocked on the invitation").not.toBeNull();

    // It is past the ENTRY mutex and waiting on the INVITATION: a third session
    // asking for the entry row must therefore block behind it.
    const third = await conn();
    await third.query("begin");
    const tpid = (await third.query(`select pg_backend_pid() as pid`)).rows[0].pid as number;
    const thirdPending = third.query(
      `select 1 from public.new_client_waitlist_entries where id = $1 for update`,
      [f.entryId],
    );
    expect(
      await waitUntilBlocked(tpid, 5000),
      "expire is not holding the entry mutex, so it never reached the invitation lock",
    ).not.toBeNull();

    await sleep(HOLD_MS);
    const releaseBoundary = (await adminQuery(`select clock_timestamp() as t`)).rows[0].t as Date;
    await holder.query("rollback");
    await holder.end();

    const r = (await pending).rows[0] as { r: string };
    await b.query("commit");
    await b.end();
    await thirdPending.catch(() => undefined);
    await third.query("rollback");
    await third.end();

    expect(r.r).toBe("expired");
    const st = await stateOf(f.invId);
    expect(st.expired_at).not.toBeNull();

    // THE ASSERTION THE CONTROL ABOVE MAKES MEANINGFUL. The stamp must not
    // predate the lock that serialized it. A small negative tolerance covers the
    // ordering of two separate clock reads on the same server.
    const drift = releaseBoundary.getTime() - st.expired_at!.getTime();
    expect(
      drift,
      `expired_at is ${drift}ms BEFORE the serializing lock release — stale provenance`,
    ).toBeLessThan(250);
    expect(await entryStatus(f.entryId)).toBe("expired");

    // Invitation and entry are stamped from the SAME decision value.
    const ent = await adminQuery(
      `select expired_at from public.new_client_waitlist_entries where id=$1`,
      [f.entryId],
    );
    expect((ent.rows[0].expired_at as Date).getTime()).toBe(st.expired_at!.getTime());
  });
});

describe("C — REPAIRED: a redemption that commits during the wait is seen", () => {
  it("answers already_redeemed and expires nothing", async () => {
    const f = await issueExpiringIn("p2-c", 4);

    const deadline = await restampExpiry(f.invId, CROSS_DEADLINE_SECONDS);

    // TX-A redeems while the invitation is live, and holds it uncommitted.
    const a = await conn();
    await a.query("begin");
    const red = await a.query(
      `select result from public.redeem_new_client_waitlist_invitation($1)`,
      [f.token],
    );
    expect(red.rows[0].result).toBe("redeemed");

    const b = await conn();
    await b.query("begin");
    const pid = (await b.query(`select pg_backend_pid() as pid`)).rows[0].pid as number;
    const pending = b.query(
      `select public.expire_new_client_waitlist_invitation($1,$2,$3) as r`,
      [f.studioId, f.entryId, f.userId],
    );
    // THE REPAIR IS WHAT MAKES THIS BLOCK. The pre-repair shape did not: its
    // update matched no row (the TTL had not elapsed at its early clock), so it
    // sailed past and answered `not_expired` for a redeemed invitation.
    expect(await waitUntilBlocked(pid), "expire did not wait for the redemption").not.toBeNull();

    await waitPastDeadline(deadline); // TTL elapses while it waits
    await a.query("commit");
    await a.end();

    const r = (await pending).rows[0] as { r: string };
    await b.query("commit");
    await b.end();

    expect(r.r).toBe("already_redeemed");
    const st = await stateOf(f.invId);
    expect(st.redeemed_at).not.toBeNull();
    expect(st.expired_at, "a redeemed invitation must never be expired").toBeNull();
    expect(await entryStatus(f.entryId)).toBe("invited");
  });
});

describe("D/E — the uncontended cases are unchanged", () => {
  it("D — an elapsed TTL expires normally", async () => {
    const f = await issueAlreadyElapsed("p2-d");
    const r = await adminQuery(
      `select public.expire_new_client_waitlist_invitation($1,$2,$3) as r`,
      [f.studioId, f.entryId, f.userId],
    );
    expect(r.rows[0].r).toBe("expired");
    expect((await stateOf(f.invId)).expired_at).not.toBeNull();
    expect(await entryStatus(f.entryId)).toBe("expired");
  });

  it("E — a live window is not_expired and writes no timestamp", async () => {
    const f = await issueExpiringIn("p2-e", 120);
    const r = await adminQuery(
      `select public.expire_new_client_waitlist_invitation($1,$2,$3) as r`,
      [f.studioId, f.entryId, f.userId],
    );
    expect(r.rows[0].r).toBe("not_expired");
    expect((await stateOf(f.invId)).expired_at).toBeNull();
    expect(await entryStatus(f.entryId)).toBe("invited");
  });
});

describe("G/H — release and issue still interleave coherently", () => {
  it("G — release || expire: no deadlock, exactly one terminal outcome", async () => {
    const f = await issueAlreadyElapsed("p2-g");
    const [rel, exp] = await Promise.all([
      adminQuery(`select public.release_new_client_waitlist_entry($1,$2,$3) as r`, [
        f.studioId,
        f.entryId,
        f.userId,
      ]).then((x) => x.rows[0].r as string),
      adminQuery(`select public.expire_new_client_waitlist_invitation($1,$2,$3) as r`, [
        f.studioId,
        f.entryId,
        f.userId,
      ]).then((x) => x.rows[0].r as string),
    ]);
    const st = await stateOf(f.invId);
    const terminal = [st.redeemed_at, st.expired_at, st.released_at].filter((x) => x !== null);
    expect(terminal, `release=${rel} expire=${exp} left ${terminal.length} terminal columns`)
      .toHaveLength(1);
    expect(["released", "expired"]).toContain(await entryStatus(f.entryId));
  });

  it("H — the entry mutex still orders issue against expire", async () => {
    // issue() takes the same entry lock, so a second invitation cannot appear
    // underneath an in-flight expiry.
    const f = await issueAlreadyElapsed("p2-h");
    const r = await adminQuery(
      `select public.expire_new_client_waitlist_invitation($1,$2,$3) as r`,
      [f.studioId, f.entryId, f.userId],
    );
    expect(r.rows[0].r).toBe("expired");
    // The entry is `expired`, so issuing again is refused until it is requeued.
    const again = await adminQuery(
      `select result from public.issue_new_client_waitlist_invitation($1,$2,$3,72)`,
      [f.studioId, f.entryId, f.userId],
    );
    expect(again.rows[0].result).toBe("not_claimed");
  });
});

describe("I — expiry acts on the CURRENT cycle, never a historical invitation", () => {
  it("locks and expires the newest invitation when the entry has been re-invited", async () => {
    const f = await issueAlreadyElapsed("p2-i");
    // Cycle 1 terminates.
    expect(
      (
        await adminQuery(`select public.expire_new_client_waitlist_invitation($1,$2,$3) as r`, [
          f.studioId,
          f.entryId,
          f.userId,
        ])
      ).rows[0].r,
    ).toBe("expired");

    // Requeue -> claim -> invite again: a SECOND invitation row for one entry.
    expect(
      (
        await adminQuery(`select public.requeue_new_client_waitlist_entry($1,$2,$3) as r`, [
          f.studioId,
          f.entryId,
          f.userId,
        ])
      ).rows[0].r,
    ).toBe("requeued");
    await adminQuery(`select public.claim_new_client_waitlist_entry($1,$2,$3)`, [
      f.studioId,
      f.entryId,
      f.userId,
    ]);
    const second = await adminQuery(
      `select result from public.issue_new_client_waitlist_invitation($1,$2,$3,72)`,
      [f.studioId, f.entryId, f.userId],
    );
    expect(second.rows[0].result).toBe("invited");

    const rows = await adminQuery(
      `select id, expired_at from public.new_client_waitlist_invitations
        where entry_id = $1 order by issued_at desc, id desc`,
      [f.entryId],
    );
    expect(rows.rows).toHaveLength(2);
    const current = rows.rows[0].id as string;
    expect(current).not.toBe(f.invId);

    // The current cycle is LIVE, so expiry must say so rather than reporting the
    // historical row's terminal state.
    const r = await adminQuery(
      `select public.expire_new_client_waitlist_invitation($1,$2,$3) as r`,
      [f.studioId, f.entryId, f.userId],
    );
    expect(r.rows[0].r).toBe("not_expired");
    expect((await stateOf(current)).expired_at).toBeNull();
    // ...and the historical row is untouched by this call.
    expect((await stateOf(f.invId)).expired_at).not.toBeNull();
  });
});

// ===========================================================================
// 0189 P2 — THE CURRENT CYCLE IS IDENTIFIED STRUCTURALLY, NOT BY CHRONOLOGY.
//
// An earlier draft ordered by `issued_at desc, id desc`. 0188 stamps
// `issued_at := now()` in its insert trigger, and now() is
// transaction_timestamp(), so issuance ORDER and issued_at ORDER are not the
// same relation. Reproduced: a transaction that began at 12:28:37.684Z issued
// the CURRENT cycle while an entire earlier cycle was issued and released from
// autocommit calls at .689Z. The ordering picked the RELEASED historical row,
// expire() answered `not_invited`, and the genuine live cycle was left live and
// unstamped. Two cycles completed inside one transaction share an issued_at
// exactly, so the tiebreak fell to a random v4 UUID.
//
// The schema already carries the answer as an INVARIANT:
// new_client_waitlist_invitations_one_live_per_entry is UNIQUE on (entry_id)
// WHERE redeemed_at, expired_at and released_at are all null.
// ===========================================================================

const liveIdOf = async (entryId: string) =>
  (
    await adminQuery(
      `select id from public.new_client_waitlist_invitations
        where entry_id = $1 and redeemed_at is null and expired_at is null and released_at is null`,
      [entryId],
    )
  ).rows[0]?.id as string | undefined;

/** The row `issued_at desc, id desc` would have chosen. */
const chronologyPickOf = async (entryId: string) =>
  (
    await adminQuery(
      `select id from public.new_client_waitlist_invitations
        where entry_id = $1 order by issued_at desc, id desc limit 1`,
      [entryId],
    )
  ).rows[0].id as string;

const cyclesOf = async (entryId: string) =>
  (
    await adminQuery(
      `select id, expired_at, released_at, redeemed_at from public.new_client_waitlist_invitations
        where entry_id = $1`,
      [entryId],
    )
  ).rows as Array<{ id: string; expired_at: Date | null; released_at: Date | null; redeemed_at: Date | null }>;

/**
 * Build TWO cycles on one entry whose issued_at order is INVERTED against real
 * issuance order, using genuine transaction semantics.
 *
 * A long-running transaction is opened first; an entire cycle is then issued
 * and terminated by ordinary autocommit calls; and only then does the old
 * transaction issue the current cycle — which the insert trigger stamps with
 * that transaction's START instant, i.e. BEFORE the historical row.
 */
async function seedInvertedCycles(label: string, terminate: "release" | "expire") {
  const f = await issueExpiringIn(label, 120);
  // Cycle 1 (the one seeded above) is terminated, then the entry is requeued.
  if (terminate === "release") {
    expect(
      (
        await adminQuery(`select public.release_new_client_waitlist_entry($1,$2,$3) as r`, [
          f.studioId,
          f.entryId,
          f.userId,
        ])
      ).rows[0].r,
    ).toBe("released");
  } else {
    await withAppendOnlyDisabled(() =>
      adminQuery(
        `update public.new_client_waitlist_invitations
            set issued_at = clock_timestamp() - interval '4 days',
                expires_at = clock_timestamp() - interval '1 minute'
          where id = $1`,
        [f.invId],
      ),
    );
    expect(
      (
        await adminQuery(`select public.expire_new_client_waitlist_invitation($1,$2,$3) as r`, [
          f.studioId,
          f.entryId,
          f.userId,
        ])
      ).rows[0].r,
    ).toBe("expired");
  }
  await adminQuery(`select public.requeue_new_client_waitlist_entry($1,$2,$3)`, [
    f.studioId,
    f.entryId,
    f.userId,
  ]);
  await adminQuery(`select public.claim_new_client_waitlist_entry($1,$2,$3)`, [
    f.studioId,
    f.entryId,
    f.userId,
  ]);

  // A transaction opened NOW; its issued_at will be this instant.
  const old = await conn();
  await old.query("begin");
  await old.query(`select transaction_timestamp()`);

  // ...while ANOTHER whole cycle is issued and terminated after it began.
  const mid = await adminQuery(
    `select result from public.issue_new_client_waitlist_invitation($1,$2,$3,72)`,
    [f.studioId, f.entryId, f.userId],
  );
  expect(mid.rows[0].result).toBe("invited");
  const midId = (await liveIdOf(f.entryId))!;
  expect(
    (
      await adminQuery(`select public.release_new_client_waitlist_entry($1,$2,$3) as r`, [
        f.studioId,
        f.entryId,
        f.userId,
      ])
    ).rows[0].r,
  ).toBe("released");
  await adminQuery(`select public.requeue_new_client_waitlist_entry($1,$2,$3)`, [
    f.studioId,
    f.entryId,
    f.userId,
  ]);
  await adminQuery(`select public.claim_new_client_waitlist_entry($1,$2,$3)`, [
    f.studioId,
    f.entryId,
    f.userId,
  ]);

  // The OLD transaction issues the genuine current cycle — stamped earlier.
  const cur = await old.query(
    `select result from public.issue_new_client_waitlist_invitation($1,$2,$3,72)`,
    [f.studioId, f.entryId, f.userId],
  );
  expect(cur.rows[0].result).toBe("invited");
  await old.query("commit");
  await old.end();

  const liveId = (await liveIdOf(f.entryId))!;
  expect(liveId).not.toBe(midId);
  return { ...f, liveId, midId };
}

describe("A — TIMESTAMP INVERSION: the live row wins, whatever issued_at says", () => {
  it("expires the genuine current cycle even though a historical row sorts newer", async () => {
    const f = await seedInvertedCycles("cyc-a", "release");

    // THE INVERSION IS REAL, asserted rather than assumed: the chronology the
    // old code trusted points at a row that is NOT live.
    const picked = await chronologyPickOf(f.entryId);
    expect(
      picked,
      "no inversion was constructed — this test would pass vacuously",
    ).not.toBe(f.liveId);

    await withAppendOnlyDisabled(() =>
      adminQuery(
        `update public.new_client_waitlist_invitations
            set issued_at = clock_timestamp() - interval '4 days',
                expires_at = clock_timestamp() - interval '1 minute'
          where id = $1`,
        [f.liveId],
      ),
    );

    const r = await adminQuery(
      `select public.expire_new_client_waitlist_invitation($1,$2,$3) as r`,
      [f.studioId, f.entryId, f.userId],
    );
    expect(r.rows[0].r).toBe("expired");
    expect(await entryStatus(f.entryId)).toBe("expired");

    const cycles = await cyclesOf(f.entryId);
    const live = cycles.find((c) => c.id === f.liveId)!;
    expect(live.expired_at, "the true current cycle was not stamped").not.toBeNull();
    // ...and no historical row was touched by this call.
    for (const c of cycles.filter((x) => x.id !== f.liveId)) {
      expect(c.expired_at, `historical row ${c.id} was expired by this call`).toBeNull();
    }
  });
});

describe("B — SAME issued_at: identity never falls to UUID order", () => {
  it("two cycles sharing an issued_at still resolve to the live one", async () => {
    // Both cycles are completed inside ONE transaction, so the insert trigger
    // stamps them with an identical transaction_timestamp and `id desc` is a
    // coin flip.
    const f = await issueExpiringIn("cyc-b", 120);
    // BOTH of the tied cycles must be issued inside ONE transaction, so the
    // insert trigger stamps them with the same transaction_timestamp.
    const one = await conn();
    await one.query("begin");
    for (let cycle = 0; cycle < 2; cycle += 1) {
      await one.query(`select public.release_new_client_waitlist_entry($1,$2,$3)`, [
        f.studioId,
        f.entryId,
        f.userId,
      ]);
      await one.query(`select public.requeue_new_client_waitlist_entry($1,$2,$3)`, [
        f.studioId,
        f.entryId,
        f.userId,
      ]);
      await one.query(`select public.claim_new_client_waitlist_entry($1,$2,$3)`, [
        f.studioId,
        f.entryId,
        f.userId,
      ]);
      await one.query(`select public.issue_new_client_waitlist_invitation($1,$2,$3,72)`, [
        f.studioId,
        f.entryId,
        f.userId,
      ]);
    }
    await one.query("commit");
    await one.end();

    const liveId0 = (await liveIdOf(f.entryId))!;
    const tied = await adminQuery(
      `select count(*)::int as n from public.new_client_waitlist_invitations
        where entry_id = $1
          and issued_at = (select issued_at from public.new_client_waitlist_invitations where id = $2)`,
      [f.entryId, liveId0],
    );
    expect(
      tied.rows[0].n,
      "no issued_at tie was constructed — this test would pass vacuously",
    ).toBeGreaterThanOrEqual(2);
    const liveId = liveId0;
    await withAppendOnlyDisabled(() =>
      adminQuery(
        `update public.new_client_waitlist_invitations
            set issued_at = issued_at - interval '4 days',
                expires_at = clock_timestamp() - interval '1 minute'
          where id = $1`,
        [liveId],
      ),
    );

    const r = await adminQuery(
      `select public.expire_new_client_waitlist_invitation($1,$2,$3) as r`,
      [f.studioId, f.entryId, f.userId],
    );
    expect(r.rows[0].r).toBe("expired");
    const cycles = await cyclesOf(f.entryId);
    expect(cycles.find((c) => c.id === liveId)!.expired_at).not.toBeNull();
    for (const c of cycles.filter((x) => x.id !== liveId)) {
      expect(c.expired_at, `historical row ${c.id} was expired by this call`).toBeNull();
    }
  });
});

describe("C/D — a historical terminal row never shadows the current live one", () => {
  for (const mode of ["expire", "release"] as const) {
    it(`historical ${mode}d cycle + current live cycle: only the live one moves`, async () => {
      const f = await seedInvertedCycles(`cyc-${mode}`, mode);
      const liveId = f.liveId;
      await withAppendOnlyDisabled(() =>
        adminQuery(
          `update public.new_client_waitlist_invitations
              set issued_at = clock_timestamp() - interval '4 days',
                  expires_at = clock_timestamp() - interval '1 minute'
            where id = $1`,
          [liveId],
        ),
      );
      const before = await cyclesOf(f.entryId);
      const r = await adminQuery(
        `select public.expire_new_client_waitlist_invitation($1,$2,$3) as r`,
        [f.studioId, f.entryId, f.userId],
      );
      expect(r.rows[0].r).toBe("expired");
      const after = await cyclesOf(f.entryId);
      for (const b of before.filter((x) => x.id !== liveId)) {
        const a = after.find((x) => x.id === b.id)!;
        expect(a.expired_at?.getTime() ?? null).toBe(b.expired_at?.getTime() ?? null);
        expect(a.released_at?.getTime() ?? null).toBe(b.released_at?.getTime() ?? null);
      }
      expect(after.find((x) => x.id === liveId)!.expired_at).not.toBeNull();
    });
  }
});

describe("I — the invariants the identity law rests on", () => {
  it("at most ONE live invitation per entry is structurally enforced", async () => {
    const f = await issueExpiringIn("cyc-uniq", 120);
    // A second live row for the same entry is refused by the partial unique
    // index, which is precisely what makes 'the live row' a definition.
    await expect(
      adminQuery(
        `insert into public.new_client_waitlist_invitations
           (studio_id, entry_id, token_hash, expires_at, issued_by_practitioner_id)
         select studio_id, entry_id, repeat('a',64), expires_at, issued_by_practitioner_id
           from public.new_client_waitlist_invitations where id = $1`,
        [f.invId],
      ),
    ).rejects.toThrow(/one_live_per_entry/);
  });

  it("a redeemed entry can never acquire a later cycle", async () => {
    // This is what makes "any redeemed invitation" and "this entry's CURRENT
    // cycle was redeemed" the same statement, so the no-live-row branch needs
    // no chronology.
    const f = await issueExpiringIn("cyc-term", 120);
    expect(
      (
        await adminQuery(`select result from public.redeem_new_client_waitlist_invitation($1)`, [
          f.token,
        ])
      ).rows[0].result,
    ).toBe("redeemed");
    expect(await entryStatus(f.entryId)).toBe("invited");
    expect(await liveIdOf(f.entryId)).toBeUndefined();

    for (const [cmd, expected] of [
      ["select public.release_new_client_waitlist_entry($1,$2,$3) as r", "already_redeemed"],
      ["select public.expire_new_client_waitlist_invitation($1,$2,$3) as r", "already_redeemed"],
      ["select public.requeue_new_client_waitlist_entry($1,$2,$3) as r", "not_requeueable"],
    ] as const) {
      const r = await adminQuery(cmd, [f.studioId, f.entryId, f.userId]);
      expect(r.rows[0].r, cmd).toBe(expected);
    }
    expect(
      (
        await adminQuery(
          `select result from public.issue_new_client_waitlist_invitation($1,$2,$3,72)`,
          [f.studioId, f.entryId, f.userId],
        )
      ).rows[0].result,
    ).toBe("not_claimed");
    expect((await cyclesOf(f.entryId)).length, "a later cycle was created").toBe(1);
  });
});

// ===========================================================================
// 0189 — RELEASE STAMPS FROM A POST-LOCK WALL CLOCK.
//
// 0188 stamped both release timestamps with now(). Measured against the frozen
// function: a transaction that began BEFORE the invitation was issued recorded
// released_at 14:17:41.822Z against an issued_at of 14:17:41.828Z — a release
// six milliseconds BEFORE the thing it released, inverting the append-only
// lifecycle chronology. And a release that waited on the invitation row was
// backdated by the whole wait: stamped 2,674 ms before the instant that
// serialized it.
//
// Release also has a CLAIM-ONLY path — 0188 permits release from 'claimed',
// 'invited' and 'expired', and a claimed entry may have no invitation at all —
// so the invitation lock is conditional while the clock read is not.
// ===========================================================================

/** A studio + owner + entry in `claimed`, with NO invitation issued. */
async function seedClaimedNoInvitation(label: string) {
  const s = await seedStudioOwner(label);
  const j = await adminQuery(
    `select entry_id from public.join_new_client_waitlist($1,$2,$3,null)`,
    [s.studioId, `P ${s.uniq}`, `p-${s.uniq}@harness.local`],
  );
  const entryId = j.rows[0].entry_id as string;
  await adminQuery(`select public.claim_new_client_waitlist_entry($1,$2,$3)`, [
    s.studioId,
    entryId,
    s.userId,
  ]);
  return { ...s, entryId };
}

const entryRow = async (entryId: string) =>
  (
    await adminQuery(
      `select status, released_at, expired_at from public.new_client_waitlist_entries where id=$1`,
      [entryId],
    )
  ).rows[0] as { status: string; released_at: Date | null; expired_at: Date | null };

const release = (studioId: string, entryId: string, userId: string) =>
  adminQuery(`select public.release_new_client_waitlist_entry($1,$2,$3) as r`, [
    studioId,
    entryId,
    userId,
  ]).then((x) => x.rows[0].r as string);

describe("RELEASE A — claimed with NO invitation still releases", () => {
  it("stamps the entry from a post-entry-lock clock and needs no invitation", async () => {
    const f = await seedClaimedNoInvitation("rel-claim");
    expect(
      (await adminQuery(`select count(*)::int n from public.new_client_waitlist_invitations where entry_id=$1`, [f.entryId])).rows[0].n,
      "the claim-only fixture must have no invitation",
    ).toBe(0);

    const before = (await adminQuery(`select clock_timestamp() as t`)).rows[0].t as Date;
    expect(await release(f.studioId, f.entryId, f.userId)).toBe("released");
    const after = (await adminQuery(`select clock_timestamp() as t`)).rows[0].t as Date;

    const e = await entryRow(f.entryId);
    expect(e.status).toBe("released");
    expect(e.released_at).not.toBeNull();
    expect(e.released_at!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 5);
    expect(e.released_at!.getTime()).toBeLessThanOrEqual(after.getTime() + 5);
  });
});

describe("RELEASE B — invitation and entry share ONE instant", () => {
  it("stamps both rows from the same decision value", async () => {
    const f = await issueExpiringIn("rel-both", 120);
    expect(await release(f.studioId, f.entryId, f.userId)).toBe("released");
    const inv = await stateOf(f.invId);
    const e = await entryRow(f.entryId);
    expect(inv.released_at).not.toBeNull();
    expect(e.released_at).not.toBeNull();
    expect(
      e.released_at!.getTime(),
      "the invitation and the entry were stamped at different instants",
    ).toBe(inv.released_at!.getTime());
  });
});

describe("RELEASE C — a release can never predate the invitation it releases", () => {
  it("does not stamp released_at before issued_at when the transaction began earlier", async () => {
    const f = await seedClaimedNoInvitation("rel-inv");

    const b = await conn();
    await b.query("begin");
    const t0 = (await b.query(`select transaction_timestamp() as t`)).rows[0].t as Date;

    // The invitation is issued AFTER that transaction began.
    expect(
      (
        await adminQuery(
          `select result from public.issue_new_client_waitlist_invitation($1,$2,$3,72)`,
          [f.studioId, f.entryId, f.userId],
        )
      ).rows[0].result,
    ).toBe("invited");
    const inv = (
      await adminQuery(
        `select id, issued_at from public.new_client_waitlist_invitations where entry_id=$1`,
        [f.entryId],
      )
    ).rows[0] as { id: string; issued_at: Date };
    expect(
      inv.issued_at.getTime(),
      "PRECONDITION: the invitation must be issued after the releasing transaction began",
    ).toBeGreaterThan(t0.getTime());

    const r = (
      await b.query(`select public.release_new_client_waitlist_entry($1,$2,$3) as r`, [
        f.studioId,
        f.entryId,
        f.userId,
      ])
    ).rows[0].r as string;
    await b.query("commit");
    await b.end();

    expect(r).toBe("released");
    const st = await stateOf(inv.id);
    expect(st.released_at).not.toBeNull();
    expect(
      st.released_at!.getTime(),
      "released_at PREDATES issued_at — the lifecycle chronology is inverted",
    ).toBeGreaterThanOrEqual(inv.issued_at.getTime());
    // ...and the entry agrees with the invitation.
    expect((await entryRow(f.entryId)).released_at!.getTime()).toBe(st.released_at!.getTime());
  });
});

describe("RELEASE D — a wait on the invitation lock does not backdate the stamp", () => {
  it("stamps at or after the moment the holder released", async () => {
    const f = await issueExpiringIn("rel-wait", 300);
    const holder = await holdInvitation(f.invId);

    const b = await conn();
    await b.query("begin");
    const pid = (await b.query(`select pg_backend_pid() as pid`)).rows[0].pid as number;
    const pending = b.query(`select public.release_new_client_waitlist_entry($1,$2,$3) as r`, [
      f.studioId,
      f.entryId,
      f.userId,
    ]);
    expect(await waitUntilBlocked(pid), "release never blocked on the invitation").not.toBeNull();

    // Past the ENTRY mutex and waiting on the INVITATION.
    const third = await conn();
    await third.query("begin");
    const tpid = (await third.query(`select pg_backend_pid() as pid`)).rows[0].pid as number;
    const thirdPending = third.query(
      `select 1 from public.new_client_waitlist_entries where id = $1 for update`,
      [f.entryId],
    );
    expect(
      await waitUntilBlocked(tpid, 5000),
      "release is not holding the entry mutex",
    ).not.toBeNull();

    await sleep(HOLD_MS);
    const boundary = (await adminQuery(`select clock_timestamp() as t`)).rows[0].t as Date;
    await holder.query("rollback");
    await holder.end();

    const r = (await pending).rows[0].r as string;
    await b.query("commit");
    await b.end();
    await thirdPending.catch(() => undefined);
    await third.query("rollback");
    await third.end();

    expect(r).toBe("released");
    const st = await stateOf(f.invId);
    const drift = boundary.getTime() - st.released_at!.getTime();
    expect(drift, `released_at is ${drift}ms BEFORE the serializing lock release`).toBeLessThan(250);
    expect((await entryRow(f.entryId)).released_at!.getTime()).toBe(st.released_at!.getTime());
  });
});

describe("RELEASE E — a redemption that commits during the wait is seen", () => {
  it("answers already_redeemed and releases nothing", async () => {
    const f = await issueExpiringIn("rel-redeem", 300);

    const a = await conn();
    await a.query("begin");
    expect(
      (await a.query(`select result from public.redeem_new_client_waitlist_invitation($1)`, [f.token])).rows[0].result,
    ).toBe("redeemed");

    const b = await conn();
    await b.query("begin");
    const pid = (await b.query(`select pg_backend_pid() as pid`)).rows[0].pid as number;
    const pending = b.query(`select public.release_new_client_waitlist_entry($1,$2,$3) as r`, [
      f.studioId,
      f.entryId,
      f.userId,
    ]);
    expect(await waitUntilBlocked(pid), "release did not wait for the redemption").not.toBeNull();

    await a.query("commit");
    await a.end();
    const r = (await pending).rows[0].r as string;
    await b.query("commit");
    await b.end();

    expect(r).toBe("already_redeemed");
    const st = await stateOf(f.invId);
    expect(st.redeemed_at).not.toBeNull();
    expect(st.released_at, "a redeemed invitation must never be released").toBeNull();
    expect((await entryRow(f.entryId)).status).toBe("invited");
  });
});

describe("RELEASE — terminal evidence is never rewritten", () => {
  it("releasing an EXPIRED entry keeps the invitation's expired_at and moves only the entry", async () => {
    // 0188 permits release from `expired`; the one-outcome CHECK forbids a
    // second terminal column on the invitation, so only the ENTRY transitions.
    const f = await issueAlreadyElapsed("rel-exp");
    expect(
      (
        await adminQuery(`select public.expire_new_client_waitlist_invitation($1,$2,$3) as r`, [
          f.studioId,
          f.entryId,
          f.userId,
        ])
      ).rows[0].r,
    ).toBe("expired");
    const expiredAt = (await stateOf(f.invId)).expired_at!;
    expect(expiredAt).not.toBeNull();

    expect(await release(f.studioId, f.entryId, f.userId)).toBe("released");

    const st = await stateOf(f.invId);
    expect(st.expired_at!.getTime(), "the expired evidence was rewritten").toBe(expiredAt.getTime());
    expect(st.released_at, "a second terminal outcome was written").toBeNull();
    const e = await entryRow(f.entryId);
    expect(e.status).toBe("released");
    expect(e.released_at).not.toBeNull();
  });

  it("release targets the STRUCTURAL current cycle, never a historical one", async () => {
    const f = await seedInvertedCycles("rel-cyc", "release");
    const picked = await chronologyPickOf(f.entryId);
    expect(picked, "no inversion was constructed").not.toBe(f.liveId);

    expect(await release(f.studioId, f.entryId, f.userId)).toBe("released");

    const cycles = await cyclesOf(f.entryId);
    expect(cycles.find((c) => c.id === f.liveId)!.released_at).not.toBeNull();
    // The historical rows keep exactly the terminal evidence they had.
    const stamps = await adminQuery(
      `select id, released_at from public.new_client_waitlist_invitations where entry_id=$1 and id <> $2`,
      [f.entryId, f.liveId],
    );
    for (const row of stamps.rows as Array<{ id: string; released_at: Date | null }>) {
      expect(
        row.released_at!.getTime(),
        `historical row ${row.id} was re-stamped by this release`,
      ).toBeLessThan(cycles.find((c) => c.id === f.liveId)!.released_at!.getTime());
    }
  });
});

describe("RELEASE — concurrency stays coherent", () => {
  it("release || redeem yields exactly one terminal outcome", async () => {
    const f = await issueExpiringIn("rel-vs-redeem", 300);
    const [rel, red] = await Promise.all([
      release(f.studioId, f.entryId, f.userId),
      adminQuery(`select result from public.redeem_new_client_waitlist_invitation($1)`, [
        f.token,
      ]).then((x) => x.rows[0].result as string),
    ]);
    const st = await stateOf(f.invId);
    const terminal = [st.redeemed_at, st.expired_at, st.released_at].filter((x) => x !== null);
    expect(terminal, `release=${rel} redeem=${red} left ${terminal.length} terminal columns`)
      .toHaveLength(1);
  });

  it("issue || release: the entry mutex still serializes", async () => {
    const f = await seedClaimedNoInvitation("rel-vs-issue");
    const [iss, rel] = await Promise.all([
      adminQuery(`select result from public.issue_new_client_waitlist_invitation($1,$2,$3,72)`, [
        f.studioId,
        f.entryId,
        f.userId,
      ]).then((x) => x.rows[0].result as string),
      release(f.studioId, f.entryId, f.userId),
    ]);
    const e = await entryRow(f.entryId);
    if (iss === "invited") {
      // Whatever the order, a live token may never survive a released entry.
      const live = await liveIdOf(f.entryId);
      if (e.status === "released") {
        expect(live, "a live token survived a released entry").toBeUndefined();
      }
    }
    expect([`released`, `invited`]).toContain(e.status);
    expect(["released", "not_releasable"]).toContain(rel);
  });
});

// ===========================================================================
// TEMPORAL AUTHORITY — the whole lifecycle, not one command at a time.
//
// Four reviews in a row found the same defect in a different WAIT-03 command:
// PostgreSQL's now() is transaction_timestamp(), so any command that stamps
// with it records an instant that may precede the transition it describes. The
// tests below stop asking "is THIS command fixed" and ask the class question:
// can ANY legal lifecycle path be made to run backwards?
//
// Measured before the repair, with the commands already fixed but the event
// trigger still on `default now()`, the append-only log read:
//     waiting 15:03:34.430 / claimed .444 / released .491 / invited .499
// — released BEFORE invited. And an adversarial census then found the same
// inversion in claim, issue's invited_at, and removal.
// ===========================================================================

type EventRow = { from_status: string | null; to_status: string; occurred_at: Date };

/**
 * Events for an entry in TRANSITION order, reconstructed from the state chain.
 *
 * There is no sequence column and `id` is a v4 UUID, so physical order is not
 * insertion order — an earlier draft used ctid and produced false inversions
 * once rows moved. Ordering by occurred_at would be circular, since occurred_at
 * is the thing under test. The chain is the only independent evidence: the
 * INSERT event has from_status NULL, and every later event's from_status is the
 * previous event's to_status.
 */
async function eventsInInsertionOrder(entryId: string): Promise<EventRow[]> {
  const rows = (
    await adminQuery(
      `select from_status, to_status, occurred_at from public.new_client_waitlist_entry_events
        where entry_id = $1`,
      [entryId],
    )
  ).rows as EventRow[];
  const remaining = [...rows];
  const head = remaining.findIndex((r) => r.from_status === null);
  expect(head, "no INSERT event for this entry").toBeGreaterThan(-1);
  const chain: EventRow[] = remaining.splice(head, 1);
  while (remaining.length) {
    const prev = chain[chain.length - 1].to_status;
    const nextAt = remaining.findIndex((r) => r.from_status === prev);
    if (nextAt < 0) break; // not a single linear chain; stop rather than guess
    chain.push(...remaining.splice(nextAt, 1));
  }
  expect(chain.length, "the event chain is not linear for this fixture").toBe(rows.length);
  return chain;
}

/** The first place the append-only log goes backwards, or null. */
function firstInversion(rows: EventRow[]): string | null {
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i].occurred_at.getTime() < rows[i - 1].occurred_at.getTime()) {
      return `${rows[i - 1].to_status}(${rows[i - 1].occurred_at.toISOString()}) -> ${rows[i].to_status}(${rows[i].occurred_at.toISOString()})`;
    }
  }
  return null;
}

/** A studio + owner, with no entry yet. */
async function bareStudio(label: string) {
  return seedStudioOwner(label);
}
async function joinEntry(s: { studioId: string; uniq: string }) {
  const r = await adminQuery(
    `select entry_id from public.join_new_client_waitlist($1,$2,$3,null)`,
    [s.studioId, `P ${s.uniq}`, `p-${randomUUID().slice(0, 8)}@harness.local`],
  );
  return r.rows[0].entry_id as string;
}
/** An independent transaction opened NOW, whose transaction_timestamp is old. */
async function oldTransaction() {
  const c = await conn();
  await c.query("begin");
  await c.query(`select transaction_timestamp()`);
  return c;
}

describe("the append-only log never runs backwards on any legal path", () => {
  // Each case opens a transaction BEFORE the preceding transition commits, then
  // performs its own transition from that older transaction. Under
  // transaction-start stamping every one of these inverts.

  it("JOIN -> CLAIM", async () => {
    const s = await bareStudio("tmp-a");
    const old = await oldTransaction();
    const e = await joinEntry(s); // joined AFTER the claiming transaction began
    await old.query(`select public.claim_new_client_waitlist_entry($1,$2,$3)`, [s.studioId, e, s.userId]);
    await old.query("commit");
    await old.end();
    expect(firstInversion(await eventsInInsertionOrder(e))).toBeNull();
  });

  it("CLAIM -> INVITE", async () => {
    const s = await bareStudio("tmp-b");
    const e = await joinEntry(s);
    const old = await oldTransaction();
    await adminQuery(`select public.claim_new_client_waitlist_entry($1,$2,$3)`, [s.studioId, e, s.userId]);
    await old.query(`select public.issue_new_client_waitlist_invitation($1,$2,$3,72)`, [s.studioId, e, s.userId]);
    await old.query("commit");
    await old.end();
    const rows = await eventsInInsertionOrder(e);
    expect(firstInversion(rows)).toBeNull();
    // ...and the entry's own evidence agrees with the event.
    const ent = await adminQuery(`select invited_at from public.new_client_waitlist_entries where id=$1`, [e]);
    expect((rows.find((r) => r.to_status === "invited")!).occurred_at.getTime()).toBe(
      (ent.rows[0].invited_at as Date).getTime(),
    );
  });

  it("INVITE -> RELEASE", async () => {
    const s = await bareStudio("tmp-c");
    const e = await joinEntry(s);
    await adminQuery(`select public.claim_new_client_waitlist_entry($1,$2,$3)`, [s.studioId, e, s.userId]);
    const old = await oldTransaction();
    await adminQuery(`select public.issue_new_client_waitlist_invitation($1,$2,$3,72)`, [s.studioId, e, s.userId]);
    await old.query(`select public.release_new_client_waitlist_entry($1,$2,$3)`, [s.studioId, e, s.userId]);
    await old.query("commit");
    await old.end();
    expect(firstInversion(await eventsInInsertionOrder(e))).toBeNull();
  });

  it("REDEEM -> CONVERT", async () => {
    const s = await bareStudio("tmp-d");
    const e = await joinEntry(s);
    await adminQuery(`select public.claim_new_client_waitlist_entry($1,$2,$3)`, [s.studioId, e, s.userId]);
    const iss = await adminQuery(
      `select raw_token from public.issue_new_client_waitlist_invitation($1,$2,$3,72)`,
      [s.studioId, e, s.userId],
    );
    const old = await oldTransaction();
    await adminQuery(`select public.redeem_new_client_waitlist_invitation($1)`, [iss.rows[0].raw_token]);
    const clientId = randomUUID();
    await adminQuery(`insert into public.clients (id, studio_id, name, email) values ($1,$2,$3,$4)`, [
      clientId, s.studioId, `C ${s.uniq}`, `c-${s.uniq}@harness.local`,
    ]);
    await old.query(`select public.record_new_client_waitlist_conversion($1,$2,$3)`, [s.studioId, e, clientId]);
    await old.query("commit");
    await old.end();
    expect(firstInversion(await eventsInInsertionOrder(e))).toBeNull();
  });

  it("RELEASE -> REQUEUE (waiting carries no evidence of its own)", async () => {
    const s = await bareStudio("tmp-e");
    const e = await joinEntry(s);
    await adminQuery(`select public.claim_new_client_waitlist_entry($1,$2,$3)`, [s.studioId, e, s.userId]);
    await adminQuery(`select public.issue_new_client_waitlist_invitation($1,$2,$3,72)`, [s.studioId, e, s.userId]);
    const old = await oldTransaction();
    await adminQuery(`select public.release_new_client_waitlist_entry($1,$2,$3)`, [s.studioId, e, s.userId]);
    await old.query(`select public.requeue_new_client_waitlist_entry($1,$2,$3)`, [s.studioId, e, s.userId]);
    await old.query("commit");
    await old.end();
    const rows = await eventsInInsertionOrder(e);
    expect(firstInversion(rows)).toBeNull();
    // requeue CLEARS the cycle columns, so its event takes the trigger's own
    // post-transition clock rather than a stale joined_at.
    const requeued = rows[rows.length - 1];
    expect(requeued.to_status).toBe("waiting");
    const joined = await adminQuery(`select joined_at from public.new_client_waitlist_entries where id=$1`, [e]);
    expect(
      requeued.occurred_at.getTime(),
      "the requeue event was backdated to the original join",
    ).toBeGreaterThan((joined.rows[0].joined_at as Date).getTime());
  });

  for (const [name, viaInvite] of [["WAITING -> REMOVE", false], ["RELEASED -> REMOVE", true]] as const) {
    it(name, async () => {
      const s = await bareStudio(`tmp-${viaInvite ? "g" : "f"}`);
      let e: string;
      let old: Awaited<ReturnType<typeof conn>>;
      if (viaInvite) {
        e = await joinEntry(s);
        await adminQuery(`select public.claim_new_client_waitlist_entry($1,$2,$3)`, [s.studioId, e, s.userId]);
        await adminQuery(`select public.issue_new_client_waitlist_invitation($1,$2,$3,72)`, [s.studioId, e, s.userId]);
        old = await oldTransaction();
        await adminQuery(`select public.release_new_client_waitlist_entry($1,$2,$3)`, [s.studioId, e, s.userId]);
      } else {
        old = await oldTransaction();
        e = await joinEntry(s);
      }
      await old.query(`select public.remove_new_client_waitlist_entry($1,$2,$3)`, [s.studioId, e, s.userId]);
      await old.query("commit");
      await old.end();
      expect(firstInversion(await eventsInInsertionOrder(e))).toBeNull();
    });
  }
});

describe("the event IS the transition, not a second reading of it", () => {
  it("released: event.occurred_at EQUALS entry.released_at", async () => {
    const f = await issueExpiringIn("ev-rel", 300);
    await release(f.studioId, f.entryId, f.userId);
    const e = await entryRow(f.entryId);
    const rows = await eventsInInsertionOrder(f.entryId);
    expect(rows.find((r) => r.to_status === "released")!.occurred_at.getTime()).toBe(
      e.released_at!.getTime(),
    );
  });

  it("expired: event.occurred_at EQUALS entry.expired_at", async () => {
    const f = await issueAlreadyElapsed("ev-exp");
    await adminQuery(`select public.expire_new_client_waitlist_invitation($1,$2,$3)`, [
      f.studioId, f.entryId, f.userId,
    ]);
    const e = await entryRow(f.entryId);
    const rows = await eventsInInsertionOrder(f.entryId);
    expect(rows.find((r) => r.to_status === "expired")!.occurred_at.getTime()).toBe(
      e.expired_at!.getTime(),
    );
  });

  it("a release that waited on the lock stamps its EVENT after the wait too", async () => {
    const f = await issueExpiringIn("ev-wait", 300);
    const holder = await holdInvitation(f.invId);
    const b = await conn();
    await b.query("begin");
    const pid = (await b.query(`select pg_backend_pid() as pid`)).rows[0].pid as number;
    const pending = b.query(`select public.release_new_client_waitlist_entry($1,$2,$3) as r`, [
      f.studioId, f.entryId, f.userId,
    ]);
    expect(await waitUntilBlocked(pid)).not.toBeNull();
    await sleep(HOLD_MS);
    const boundary = (await adminQuery(`select clock_timestamp() as t`)).rows[0].t as Date;
    await holder.query("rollback");
    await holder.end();
    await pending;
    await b.query("commit");
    await b.end();

    const rows = await eventsInInsertionOrder(f.entryId);
    const released = rows.find((r) => r.to_status === "released")!;
    const drift = boundary.getTime() - released.occurred_at.getTime();
    expect(drift, `the release EVENT is ${drift}ms older than the serializing lock`).toBeLessThan(250);
    // ...and it still equals the entry stamp exactly.
    expect(released.occurred_at.getTime()).toBe((await entryRow(f.entryId)).released_at!.getTime());
  });

  it("NEGATIVE CONTROL: the column default is still transaction-start", async () => {
    // The repair is the trigger passing occurred_at explicitly. If someone drops
    // that argument the column default takes over again — and this proves the
    // default really is the old, backdating authority, so the control is not
    // vacuous.
    const d = await adminQuery(
      `select column_default from information_schema.columns
        where table_schema='public' and table_name='new_client_waitlist_entry_events'
          and column_name='occurred_at'`,
    );
    expect(d.rows[0].column_default).toBe("now()");

    const older = await conn();
    await older.query("begin");
    const t0 = (await older.query(`select transaction_timestamp() as t`)).rows[0].t as Date;
    await sleep(400);
    const nowInTx = (await older.query(`select now() as n, clock_timestamp() as c`)).rows[0] as {
      n: Date; c: Date;
    };
    await older.query("rollback");
    await older.end();
    expect(nowInTx.n.getTime()).toBe(t0.getTime());
    expect(
      nowInTx.c.getTime() - nowInTx.n.getTime(),
      "now() and clock_timestamp() no longer diverge — the control proves nothing",
    ).toBeGreaterThan(300);
  });
});

// ===========================================================================
// BULK CLAIM — the clock must be read INSIDE the candidate-dependent statement.
//
// The last shape of this defect was not lock contention at all. A standalone
// `v_decision_at := clock_timestamp();` is its own PL/pgSQL statement, and under
// READ COMMITTED the SQL statement that follows takes a FRESH snapshot. A
// requeue committing in that gap makes a row `waiting` AFTER the clock was read;
// the candidate scan then sees it, claims it, and stamps it with the earlier
// instant. FOR UPDATE SKIP LOCKED does not help: it governs contention, and the
// gap is not contention.
//
// Measured on the old shape with the schedule forced: claimed_at 113 ms BEFORE
// the `waiting` event of the very requeue that created the row it claimed.
// ===========================================================================

const BULK_BARRIER = 918923;

/** Studio + owner + N waiting entries. */
async function seedWaiting(label: string, n: number) {
  const s = await seedStudioOwner(label);
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const r = await adminQuery(
      `select entry_id from public.join_new_client_waitlist($1,$2,$3,null)`,
      [s.studioId, `P${i} ${s.uniq}`, `p${i}-${randomUUID().slice(0, 8)}@harness.local`],
    );
    ids.push(r.rows[0].entry_id as string);
  }
  const prac = await adminQuery(
    `select id from public.practitioners where studio_id=$1 and role='owner'`,
    [s.studioId],
  );
  return { ...s, entryIds: ids, practitionerId: prac.rows[0].id as string };
}

/** Take an entry through claim -> invite -> release so a requeue is legal. */
async function toReleased(s: { studioId: string; userId: string }, entryId: string) {
  await adminQuery(`select public.claim_new_client_waitlist_entry($1,$2,$3)`, [s.studioId, entryId, s.userId]);
  await adminQuery(`select public.issue_new_client_waitlist_invitation($1,$2,$3,72)`, [s.studioId, entryId, s.userId]);
  await adminQuery(`select public.release_new_client_waitlist_entry($1,$2,$3)`, [s.studioId, entryId, s.userId]);
}

const lastEventAt = async (entryId: string, status: string) =>
  (
    await adminQuery(
      `select occurred_at from public.new_client_waitlist_entry_events
        where entry_id=$1 and to_status=$2 order by occurred_at desc limit 1`,
      [entryId, status],
    )
  ).rows[0]?.occurred_at as Date | undefined;

/**
 * Run one bulk-claim SHAPE against a requeue that commits inside the window
 * between the clock read and the candidate snapshot.
 *
 * The schedule is forced with an advisory-lock barrier placed at exactly that
 * point. The barrier is the ONLY difference from production: shape B below is
 * the deployed statement verbatim.
 */
async function raceRequeueAgainst(fnName: string, s: Awaited<ReturnType<typeof seedWaiting>>, entryId: string) {
  const gate = await conn();
  await gate.query("begin");
  await gate.query(`select pg_advisory_xact_lock(${BULK_BARRIER})`);

  const claimer = await conn();
  await claimer.query("begin");
  const pid = (await claimer.query(`select pg_backend_pid() as pid`)).rows[0].pid as number;
  const pending = claimer.query(`select * from public.${fnName}($1,$2,$3)`, [
    s.studioId, s.practitionerId, 5,
  ]);
  expect(await waitUntilBlocked(pid), "the claimer never parked on the barrier").not.toBeNull();

  await sleep(100);
  // The requeue commits HERE — after the clock statement, before the snapshot.
  await adminQuery(`select public.requeue_new_client_waitlist_entry($1,$2,$3)`, [
    s.studioId, entryId, s.userId,
  ]);
  const waitingAt = (await lastEventAt(entryId, "waiting"))!;

  await gate.query("commit");
  await gate.end();
  const won = (await pending).rows as Array<{ entry_id: string }>;
  await claimer.query("commit");
  await claimer.end();

  const row = (
    await adminQuery(`select status, claimed_at from public.new_client_waitlist_entries where id=$1`, [entryId])
  ).rows[0] as { status: string; claimed_at: Date | null };
  return { claimedIt: won.some((w) => w.entry_id === entryId), waitingAt, row };
}

describe("bulk claim — the requeue race", () => {
  const OLD_FN = "zz_bulk_old_shape";

  it("A — NEGATIVE CONTROL: the old shape stamps before the requeue that created the row", async () => {
    // Reconstructs the exact pre-repair structure — clock as its own statement —
    // with the same barrier. If this ever stops inverting, the repaired
    // assertion below proves nothing.
    await adminQuery(`
      create or replace function public.${OLD_FN}(p_studio uuid, p_actor uuid, p_count int)
      returns table (result text, entry_id uuid)
      language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $fn$
      declare v_decision_at timestamptz;
      begin
        v_decision_at := clock_timestamp();
        perform pg_advisory_xact_lock(${BULK_BARRIER});
        return query
        with candidates as (
          select e.id from public.new_client_waitlist_entries e
           where e.studio_id = p_studio and e.status = 'waiting'
           order by e.joined_at, e.id limit p_count for update skip locked
        ), claimed as (
          update public.new_client_waitlist_entries t
             set status='claimed', claimed_at=v_decision_at, claimed_by_practitioner_id=p_actor
            from candidates c
           where t.id=c.id and t.studio_id=p_studio and t.status='waiting'
          returning t.id
        ) select 'claimed'::text, claimed.id from claimed;
      end; $fn$;`);
    try {
      const s = await seedWaiting("bulk-neg", 1);
      const e = s.entryIds[0];
      await toReleased(s, e);
      const r = await raceRequeueAgainst(OLD_FN, s, e);
      expect(r.claimedIt, "the control did not claim the requeued row").toBe(true);
      expect(
        r.row.claimed_at!.getTime(),
        "the old shape no longer inverts — this control is vacuous",
      ).toBeLessThan(r.waitingAt.getTime());
    } finally {
      await adminQuery(`drop function if exists public.${OLD_FN}(uuid,uuid,int)`);
    }
  });

  it("B — REPAIRED: the same schedule stamps after the requeue", async () => {
    const s = await seedWaiting("bulk-fix", 1);
    const e = s.entryIds[0];
    await toReleased(s, e);
    // The deployed function, with the barrier supplied externally: the claimer
    // is held on the entry rows themselves rather than an in-function barrier.
    const gate = await conn();
    await gate.query("begin");
    // Hold ALL waiting rows so the candidate scan cannot proceed, then release
    // after the requeue commits — the same ordering, without instrumenting the
    // production body.
    await gate.query(
      `select 1 from public.new_client_waitlist_entries where studio_id=$1 and status='waiting' for update`,
      [s.studioId],
    );
    await adminQuery(`select public.requeue_new_client_waitlist_entry($1,$2,$3)`, [s.studioId, e, s.userId]);
    const waitingAt = (await lastEventAt(e, "waiting"))!;
    await gate.query("commit");
    await gate.end();

    await adminQuery(`select * from public.claim_new_client_waitlist_entries($1,$2,$3)`, [
      s.studioId, s.userId, 5,
    ]);
    const row = (
      await adminQuery(`select status, claimed_at from public.new_client_waitlist_entries where id=$1`, [e])
    ).rows[0] as { status: string; claimed_at: Date };
    expect(row.status).toBe("claimed");
    expect(
      row.claimed_at.getTime(),
      "claimed_at precedes the requeue that made the row claimable",
    ).toBeGreaterThanOrEqual(waitingAt.getTime());
    expect(firstInversion(await eventsInInsertionOrder(e))).toBeNull();
  });

  it("D/I — every winner shares ONE instant, and each event equals its entry stamp", async () => {
    const s = await seedWaiting("bulk-many", 4);
    const won = await adminQuery(`select * from public.claim_new_client_waitlist_entries($1,$2,$3)`, [
      s.studioId, s.userId, 4,
    ]);
    expect(won.rows).toHaveLength(4);
    const rows = await adminQuery(
      `select id, claimed_at from public.new_client_waitlist_entries where studio_id=$1 order by id`,
      [s.studioId],
    );
    const stamps = new Set((rows.rows as Array<{ claimed_at: Date }>).map((r) => r.claimed_at.getTime()));
    expect(stamps.size, "one bulk claim produced more than one claim instant").toBe(1);
    for (const r of rows.rows as Array<{ id: string; claimed_at: Date }>) {
      const ev = await lastEventAt(r.id, "claimed");
      expect(ev!.getTime(), `event != entry stamp for ${r.id}`).toBe(r.claimed_at.getTime());
    }
  });

  it("E — exact-N: asking for fewer than are waiting claims exactly N", async () => {
    const s = await seedWaiting("bulk-n", 5);
    const won = await adminQuery(`select * from public.claim_new_client_waitlist_entries($1,$2,$3)`, [
      s.studioId, s.userId, 3,
    ]);
    expect(won.rows).toHaveLength(3);
    const left = await adminQuery(
      `select count(*)::int n from public.new_client_waitlist_entries where studio_id=$1 and status='waiting'`,
      [s.studioId],
    );
    expect(left.rows[0].n).toBe(2);
  });

  it("F — two concurrent bulk claimers partition without duplicates", async () => {
    const s = await seedWaiting("bulk-conc", 6);
    const [a, b] = await Promise.all([
      adminQuery(`select * from public.claim_new_client_waitlist_entries($1,$2,$3)`, [s.studioId, s.userId, 4]),
      adminQuery(`select * from public.claim_new_client_waitlist_entries($1,$2,$3)`, [s.studioId, s.userId, 4]),
    ]);
    const ids = [...a.rows, ...b.rows].map((r) => (r as { entry_id: string }).entry_id);
    expect(new Set(ids).size, "an entry was claimed twice").toBe(ids.length);
    expect(ids.length).toBeLessThanOrEqual(6);
    const claimed = await adminQuery(
      `select count(*)::int n from public.new_client_waitlist_entries where studio_id=$1 and status='claimed'`,
      [s.studioId],
    );
    expect(claimed.rows[0].n).toBe(ids.length);
  });

  it("G — SKIP LOCKED still skips a row held elsewhere", async () => {
    const s = await seedWaiting("bulk-skip", 2);
    const holder = await conn();
    await holder.query("begin");
    await holder.query(`select 1 from public.new_client_waitlist_entries where id=$1 for update`, [
      s.entryIds[0],
    ]);
    const won = await adminQuery(`select * from public.claim_new_client_waitlist_entries($1,$2,$3)`, [
      s.studioId, s.userId, 5,
    ]);
    await holder.query("rollback");
    await holder.end();
    const ids = won.rows.map((r) => (r as { entry_id: string }).entry_id);
    expect(ids).not.toContain(s.entryIds[0]);
    expect(ids).toContain(s.entryIds[1]);
  });

  it("H — no candidates is a zero-row result, not an exception", async () => {
    const s = await seedStudioOwner("bulk-empty");
    const won = await adminQuery(`select * from public.claim_new_client_waitlist_entries($1,$2,$3)`, [
      s.studioId, s.userId, 5,
    ]);
    expect(won.rows).toHaveLength(0);
  });
});
