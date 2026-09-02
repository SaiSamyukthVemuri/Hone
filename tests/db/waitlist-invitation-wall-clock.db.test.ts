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
async function waitUntilBlocked(pid: number, timeoutMs = 8000): Promise<string | null> {
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
  for (let i = 0; i < 300; i += 1) {
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
    const deadline = await restampExpiry(f.invId, 6);

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

    const deadline = await restampExpiry(f.invId, 6);

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

    const deadline = await restampExpiry(f.invId, 6);

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

    const deadline = await restampExpiry(f.invId, 6);

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
