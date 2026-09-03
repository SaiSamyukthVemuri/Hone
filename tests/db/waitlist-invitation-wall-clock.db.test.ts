import { afterAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { adminQuery, closePool, resolveLocalDbUrl } from "./helpers/harness";
import {
  eventIdSet,
  expectBlockedOn,
  expectExactlyOneNewEvent,
  expectInvisibleWhileUncommitted,
  expectChainChronological,
  expectPostgresOrdered,
  expectPostgresSameInstant,
  readStoredInstant,
  expectStillSees,
  newEventsSince,
  pickEvent,
  waitUntilBlocked,
  type ObservedEvent,
} from "./helpers/waitlist-concurrency";
import { linearizeByTransitionChain } from "./helpers/event-order";

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

/**
 * Read a transaction's own start instant and, in the SAME round trip, let
 * PostgreSQL decide whether it precedes the stored deadline.
 *
 * The verdict cannot be recomputed afterwards — `transaction_timestamp()` is
 * never stored — so it has to be evaluated server-side while it is still true,
 * against `expires_at` read straight from the row. Carrying both sides back as
 * JS Dates first would truncate two microsecond values to milliseconds, and a
 * transaction starting a few hundred microseconds AFTER the deadline would then
 * satisfy a precondition it actually violates.
 */
async function txStartsBeforeExpiry(
  c: Client,
  invId: string,
  why: string,
): Promise<{ t: Date; pid: number }> {
  const row = (
    await c.query(
      `select transaction_timestamp() as t,
              pg_backend_pid() as pid,
              transaction_timestamp() < i.expires_at as before,
              (extract(epoch from i.expires_at - transaction_timestamp()) * 1e6)::bigint as margin_us
         from public.new_client_waitlist_invitations i
        where i.id = $1`,
      [invId],
    )
  ).rows[0] as { t: Date; pid: number; before: boolean; margin_us: string };
  expect(row.before, `${why} (margin ${row.margin_us} us)`).toBe(true);
  return { t: row.t, pid: row.pid };
}

/**
 * Block until the SERVER's wall clock has passed an invitation's OWN
 * `expires_at`, comparing the stored `timestamptz` in place.
 *
 * WHY THIS EXISTS ALONGSIDE waitPastDeadline. That helper takes a JS `Date` and
 * sends `expiresAt.toISOString()`, which carries only MILLISECONDS —
 * PostgreSQL stores microseconds. So it can report "past" while the true
 * `expires_at` is still up to 1ms in the future, and a test that then asserts
 * `clock_timestamp() > expires_at` can legitimately fail. That is not
 * hypothetical: CI observed it twice, on runners fast enough for the remaining
 * margin to fall inside a single millisecond. Here the column never leaves the
 * database, so no precision is lost and the wait means what it says.
 */
async function waitPastInvitationExpiry(invId: string): Promise<void> {
  for (let i = 0; i < 800; i += 1) {
    const r = await adminQuery(
      `select clock_timestamp() > i.expires_at as past
         from public.new_client_waitlist_invitations i where i.id = $1`,
      [invId],
    );
    if (r.rows[0]?.past) return;
    await sleep(50);
  }
  const diag = await adminQuery(
    `select to_char(clock_timestamp(), 'HH24:MI:SS.US') as clock,
            to_char(i.expires_at,      'HH24:MI:SS.US') as expires_at
       from public.new_client_waitlist_invitations i where i.id = $1`,
    [invId],
  );
  throw new Error(
    `the wall clock never passed expires_at for ${invId} — ` +
      `clock ${diag.rows[0]?.clock}, expires_at ${diag.rows[0]?.expires_at}`,
  );
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
    // The stamp is the DECISION instant, not the transaction start. Both sides
    // are stored columns on one row, so PostgreSQL compares them at full
    // precision rather than after a millisecond truncation.
    await expectPostgresOrdered(
      {
        sql: `select expires_at, redeemed_at from ${INV_T} where id = $1`,
        params: [f.invId],
      },
      "the redemption stamp is after the deadline it was checked against",
    );
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
  it("INVITE->REDEEM — refuses a redemption whose window closed while it waited on the invitation lock", async () => {
    const f = await issueExpiringIn("wc-c", 6);

    // The deadline is stamped BEFORE anything locks the row, so setup duration
    // cannot consume the window and this call cannot block on a holder.
    await restampExpiry(f.invId, CROSS_DEADLINE_SECONDS);

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
    const t0 = await txStartsBeforeExpiry(
      b,
      f.invId,
      "PRECONDITION: the redeeming transaction must begin BEFORE the deadline",
    );

    // Fire the redemption WITHOUT awaiting it, then prove it is really blocked.
    const pending = b.query(
      `select result from public.redeem_new_client_waitlist_invitation($1)`,
      [f.token],
    );
    const ev = await expectBlockedOn(t0.pid, "the redeeming backend never actually blocked on a lock");
    expect(ev).toContain("Lock");

    // The window closes WHILE it waits.
    // Same precision rule as the two preconditions above: the margin between the
    // wall clock and the deadline is milliseconds, so PostgreSQL compares its own
    // stored `expires_at` rather than a JS-truncated copy of it.
    await waitPastInvitationExpiry(f.invId);
    const past = (
      await adminQuery(
        `select clock_timestamp() > i.expires_at as past
           from public.new_client_waitlist_invitations i where i.id = $1`,
        [f.invId],
      )
    ).rows[0].past as boolean;
    expect(past, "the wall clock has not actually passed the deadline").toBe(true);

    // Release WITHOUT invalidating the invitation, so the only thing that can
    // refuse the redemption is the TTL itself.
    await a.query("rollback");
    await a.end();

    const r = (await pending).rows[0] as { result: string };
    await b.query("commit");
    await b.end();

    expect(r.result, "an invitation whose window closed while the redemption waited must NOT redeem").toBe("invalid_token");
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
    await txStartsBeforeExpiry(
      b,
      f.invId,
      "PRECONDITION: this transaction must begin BEFORE the deadline",
    );

    await waitPastInvitationExpiry(f.invId);

    // Inside this transaction the two clocks now disagree, which is the whole
    // mechanism — and POSTGRESQL decides that, not JavaScript.
    //
    // Both operands are `timestamptz` with microsecond precision. Reading them
    // into JS `Date` truncates to milliseconds, and the real margin here is
    // single-digit milliseconds, so a truncated comparison can collapse a
    // genuinely strict ordering into equality and fail. CI hit exactly that:
    // `expected 1788446948552 to be greater than 1788446948552`. The comparison
    // is therefore evaluated in the database, against the stored column.
    const clocks = (
      await b.query(
        `select now() < i.expires_at              as txn_clock_still_inside,
                clock_timestamp() > i.expires_at  as wall_clock_past,
                to_char(now(), 'HH24:MI:SS.US')            as txn_clock,
                to_char(clock_timestamp(), 'HH24:MI:SS.US') as wall_clock,
                to_char(i.expires_at, 'HH24:MI:SS.US')      as expires_at
           from public.new_client_waitlist_invitations i where i.id = $1`,
        [f.invId],
      )
    ).rows[0] as Record<string, boolean | string>;
    expect(
      clocks.txn_clock_still_inside,
      `the transaction clock should still be inside the window (txn ${clocks.txn_clock}, expires ${clocks.expires_at})`,
    ).toBe(true);
    expect(
      clocks.wall_clock_past,
      `the wall clock should be past the window (wall ${clocks.wall_clock}, expires ${clocks.expires_at})`,
    ).toBe(true);

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
    const t0 = await txStartsBeforeExpiry(
      b,
      f.invId,
      "PRECONDITION: this transaction must begin BEFORE the deadline",
    );

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
    const t0 = await txStartsBeforeExpiry(
      b,
      f.invId,
      "PRECONDITION: this transaction must begin BEFORE the deadline",
    );
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
  it("EVERY command 0189 replaces keeps the deployed signature and contract", async () => {
    // WHY ALL EIGHT, not just the two this file used to check. 0189 replaces the
    // bodies of eight commands, and one of them —
    // `remove_new_client_waitlist_entry` — has a LIVE runtime caller in
    // app/(app)/settings/waitlist/actions.ts, which calls it by name with three
    // named parameters and treats the text result "removed" as success. A body
    // change that altered any of that would break a shipped surface, so the
    // whole replaced set is pinned here rather than the two that happened to be
    // under test when this file was written.
    const EXPECTED: Record<string, { args: string; result: string }> = {
      claim_new_client_waitlist_entries: {
        args: "p_studio_id uuid, p_actor_user_id uuid, p_count integer",
        result: "TABLE(result text, entry_id uuid)",
      },
      claim_new_client_waitlist_entry: {
        args: "p_studio_id uuid, p_entry_id uuid, p_actor_user_id uuid",
        result: "text",
      },
      expire_new_client_waitlist_invitation: {
        args: "p_studio_id uuid, p_entry_id uuid, p_actor_user_id uuid",
        result: "text",
      },
      issue_new_client_waitlist_invitation: {
        args: "p_studio_id uuid, p_entry_id uuid, p_actor_user_id uuid, p_ttl_hours integer",
        result: "TABLE(result text, raw_token text, expires_at timestamp with time zone)",
      },
      record_new_client_waitlist_conversion: {
        args: "p_studio_id uuid, p_entry_id uuid, p_client_id uuid",
        result: "text",
      },
      redeem_new_client_waitlist_invitation: {
        args: "p_raw_token text",
        result: "TABLE(result text, studio_id uuid, entry_id uuid)",
      },
      release_new_client_waitlist_entry: {
        args: "p_studio_id uuid, p_entry_id uuid, p_actor_user_id uuid",
        result: "text",
      },
      remove_new_client_waitlist_entry: {
        args: "p_studio_id uuid, p_entry_id uuid, p_actor_user_id uuid",
        result: "text",
      },
    };

    const r = await adminQuery(
      `select p.proname,
              pg_get_function_identity_arguments(p.oid) as args,
              pg_get_function_result(p.oid)             as result,
              p.prosecdef                                as secdef,
              p.provolatile                              as volatile,
              array_to_string(p.proconfig, ',')          as config
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = any($1::text[])
        order by p.proname`,
      [Object.keys(EXPECTED)],
    );
    expect(
      r.rows.map((x: Record<string, unknown>) => x.proname),
      "a replaced command is missing from the database",
    ).toEqual(Object.keys(EXPECTED).sort());

    for (const row of r.rows as Array<Record<string, string | boolean>>) {
      const name = row.proname as string;
      expect(row.args, `${name} argument list changed`).toBe(EXPECTED[name].args);
      expect(row.result, `${name} return type changed`).toBe(EXPECTED[name].result);
      expect(row.secdef, `${name} lost SECURITY DEFINER`).toBe(true);
      expect(row.volatile, `${name} volatility changed`).toBe("v");
      expect(row.config, `${name} search_path changed`).toBe("search_path=pg_catalog, pg_temp");
    }
  });

  it("the removal command the app calls still answers `removed` on success", async () => {
    // The exact shipped path: app/(app)/settings/waitlist/actions.ts calls this
    // by name and treats anything other than the string "removed" as a failure.
    const s = await bareStudio("app-remove");
    const e = await joinEntry(s);
    const r = await adminQuery(
      `select public.remove_new_client_waitlist_entry($1,$2,$3) as r`,
      [s.studioId, e, s.userId],
    );
    expect(r.rows[0].r, "the runtime caller's success value changed").toBe("removed");
    expect(await entryStatus(e)).toBe("removed");
  });

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
  it("INVITE->EXPIRE — stamps expired_at at or after the moment the holder released", async () => {
    const f = await issueAlreadyElapsed("p2-b");
    const holder = await holdInvitation(f.invId);

    const b = await conn();
    await b.query("begin");
    const pid = (await b.query(`select pg_backend_pid() as pid`)).rows[0].pid as number;
    const pending = b.query(
      `select public.expire_new_client_waitlist_invitation($1,$2,$3) as r`,
      [f.studioId, f.entryId, f.userId],
    );
    await expectBlockedOn(pid, "expire never blocked on the invitation");

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
    const releaseBoundaryText = await readStoredInstant(`select clock_timestamp()`);
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
    // predate the lock that serialized it. Both operands are PostgreSQL
    // instants, so PostgreSQL compares them — with no tolerance, because the
    // boundary is read before the holder rolls back and the stamp is taken
    // after the lock is granted.
    await expectPostgresOrdered(
      {
        sql: `select expired_at, $2::timestamptz from ${INV_T} where id = $1`,
        params: [f.invId, releaseBoundaryText],
      },
      "expired_at predates the serializing lock release — stale provenance",
    );
    expect(await entryStatus(f.entryId)).toBe("expired");

    // Invitation and entry are stamped from the SAME decision value — exactly,
    // at PostgreSQL precision. A sub-millisecond difference would mean two clock
    // reads, which is the defect this migration removes.
    await expectEntryMatchesInvitation(
      f.entryId,
      f.invId,
      "expired_at",
      "the invitation and the entry were stamped at different instants",
    );
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
      // Full-precision snapshot of every historical stamp, taken as text so the
      // comparison after the transition never involves a truncated Date.
      const beforeStamps = new Map<string, string | null>();
      for (const row of before) {
        for (const column of ["expired_at", "released_at"] as const) {
          beforeStamps.set(
            `${row.id}:${column}`,
            await readStoredInstant(
              `select i.${column} from ${INV_T} i where i.id = $1`,
              [row.id],
            ),
          );
        }
      }
      const r = await adminQuery(
        `select public.expire_new_client_waitlist_invitation($1,$2,$3) as r`,
        [f.studioId, f.entryId, f.userId],
      );
      expect(r.rows[0].r).toBe("expired");
      const after = await cyclesOf(f.entryId);
      // Unchanged means unchanged at STORED precision. The "before" value was
      // captured as microsecond text, because handing a JS Date back as a
      // parameter would compare a truncated copy against its own source.
      for (const b of before.filter((x) => x.id !== liveId)) {
        expect(
          after.some((x) => x.id === b.id),
          `historical row ${b.id} disappeared`,
        ).toBe(true);
        for (const column of ["expired_at", "released_at"] as const) {
          expect(
            await readStoredInstant(`select i.${column} from ${INV_T} i where i.id = $1`, [b.id]),
            `historical row ${b.id} had its ${column} rewritten`,
          ).toBe(beforeStamps.get(`${b.id}:${column}`) ?? null);
        }
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

    // Both brackets are POSTGRESQL clock reads, carried as microsecond text so
    // the round trip does not truncate them. The old +/-5ms slack existed only
    // to absorb that truncation; the bracket is strictly true without it.
    const before = await readStoredInstant(`select clock_timestamp()`);
    expect(await release(f.studioId, f.entryId, f.userId)).toBe("released");
    const after = await readStoredInstant(`select clock_timestamp()`);

    const e = await entryRow(f.entryId);
    expect(e.status).toBe("released");
    expect(e.released_at).not.toBeNull();
    await expectPostgresOrdered(
      { sql: `select released_at, $2::timestamptz from ${EN_T} where id = $1`, params: [f.entryId, before] },
      "released_at is before the clock read taken just before the release",
    );
    await expectPostgresOrdered(
      { sql: `select $2::timestamptz, released_at from ${EN_T} where id = $1`, params: [f.entryId, after] },
      "released_at is after the clock read taken just after the release",
    );
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
    await expectEntryMatchesInvitation(
      f.entryId,
      f.invId,
      "released_at",
      "the invitation and the entry were stamped at different instants",
    );
  });
});

describe("RELEASE C — a release can never predate the invitation it releases", () => {
  it("does not stamp released_at before issued_at when the transaction began earlier", async () => {
    const f = await seedClaimedNoInvitation("rel-inv");

    const b = await conn();
    await b.query("begin");
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
    // POSTGRESQL DECIDES THIS ORDERING, not JavaScript. `issued_at` and the
    // releasing transaction's start are both microsecond `timestamptz` values a
    // few milliseconds apart; read into JS `Date` they truncate to milliseconds
    // and can land in the same bucket, which is how CI produced
    // `expected 1788446996275 to be greater than 1788446996275` for an ordering
    // that was strictly true in the database. Evaluated from inside the OLD
    // transaction, so `transaction_timestamp()` is exactly the authority the
    // precondition is about.
    const ordering = (
      await b.query(
        `select i.issued_at > transaction_timestamp() as issued_after_txn_start,
                to_char(i.issued_at, 'HH24:MI:SS.US')             as issued_at,
                to_char(transaction_timestamp(), 'HH24:MI:SS.US') as txn_start
           from public.new_client_waitlist_invitations i where i.id = $1`,
        [inv.id],
      )
    ).rows[0] as Record<string, boolean | string>;
    expect(
      ordering.issued_after_txn_start,
      `PRECONDITION: the invitation must be issued after the releasing transaction began ` +
        `(issued ${ordering.issued_at}, txn start ${ordering.txn_start})`,
    ).toBe(true);

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

    // THE VERDICT, ALSO DECIDED BY POSTGRESQL. Fixing only the precondition
    // above would have left the finding half-closed: this comparison is
    // NON-STRICT, so truncating both microsecond columns to JS milliseconds
    // turns a real sub-millisecond backdating into an accepted equality — the
    // test would pass while missing the exact inversion it exists to catch.
    // Compared in place, against the stored columns.
    const chronology = (
      await adminQuery(
        `select i.released_at >= i.issued_at as release_not_before_issue,
                to_char(i.released_at, 'HH24:MI:SS.US') as released_at,
                to_char(i.issued_at,   'HH24:MI:SS.US') as issued_at
           from public.new_client_waitlist_invitations i where i.id = $1`,
        [inv.id],
      )
    ).rows[0] as Record<string, boolean | string>;
    expect(
      chronology.release_not_before_issue,
      `released_at PREDATES issued_at — the lifecycle chronology is inverted ` +
        `(released ${chronology.released_at}, issued ${chronology.issued_at})`,
    ).toBe(true);
    // ...and the entry agrees with the invitation, to the microsecond.
    await expectEntryMatchesInvitation(
      f.entryId,
      inv.id,
      "released_at",
      "the entry and the invitation were stamped at different instants",
    );
  });
});

describe("RELEASE D — a wait on the invitation lock does not backdate the stamp", () => {
  it("INVITE->RELEASE — stamps released_at at or after the moment the holder released", async () => {
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
    await expectBlockedOn(pid, "release never blocked on the invitation");

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
    const boundaryText = await readStoredInstant(`select clock_timestamp()`);
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
    expect(st.released_at).not.toBeNull();
    await expectPostgresOrdered(
      {
        sql: `select released_at, $2::timestamptz from ${INV_T} where id = $1`,
        params: [f.invId, boundaryText],
      },
      "released_at predates the serializing lock release",
    );
    await expectEntryMatchesInvitation(
      f.entryId,
      f.invId,
      "released_at",
      "the entry and the invitation were stamped at different instants",
    );
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
    const expiredAtText = await readStoredInstant(
      `select i.expired_at from ${INV_T} i where i.id = $1`,
      [f.invId],
    );
    expect(expiredAtText, "the entry was never expired").not.toBeNull();

    expect(await release(f.studioId, f.entryId, f.userId)).toBe("released");

    expect(
      await readStoredInstant(`select i.expired_at from ${INV_T} i where i.id = $1`, [f.invId]),
      "the expired evidence was rewritten",
    ).toBe(expiredAtText);
    const st = await stateOf(f.invId);
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
      // Strictly older, judged in PostgreSQL: a re-stamp that landed within the
      // same millisecond would read as unchanged through JS Date.
      await expectPostgresOrdered(
        {
          sql: `select live.released_at, hist.released_at from public.new_client_waitlist_invitations live, public.new_client_waitlist_invitations hist
                  where live.id = $1 and hist.id = $2`,
          params: [f.liveId, row.id],
        },
        `historical row ${row.id} was re-stamped by this release`,
      );
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

/**
 * Events for an entry in TRANSITION order, reconstructed from the state chain
 * ALONE — never from `occurred_at`, which is the evidence under test.
 *
 * THIS IS NOT AN INSERTION-ORDER READ, and it is deliberately no longer named
 * as though it were. The events table stores no sequence: `id` is a random uuid
 * and there is no ordinal. So this recovers an order only when the transition
 * labels determine exactly one, and REFUSES a history that repeats a transition
 * — two release/requeue cycles, say — because the repeats could only be told
 * apart by their timestamps. Those histories use `observed()` below, which knows
 * the order because it watched the operations happen.
 */
const EV_T = "public.new_client_waitlist_entry_events";
const EN_T = "public.new_client_waitlist_entries";
const INV_T = "public.new_client_waitlist_invitations";

/** Transition stamps an entry row can carry. Closed set, so the column name
 *  below is trusted code rather than caller input. */
type EntryStamp =
  | "joined_at" | "claimed_at" | "invited_at"
  | "released_at" | "expired_at" | "converted_at" | "removed_at";

/** An event's occurred_at IS the entry's transition stamp — one instant, exactly. */
const expectEventIsEntryStamp = (
  eventId: string,
  entryId: string,
  column: EntryStamp,
  why: string,
): Promise<void> =>
  expectPostgresSameInstant(
    {
      sql: `select ev.occurred_at, en.${column} from ${EV_T} ev, ${EN_T} en
              where ev.id = $1 and en.id = $2`,
      params: [eventId, entryId],
    },
    why,
  );

/** An entry stamp and its invitation's stamp are the same decision instant. */
const expectEntryMatchesInvitation = (
  entryId: string,
  invId: string,
  column: "released_at" | "expired_at",
  why: string,
): Promise<void> =>
  expectPostgresSameInstant(
    {
      sql: `select en.${column}, i.${column} from ${EN_T} en, ${INV_T} i
              where en.id = $1 and i.id = $2`,
      params: [entryId, invId],
    },
    why,
  );

async function eventsAlongTransitionChain(entryId: string): Promise<ObservedEvent[]> {
  const rows = (
    await adminQuery(
      `select id, from_status, to_status, occurred_at
         from public.new_client_waitlist_entry_events where entry_id = $1`,
      [entryId],
    )
  ).rows as ObservedEvent[];
  const out = linearizeByTransitionChain(rows);
  expect(out.ok ? "" : out.detail, "the event history could not be linearized").toBe("");
  return out.ok ? out.chain : [];
}

// ---------------------------------------------------------------------------
// INDEPENDENT EVENT IDENTITY.
//
// The harness controls the operations, so it — unlike the database — knows what
// order they ran in. Each controlled transition is bracketed: snapshot the entry's
// event ids, perform the transition, then take the id that is NEW. That set
// difference is the identity, and it owes nothing to `occurred_at`, to uuid
// ordering, to ctid, or to the order a query happened to return rows in.
//
// The timestamps are then CHECKED against that independently established order,
// which is the direction the evidence has to flow.
// ---------------------------------------------------------------------------
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

describe("STALE-TRANSACTION-TIMESTAMP PROBES — the log never runs backwards", () => {
  // WHAT THESE ARE, EXACTLY. Each case opens a transaction whose
  // transaction_timestamp() is already old, then performs its own transition
  // from it. Under 0188's transaction-start stamping every one of these
  // inverts, so they are a real and load-bearing regression net for THAT
  // defect.
  //
  // WHAT THESE ARE NOT. Nothing here blocks: the preceding transition commits
  // on a separate autocommit connection, so no successor ever parks on a lock.
  // They are therefore NOT serialization proofs, and no edge in the manifest is
  // certified by them. The serialization boundaries live in the edge tests at
  // the end of this file, where the successor is proven parked before the
  // predecessor is released.

  it("JOIN -> CLAIM", async () => {
    const s = await bareStudio("tmp-a");
    const old = await oldTransaction();
    const e = await joinEntry(s); // joined AFTER the claiming transaction began
    await old.query(`select public.claim_new_client_waitlist_entry($1,$2,$3)`, [s.studioId, e, s.userId]);
    await old.query("commit");
    await old.end();
    await expectChainChronological(
      (await eventsAlongTransitionChain(e)).map((x) => x.id),
      "the append-only log runs backwards",
    );
  });

  it("CLAIM -> INVITE", async () => {
    const s = await bareStudio("tmp-b");
    const e = await joinEntry(s);
    const old = await oldTransaction();
    await adminQuery(`select public.claim_new_client_waitlist_entry($1,$2,$3)`, [s.studioId, e, s.userId]);
    await old.query(`select public.issue_new_client_waitlist_invitation($1,$2,$3,72)`, [s.studioId, e, s.userId]);
    await old.query("commit");
    await old.end();
    const rows = await eventsAlongTransitionChain(e);
    await expectChainChronological(
      rows.map((x) => x.id),
      "the append-only log runs backwards",
    );
    // ...and the entry's own evidence agrees with the event, exactly.
    await expectEventIsEntryStamp(
      rows.find((r) => r.to_status === "invited")!.id,
      e,
      "invited_at",
      "the invited event and the entry stamp are different instants",
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
    await expectChainChronological(
      (await eventsAlongTransitionChain(e)).map((x) => x.id),
      "the append-only log runs backwards",
    );
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
    await expectChainChronological(
      (await eventsAlongTransitionChain(e)).map((x) => x.id),
      "the append-only log runs backwards",
    );
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
    const rows = await eventsAlongTransitionChain(e);
    await expectChainChronological(
      rows.map((x) => x.id),
      "the append-only log runs backwards",
    );
    // requeue CLEARS the cycle columns, so its event takes the trigger's own
    // post-transition clock rather than a stale joined_at.
    const requeued = rows[rows.length - 1];
    expect(requeued.to_status).toBe("waiting");
    await expectPostgresOrdered(
      {
        sql: `select ev.occurred_at, en.joined_at from public.new_client_waitlist_entry_events ev, public.new_client_waitlist_entries en
                where ev.entry_id = $1 and ev.to_status = 'waiting'
                  and ev.from_status = 'released' and en.id = $1`,
        params: [e],
      },
      "the requeue event was backdated to the original join",
    );
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
      await expectChainChronological(
        (await eventsAlongTransitionChain(e)).map((x) => x.id),
        "the append-only log runs backwards",
      );
    });
  }
});

describe("the event IS the transition, not a second reading of it", () => {
  it("released: event.occurred_at EQUALS entry.released_at", async () => {
    const f = await issueExpiringIn("ev-rel", 300);
    await release(f.studioId, f.entryId, f.userId);
    const rows = await eventsAlongTransitionChain(f.entryId);
    await expectEventIsEntryStamp(
      rows.find((r) => r.to_status === "released")!.id,
      f.entryId,
      "released_at",
      "the released event and the entry stamp are different instants",
    );
  });

  it("expired: event.occurred_at EQUALS entry.expired_at", async () => {
    const f = await issueAlreadyElapsed("ev-exp");
    await adminQuery(`select public.expire_new_client_waitlist_invitation($1,$2,$3)`, [
      f.studioId, f.entryId, f.userId,
    ]);
    const rows = await eventsAlongTransitionChain(f.entryId);
    await expectEventIsEntryStamp(
      rows.find((r) => r.to_status === "expired")!.id,
      f.entryId,
      "expired_at",
      "the expired event and the entry stamp are different instants",
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

    const rows = await eventsAlongTransitionChain(f.entryId);
    const released = rows.find((r) => r.to_status === "released")!;
    const drift = boundary.getTime() - released.occurred_at.getTime();
    expect(drift, `the release EVENT is ${drift}ms older than the serializing lock`).toBeLessThan(250);
    // ...and it still equals the entry stamp exactly, to the microsecond.
    await expectEventIsEntryStamp(
      released.id,
      f.entryId,
      "released_at",
      "the release event and the entry stamp are different instants",
    );
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
    await sleep(400);
    // PostgreSQL states both facts about its own clocks: `now()` is still
    // frozen at transaction start, and `clock_timestamp()` has moved past it.
    // Both readings would otherwise be truncated to JS milliseconds before the
    // equality was tested.
    const clocks = (
      await older.query(
        `select now() = transaction_timestamp() as frozen,
                (extract(epoch from clock_timestamp() - now()) * 1000)::bigint as drift_ms`,
      )
    ).rows[0] as { frozen: boolean; drift_ms: string };
    await older.query("rollback");
    await older.end();
    expect(clocks.frozen, "now() is no longer transaction-start").toBe(true);
    expect(
      Number(clocks.drift_ms),
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

/**
 * The event whose `to_status` is `status` — and only when the entry visited that
 * status EXACTLY ONCE.
 *
 * This replaced a helper that took `order by occurred_at desc limit 1`. That was
 * the same circularity as the retired chain reconstruction, hiding in a
 * one-liner: on an entry that reached `waiting` twice it used the timestamp to
 * decide WHICH `waiting` event was meant, and the answer was then used to prove
 * the timestamps were ordered. Where a status genuinely repeats, the caller must
 * capture the event by observed identity instead — this refuses rather than
 * guessing.
 */
const soleEventAt = async (entryId: string, status: string): Promise<Date> => {
  const rows = (
    await adminQuery(
      `select occurred_at from public.new_client_waitlist_entry_events
        where entry_id=$1 and to_status=$2`,
      [entryId, status],
    )
  ).rows as Array<{ occurred_at: Date }>;
  expect(
    rows.length,
    `this entry reached '${status}' ${rows.length} times — choosing between them needs ` +
      `observed event identity, never occurred_at`,
  ).toBe(1);
  return rows[0].occurred_at;
};

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
  // The requeue's own event, identified by the id it appended — this entry has
  // reached `waiting` twice, so a timestamp could not tell them apart.
  const beforeRequeue = await eventIdSet(entryId);
  await adminQuery(`select public.requeue_new_client_waitlist_entry($1,$2,$3)`, [
    s.studioId, entryId, s.userId,
  ]);
  const waitingEv = await expectExactlyOneNewEvent(entryId, beforeRequeue, "released", "waiting");

  await gate.query("commit");
  await gate.end();
  const won = (await pending).rows as Array<{ entry_id: string }>;
  await claimer.query("commit");
  await claimer.end();

  const row = (
    await adminQuery(`select status, claimed_at from public.new_client_waitlist_entries where id=$1`, [entryId])
  ).rows[0] as { status: string; claimed_at: Date | null };
  return { claimedIt: won.some((w) => w.entry_id === entryId), waitingEv, row };
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
      // The control must show a STRICT inversion, and the inversion it produces
      // can be sub-millisecond — so PostgreSQL compares the stored columns.
      const inverted = (
        await adminQuery(
          `select en.claimed_at < ev.occurred_at as old_shape_inverts,
                  round(extract(epoch from (en.claimed_at - ev.occurred_at)) * 1000000)::bigint as delta_us
             from public.new_client_waitlist_entries en, public.new_client_waitlist_entry_events ev where en.id = $1 and ev.id = $2`,
          [e, r.waitingEv.id],
        )
      ).rows[0] as { old_shape_inverts: boolean; delta_us: string };
      expect(
        inverted.old_shape_inverts,
        `the old shape no longer inverts — this control is vacuous (delta ${inverted.delta_us}us)`,
      ).toBe(true);
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
    const beforeRequeue = await eventIdSet(e);
    await adminQuery(`select public.requeue_new_client_waitlist_entry($1,$2,$3)`, [s.studioId, e, s.userId]);
    const waitingEv = await expectExactlyOneNewEvent(e, beforeRequeue, "released", "waiting");
    await gate.query("commit");
    await gate.end();

    const beforeClaim = await eventIdSet(e);
    await adminQuery(`select * from public.claim_new_client_waitlist_entries($1,$2,$3)`, [
      s.studioId, s.userId, 5,
    ]);
    const claimedEv = await expectExactlyOneNewEvent(e, beforeClaim, "waiting", "claimed");
    const row = (
      await adminQuery(`select status, claimed_at from public.new_client_waitlist_entries where id=$1`, [e])
    ).rows[0] as { status: string; claimed_at: Date };
    expect(row.status).toBe("claimed");
    await expectPostgresOrdered(
      {
        sql: `select en.claimed_at, ev.occurred_at from public.new_client_waitlist_entries en, public.new_client_waitlist_entry_events ev
                where en.id = $1 and ev.id = $2`,
        params: [e, waitingEv.id],
      },
      "claimed_at precedes the requeue that made the row claimable",
    );
    // Both events captured by identity, so this compares the SECOND `waiting`
    // against the SECOND `claimed` — which is the comparison that matters and the
    // one a timestamp-sorted chain could silently get wrong.
    await expectPostgresOrdered(
      {
        sql: `select a.occurred_at, b.occurred_at from public.new_client_waitlist_entry_events a, public.new_client_waitlist_entry_events b
                where a.id = $1 and b.id = $2`,
        params: [claimedEv.id, waitingEv.id],
      },
      "the claimed event predates the requeue that enabled it",
    );
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
    // ONE instant across all winners, counted by PostgreSQL: two stamps a few
    // hundred microseconds apart would collapse into one bucket through Date.
    const distinct = await adminQuery(
      `select count(distinct claimed_at)::int as n from ${EN_T} where studio_id = $1`,
      [s.studioId],
    );
    expect(
      distinct.rows[0].n,
      "one bulk claim produced more than one claim instant",
    ).toBe(1);
    for (const r of rows.rows as Array<{ id: string }>) {
      const ev = await adminQuery(
        `select id from ${EV_T} where entry_id = $1 and to_status = 'claimed'`,
        [r.id],
      );
      expect(ev.rows, `no single claimed event for ${r.id}`).toHaveLength(1);
      await expectEventIsEntryStamp(
        ev.rows[0].id as string,
        r.id,
        "claimed_at",
        `event != entry stamp for ${r.id}`,
      );
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

// ===========================================================================
// CONVERSION — the entry mutex does NOT serialize a redemption.
//
// redeem() locks the INVITATION and deliberately never asks for the entry, so
// it runs to completion while conversion holds the entry row. Conversion read
// its clock before testing for redemption, so a redemption committing in that
// window produced converted_at EARLIER than redeemed_at.
//
// Measured on the pre-repair shape: redemption committed 19:47:08.980Z while
// conversion held the entry; conversion stamped 19:47:08.973Z — the conversion
// recorded BEFORE the redemption that authorised it.
// ===========================================================================

const CONVERT_GATE = 771144;

async function seedInvitedWithClient(label: string) {
  const f = await issueExpiringIn(label, 600);
  const clientId = randomUUID();
  await adminQuery(`insert into public.clients (id, studio_id, name, email) values ($1,$2,$3,$4)`, [
    clientId, f.studioId, `C ${label}`, `c-${randomUUID().slice(0, 8)}@harness.local`,
  ]);
  return { ...f, clientId };
}

const convert = (studioId: string, entryId: string, clientId: string) =>
  adminQuery(`select public.record_new_client_waitlist_conversion($1,$2,$3) as r`, [
    studioId, entryId, clientId,
  ]).then((x) => x.rows[0].r as string);

const convertedAt = async (entryId: string) =>
  (
    await adminQuery(
      `select status, converted_at from public.new_client_waitlist_entries where id=$1`,
      [entryId],
    )
  ).rows[0] as { status: string; converted_at: Date | null };

const redeemedAtOf = async (invId: string) =>
  (await adminQuery(`select redeemed_at from public.new_client_waitlist_invitations where id=$1`, [invId]))
    .rows[0].redeemed_at as Date | null;

describe("conversion — serialization against an in-flight redemption", () => {
  const OLD_FN = "zz_convert_old_shape";

  it("J — NEGATIVE CONTROL: the old ordering stamps before the redemption", async () => {
    // Reconstructs the pre-repair structure — entry lock, clock, THEN the
    // redemption test — with a barrier in that gap. If this stops inverting,
    // the repaired assertions below prove nothing.
    await adminQuery(`
      create or replace function public.${OLD_FN}(p_studio uuid, p_entry uuid, p_client uuid)
      returns text language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $fn$
      declare v_decision_at timestamptz; v_hit uuid;
      begin
        perform 1 from public.new_client_waitlist_entries e
         where e.id = p_entry and e.studio_id = p_studio for update;
        v_decision_at := clock_timestamp();
        perform pg_advisory_xact_lock(${CONVERT_GATE});
        update public.new_client_waitlist_entries
           set status='converted', converted_at=v_decision_at, converted_client_id=p_client
         where id=p_entry and studio_id=p_studio and status='invited'
           and exists (select 1 from public.new_client_waitlist_invitations i
                        where i.entry_id=p_entry and i.studio_id=p_studio and i.redeemed_at is not null)
        returning id into v_hit;
        if v_hit is null then return 'not_invited'; end if;
        return 'converted';
      end; $fn$;`);
    try {
      const f = await seedInvitedWithClient("cv-neg");
      const gate = await conn();
      await gate.query("begin");
      await gate.query(`select pg_advisory_xact_lock(${CONVERT_GATE})`);

      const conv = await conn();
      await conv.query("begin");
      const pid = (await conv.query(`select pg_backend_pid() as pid`)).rows[0].pid as number;
      const pending = conv.query(`select public.${OLD_FN}($1,$2,$3) as r`, [
        f.studioId, f.entryId, f.clientId,
      ]);
      expect(await waitUntilBlocked(pid), "the control never parked").not.toBeNull();

      // THE PREMISE: redemption succeeds while conversion holds the ENTRY.
      expect(
        (await adminQuery(`select result from public.redeem_new_client_waitlist_invitation($1)`, [f.token]))
          .rows[0].result,
        "the entry mutex blocked the redemption — the premise does not hold",
      ).toBe("redeemed");
      const redeemed = (await redeemedAtOf(f.invId))!;

      await gate.query("commit");
      await gate.end();
      expect((await pending).rows[0].r).toBe("converted");
      await conv.query("commit");
      await conv.end();

      const e = await convertedAt(f.entryId);
      // The control must show a STRICT inversion, and a sub-millisecond one is
      // exactly what it is built to produce — so it cannot be judged on
      // truncated copies either.
      const inverted = (
        await adminQuery(
          `select e.converted_at < i.redeemed_at as old_ordering_inverts,
                  to_char(e.converted_at, 'HH24:MI:SS.US') as converted_at,
                  to_char(i.redeemed_at,  'HH24:MI:SS.US') as redeemed_at
             from public.new_client_waitlist_entries e
             join public.new_client_waitlist_invitations i on i.id = $2
            where e.id = $1`,
          [f.entryId, f.invId],
        )
      ).rows[0] as Record<string, boolean | string>;
      expect(
        inverted.old_ordering_inverts,
        `the old ordering no longer inverts — this control is vacuous ` +
          `(converted ${inverted.converted_at}, redeemed ${inverted.redeemed_at})`,
      ).toBe(true);
      void e;
      void redeemed;
    } finally {
      await adminQuery(`drop function if exists public.${OLD_FN}(uuid,uuid,uuid)`);
    }
  });

  it("REDEEM->CONVERT — conversion waits for the redemption, then stamps after it", async () => {
    // NO artificial barrier: the redemption itself holds the invitation, which
    // is the real production schedule.
    const f = await seedInvitedWithClient("cv-commit");
    const redeemer = await conn();
    await redeemer.query("begin");
    expect(
      (await redeemer.query(`select result from public.redeem_new_client_waitlist_invitation($1)`, [f.token]))
        .rows[0].result,
    ).toBe("redeemed");

    const conv = await conn();
    await conv.query("begin");
    const pid = (await conv.query(`select pg_backend_pid() as pid`)).rows[0].pid as number;
    const pending = conv.query(`select public.record_new_client_waitlist_conversion($1,$2,$3) as r`, [
      f.studioId, f.entryId, f.clientId,
    ]);
    await expectBlockedOn(pid, "conversion did not serialize against the in-flight redemption");

    await redeemer.query("commit");
    await redeemer.end();
    expect((await pending).rows[0].r).toBe("converted");
    await conv.query("commit");
    await conv.end();

    const redeemed = (await redeemedAtOf(f.invId))!;
    const e = await convertedAt(f.entryId);
    expect(e.status).toBe("converted");
    // Same rule as RELEASE C's verdict: both are microsecond columns and the
    // margin is a lock wait, so PostgreSQL compares them rather than their
    // millisecond-truncated copies.
    const order = (
      await adminQuery(
        `select e.converted_at >= i.redeemed_at as converted_not_before_redeem,
                to_char(e.converted_at, 'HH24:MI:SS.US') as converted_at,
                to_char(i.redeemed_at,  'HH24:MI:SS.US') as redeemed_at
           from public.new_client_waitlist_entries e
           join public.new_client_waitlist_invitations i on i.id = $2
          where e.id = $1`,
        [f.entryId, f.invId],
      )
    ).rows[0] as Record<string, boolean | string>;
    expect(
      order.converted_not_before_redeem,
      `converted_at precedes the redemption that authorised it ` +
        `(converted ${order.converted_at}, redeemed ${order.redeemed_at})`,
    ).toBe(true);
    void redeemed;
    // ...and the event is the transition, not a second reading of it.
    const convEv = await adminQuery(
      `select id from ${EV_T} where entry_id = $1 and to_status = 'converted'`,
      [f.entryId],
    );
    expect(convEv.rows, "no single converted event").toHaveLength(1);
    await expectEventIsEntryStamp(
      convEv.rows[0].id as string,
      f.entryId,
      "converted_at",
      "the converted event and the entry stamp are different instants",
    );
    await expectChainChronological(
      (await eventsAlongTransitionChain(f.entryId)).map((x) => x.id),
      "the append-only log runs backwards",
    );
  });

  it("C — REPAIRED: a redemption that ROLLS BACK leaves conversion refusing", async () => {
    const f = await seedInvitedWithClient("cv-rollback");
    const redeemer = await conn();
    await redeemer.query("begin");
    await redeemer.query(`select result from public.redeem_new_client_waitlist_invitation($1)`, [f.token]);

    const conv = await conn();
    await conv.query("begin");
    const pid = (await conv.query(`select pg_backend_pid() as pid`)).rows[0].pid as number;
    const pending = conv.query(`select public.record_new_client_waitlist_conversion($1,$2,$3) as r`, [
      f.studioId, f.entryId, f.clientId,
    ]);
    expect(await waitUntilBlocked(pid)).not.toBeNull();

    await redeemer.query("rollback");
    await redeemer.end();
    expect((await pending).rows[0].r).toBe("not_redeemed");
    await conv.query("commit");
    await conv.end();

    expect(await redeemedAtOf(f.invId)).toBeNull();
    const e = await convertedAt(f.entryId);
    expect(e.converted_at).toBeNull();
    expect(e.status).toBe("invited");
  });

  it("A/D — an already-committed redemption converts normally", async () => {
    const f = await seedInvitedWithClient("cv-normal");
    await adminQuery(`select public.redeem_new_client_waitlist_invitation($1)`, [f.token]);
    expect(await redeemedAtOf(f.invId)).not.toBeNull();
    expect(await convert(f.studioId, f.entryId, f.clientId)).toBe("converted");
    const e = await convertedAt(f.entryId);
    expect(e.converted_at).not.toBeNull();
    // Conversion cannot precede the redemption it depends on. Both stamps are
    // stored timestamptz on two rows, so PostgreSQL joins them and compares.
    await expectPostgresOrdered(
      {
        sql: `select e.converted_at, i.redeemed_at
                from ${EN_T} e join ${INV_T} i on i.entry_id = e.id
               where e.id = $1`,
        params: [f.entryId],
      },
      "the conversion stamp precedes the redemption it followed",
    );
    const convEvId = await adminQuery(
      `select id from ${EV_T} where entry_id = $1 and to_status = 'converted'`,
      [f.entryId],
    );
    expect(convEvId.rows, "no single converted event").toHaveLength(1);
    await expectEventIsEntryStamp(
      convEvId.rows[0].id as string,
      f.entryId,
      "converted_at",
      "the converted event and the entry stamp are different instants",
    );
  });

  it("E — an unredeemed invitation still refuses, and writes nothing", async () => {
    const f = await seedInvitedWithClient("cv-unredeemed");
    expect(await convert(f.studioId, f.entryId, f.clientId)).toBe("not_redeemed");
    expect((await convertedAt(f.entryId)).converted_at).toBeNull();
  });

  it("F — two concurrent conversions yield exactly one winner", async () => {
    const f = await seedInvitedWithClient("cv-dup");
    await adminQuery(`select public.redeem_new_client_waitlist_invitation($1)`, [f.token]);
    const [a, b] = await Promise.all([
      convert(f.studioId, f.entryId, f.clientId),
      convert(f.studioId, f.entryId, f.clientId),
    ]);
    expect([a, b].filter((r) => r === "converted"), `a=${a} b=${b}`).toHaveLength(1);
    expect((await convertedAt(f.entryId)).status).toBe("converted");
  });

  for (const [name, cmd] of [
    ["G — conversion || release", "release_new_client_waitlist_entry"],
    ["H — conversion || expire", "expire_new_client_waitlist_invitation"],
  ] as const) {
    it(`${name}: coherent, no deadlock`, async () => {
      const f = await seedInvitedWithClient(`cv-${cmd.slice(0, 6)}`);
      await adminQuery(`select public.redeem_new_client_waitlist_invitation($1)`, [f.token]);
      const [conv, other] = await Promise.all([
        convert(f.studioId, f.entryId, f.clientId),
        adminQuery(`select public.${cmd}($1,$2,$3) as r`, [f.studioId, f.entryId, f.userId]).then(
          (x) => x.rows[0].r as string,
        ),
      ]);
      // Redemption is terminal for the entry, so the other command must refuse.
      expect(other, `conv=${conv} other=${other}`).toBe("already_redeemed");
      expect(conv).toBe("converted");
      expect((await convertedAt(f.entryId)).status).toBe("converted");
    });
  }

  it("I — the existing refusal vocabulary is unchanged", async () => {
    const f = await seedInvitedWithClient("cv-vocab");
    expect(await convert(f.studioId, f.entryId, randomUUID())).toBe("client_not_found");
    const other = await seedStudioOwner("cv-other");
    expect(await convert(other.studioId, f.entryId, f.clientId)).toBe("client_not_found");
    const nulls = await adminQuery(
      `select public.record_new_client_waitlist_conversion(null,null,null) as r`,
    );
    expect(nulls.rows[0].r).toBe("invalid_input");
  });

  it("at most ONE redeemed invitation can exist per entry", async () => {
    // The assumption the no-live-invitation branch rests on, asserted rather
    // than commented: conversion never has to identify a redeemed row by
    // chronology because a second one cannot exist.
    const f = await seedInvitedWithClient("cv-unique");
    await adminQuery(`select public.redeem_new_client_waitlist_invitation($1)`, [f.token]);
    for (const [cmd, expected] of [
      ["release_new_client_waitlist_entry", "already_redeemed"],
      ["expire_new_client_waitlist_invitation", "already_redeemed"],
      ["requeue_new_client_waitlist_entry", "not_requeueable"],
    ] as const) {
      const r = await adminQuery(`select public.${cmd}($1,$2,$3) as r`, [f.studioId, f.entryId, f.userId]);
      expect(r.rows[0].r, cmd).toBe(expected);
    }
    expect(
      (
        await adminQuery(
          `select count(*)::int n from public.new_client_waitlist_invitations
            where entry_id=$1 and redeemed_at is not null`,
          [f.entryId],
        )
      ).rows[0].n,
    ).toBe(1);
  });
});

// =============================================================================
// THE TEMPORAL EDGES — one executable proof per serialization boundary.
//
// Every test below is registered to a row in tests/db/helpers/temporal-edges.ts
// through `edgeTitle`, and the closure guard in
// tests/migrations/0189-waitlist-invitation-wall-clock-expiry.test.ts fails if
// an edge has no implementing test, or if that test does not carry the evidence
// its proof kind demands. Deleting one of these does not quietly reduce
// coverage; it turns the matrix red.
//
// THREE MECHANISMS, AND THEY ARE NOT INTERCHANGEABLE.
//   * Both commands touch a row that already exists in a state the successor
//     accepts -> the successor can be PARKED on the predecessor's lock.
//   * The predecessor INSERTS the row -> nothing to park on; it is invisible.
//   * The successor's own predicate excludes the pre-commit row version -> it
//     matches zero rows and never reaches a lock.
// The manifest names which one each edge requires, and every one of them was
// MEASURED here rather than reasoned about: the REQUEUE edges were written as
// executed races first, and the database refused to produce that schedule.
//
// Each test closes its own connections in `finally`. A leaked open transaction
// does not merely fail its own case — it holds locks that later fixtures need
// for `ALTER TABLE ... DISABLE TRIGGER`, and one failure becomes a cascade of
// unrelated timeouts.
// =============================================================================

// ---------------------------------------------------------------------------
// DRIVERS. Setup only — each test performs and asserts its own schedule, so the
// blocking proof and the ordering assertions stay visible where they matter.
// ---------------------------------------------------------------------------

/** A JOIN that has not committed: the row exists for the joiner and nobody else. */
async function uncommittedJoin(label: string) {
  const s = await bareStudio(label);
  const joiner = await conn();
  await joiner.query("begin");
  const e = (
    await joiner.query(`select entry_id from public.join_new_client_waitlist($1,$2,$3,null)`, [
      s.studioId,
      `P ${s.uniq}`,
      `p-${randomUUID().slice(0, 8)}@harness.local`,
    ])
  ).rows[0].entry_id as string;
  return { s, e, joiner };
}

/** A terminal transition performed and HELD inside its own open transaction. */
async function heldTerminal(label: string, terminal: "release" | "expire") {
  const f =
    terminal === "release" ? await issueExpiringIn(label, 300) : await issueAlreadyElapsed(label);
  const a = await conn();
  await a.query("begin");
  const code = (
    terminal === "release"
      ? await a.query(`select public.release_new_client_waitlist_entry($1,$2,$3) as r`, [
          f.studioId,
          f.entryId,
          f.userId,
        ])
      : await a.query(`select public.expire_new_client_waitlist_invitation($1,$2,$3) as r`, [
          f.studioId,
          f.entryId,
          f.userId,
        ])
  ).rows[0].r as string;
  expect(code).toBe(terminal === "release" ? "released" : "expired");
  return { f, a };
}

/** REQUEUE, run from a session that cannot see the uncommitted terminal state. */
const blindRequeue = async (f: Fixture) =>
  (
    await adminQuery(`select public.requeue_new_client_waitlist_entry($1,$2,$3) as r`, [
      f.studioId,
      f.entryId,
      f.userId,
    ])
  ).rows[0].r as string;

/** A predecessor holding the entry, with REMOVE started and waiting behind it.
 *  The event-id snapshot is taken BEFORE the predecessor runs, so both the
 *  predecessor's event and the removal's can be identified by set difference. */
async function removeParkedBehind(label: string, terminal: "release" | "expire" | "requeue") {
  const f = terminal === "expire" ? await issueAlreadyElapsed(label) : await issueExpiringIn(label, 300);
  if (terminal === "requeue") {
    // REQUEUE only acts on an entry that has already left the active set.
    expect(
      (
        await adminQuery(`select public.release_new_client_waitlist_entry($1,$2,$3) as r`, [
          f.studioId,
          f.entryId,
          f.userId,
        ])
      ).rows[0].r,
    ).toBe("released");
  }
  const before = await eventIdSet(f.entryId);

  const a = await conn();
  await a.query("begin");
  const sql =
    terminal === "release"
      ? `select public.release_new_client_waitlist_entry($1,$2,$3) as r`
      : terminal === "expire"
        ? `select public.expire_new_client_waitlist_invitation($1,$2,$3) as r`
        : `select public.requeue_new_client_waitlist_entry($1,$2,$3) as r`;
  expect((await a.query(sql, [f.studioId, f.entryId, f.userId])).rows[0].r).toBe(
    terminal === "release" ? "released" : terminal === "expire" ? "expired" : "requeued",
  );

  const b = await conn();
  await b.query("begin");
  const pid = (await b.query(`select pg_backend_pid() as pid`)).rows[0].pid as number;
  const pending = b.query(`select public.remove_new_client_waitlist_entry($1,$2,$3) as r`, [
    f.studioId,
    f.entryId,
    f.userId,
  ]);
  return { f, a, b, pid, pending, before };
}

type RemoveRace = Awaited<ReturnType<typeof removeParkedBehind>>;

/** Let the removal finish and identify BOTH events by the ids they appended —
 *  never by their timestamps. The predecessor's release is deliberately NOT done
 *  here: it is the decisive moment of the schedule, so each test performs it
 *  itself, in the scope the closure guard inspects. */
async function collectRemoveRace(h: RemoveRace, prevFrom: string, prevTo: string) {
  expect((await h.pending).rows[0].r, "remove lost its deployed vocabulary").toBe("removed");
  await h.b.query("commit");

  const fresh = await newEventsSince(h.f.entryId, h.before);
  const prev = pickEvent(fresh, prevFrom, prevTo);
  const removed = pickEvent(fresh, prevTo, "removed");
  const ent = (
    await adminQuery(`select removed_at from public.new_client_waitlist_entries where id = $1`, [
      h.f.entryId,
    ])
  ).rows[0] as { removed_at: Date };
  // The predecessor's stamp as microsecond text, captured the moment it is
  // identified, so "it did not move" is checked at stored precision later.
  const prevStamp = await readStoredInstant(
    `select occurred_at from ${EV_T} where id = $1`,
    [prev.id],
  );
  return { prev, removed, removedAt: ent.removed_at, prevStamp };
}

const closeAll = async (...cs: Array<{ end: () => Promise<void> }>) => {
  for (const c of cs) await c.end().catch(() => undefined);
};

describe("temporal edge — JOIN is ordered by row visibility, not by contention", () => {
  it("JOIN->CLAIM — an uncommitted join is invisible to the claimer, and the claim that follows is ordered", async () => {
      const { s, e, joiner } = await uncommittedJoin("edge-jc");
      try {
        // Nothing to park on, because there is nothing to see.
        await expectInvisibleWhileUncommitted(e, "the joining transaction is still open");
        const blind = (
          await adminQuery(`select public.claim_new_client_waitlist_entry($1,$2,$3) as r`, [
            s.studioId,
            e,
            s.userId,
          ])
        ).rows[0].r as string;
        expect(blind, "a claim acted on an entry whose JOIN had not committed").toBe("not_found");
        await joiner.query("commit");
      } finally {
        await closeAll(joiner);
      }

      expect(
        (
          await adminQuery(`select public.claim_new_client_waitlist_entry($1,$2,$3) as r`, [
            s.studioId,
            e,
            s.userId,
          ])
        ).rows[0].r,
      ).toBe("claimed");
      await expectPostgresOrdered(
        { sql: `select claimed_at, joined_at from public.new_client_waitlist_entries where id = $1`, params: [e] },
        "claimed_at predates the join it followed",
      );

      const chain = await eventsAlongTransitionChain(e);
      await expectChainChronological(
        chain.map((x) => x.id),
        "the append-only log runs backwards",
      );
      await expectEventIsEntryStamp(
        chain[chain.length - 1].id,
        e,
        "claimed_at",
        "the claim event and the entry stamp are different instants",
      );
    });

  it("JOIN->REMOVE — an uncommitted join cannot be removed, and the removal that follows is ordered", async () => {
      const { s, e, joiner } = await uncommittedJoin("edge-jr");
      try {
        await expectInvisibleWhileUncommitted(e, "the joining transaction is still open");
        const blind = (
          await adminQuery(`select public.remove_new_client_waitlist_entry($1,$2,$3) as r`, [
            s.studioId,
            e,
            s.userId,
          ])
        ).rows[0].r as string;
        expect(blind, "a removal acted on an entry whose JOIN had not committed").toBe("not_found");
        await joiner.query("commit");
      } finally {
        await closeAll(joiner);
      }

      expect(
        (
          await adminQuery(`select public.remove_new_client_waitlist_entry($1,$2,$3) as r`, [
            s.studioId,
            e,
            s.userId,
          ])
        ).rows[0].r,
      ).toBe("removed");
      await expectPostgresOrdered(
        { sql: `select removed_at, joined_at from public.new_client_waitlist_entries where id = $1`, params: [e] },
        "removed_at predates the join it followed",
      );

      const chain = await eventsAlongTransitionChain(e);
      await expectChainChronological(
        chain.map((x) => x.id),
        "the append-only log runs backwards",
      );
      await expectEventIsEntryStamp(
        chain[chain.length - 1].id,
        e,
        "removed_at",
        "the removal event and the entry stamp are different instants",
      );
    });
});
describe("temporal edge — CLAIM -> INVITE parks on the entry mutex", () => {
  it("CLAIM->INVITE — issue parks on the entry row the claim holds, and is stamped after it", async () => {
      const s = await bareStudio("edge-ci");
      const e = await joinEntry(s);

      const claimer = await conn();
      const inviter = await conn();
      try {
        // TX-CLAIM takes the entry mutex and KEEPS it.
        await claimer.query("begin");
        expect(
          (
            await claimer.query(`select public.claim_new_client_waitlist_entry($1,$2,$3) as r`, [
              s.studioId,
              e,
              s.userId,
            ])
          ).rows[0].r,
        ).toBe("claimed");

        // ISSUE begins while that lock is held, and must park on it.
        await inviter.query("begin");
        const pid = (await inviter.query(`select pg_backend_pid() as pid`)).rows[0].pid as number;
        const pending = inviter.query(
          `select result from public.issue_new_client_waitlist_invitation($1,$2,$3,72)`,
          [s.studioId, e, s.userId],
        );
        await expectBlockedOn(pid, "issue never parked on the entry mutex the claim holds");

        // Only NOW is the predecessor released.
        await sleep(HOLD_MS);
        await claimer.query("commit");

        expect((await pending).rows[0].result, "issue lost its deployed vocabulary").toBe("invited");
        await inviter.query("commit");
      } finally {
        await claimer.end().catch(() => undefined);
        await inviter.end().catch(() => undefined);
      }

      await expectPostgresOrdered(
        { sql: `select invited_at, claimed_at from public.new_client_waitlist_entries where id = $1`, params: [e] },
        "invited_at predates the claim it waited for",
      );

      const rows = await eventsAlongTransitionChain(e);
      await expectChainChronological(
        rows.map((x) => x.id),
        "the append-only log runs backwards",
      );
      await expectEventIsEntryStamp(
        rows.find((x) => x.to_status === "invited")!.id,
        e,
        "invited_at",
        "the invited event and the entry stamp are different instants",
      );

      // The structural law the whole identity model rests on still holds.
      expect(
        (
          await adminQuery(
            `select count(*)::int as c from public.new_client_waitlist_invitations
              where entry_id = $1 and redeemed_at is null and expired_at is null and released_at is null`,
            [e],
          )
        ).rows[0].c,
        "the parked issue produced a second live invitation",
      ).toBe(1);
    });
});

describe("temporal edge — REQUEUE is excluded by its own predicate, not parked by a lock", () => {
  // WHAT WAS MEASURED. These two edges were written first as executed races, on
  // the reasoning that REQUEUE's UPDATE would take a row lock like any other
  // writer. It does not. While the terminal transition is uncommitted, every
  // other session still sees `invited`, REQUEUE's
  // `status in ('released','expired')` predicate matches zero rows, and the
  // statement returns `not_requeueable` WITHOUT EVER WAITING. Asserting a lock
  // wait here would have asserted a schedule PostgreSQL does not produce.
  //
  // The temporal claim survives in a stronger form: the successor cannot act
  // early because it cannot see the state that authorises it, and when it can
  // see that state, what it writes follows it.
  it("RELEASE->REQUEUE — requeue cannot see the uncommitted release, refuses it, and follows it once committed", async () => {
      const { f, a } = await heldTerminal("rq-release", "release");
      try {
        await expectStillSees(f.entryId, "invited", "the release is still uncommitted");
        expect(await blindRequeue(f), "requeue acted on an entry whose release had not committed").toBe("not_requeueable");
        expect(await entryStatus(f.entryId), "the refused requeue wrote something").toBe("invited");
        await a.query("commit");
      } finally {
        await closeAll(a);
      }

      // Visible now: requeue acts, and its event is identified by the id it
      // appended — this entry reaches `waiting` twice, so nothing else could.
      const before = await eventIdSet(f.entryId);
      expect(await blindRequeue(f), "requeue lost its deployed vocabulary").toBe("requeued");
      const requeued = await expectExactlyOneNewEvent(f.entryId, before, "released", "waiting");
      // Event identity still comes from the captured id and the unique terminal
      // status — never from a timestamp. PostgreSQL then compares the two
      // stored occurred_at values.
      await soleEventAt(f.entryId, "released");
      await expectPostgresOrdered(
        {
          sql: `select r.occurred_at, t.occurred_at from public.new_client_waitlist_entry_events r, public.new_client_waitlist_entry_events t
                  where r.id = $1 and t.entry_id = $2 and t.to_status = 'released'`,
          params: [requeued.id, f.entryId],
        },
        "the requeue event predates the release it followed",
      );
      expect(await entryStatus(f.entryId)).toBe("waiting");

      // Requeue clears the entry's cycle columns, so the INVITATION's stamp is
      // the surviving evidence of the cycle that ended. History is not rewritten.
      const st = await stateOf(f.invId);
      expect(st.released_at, "the release stamp was erased from the invitation").not.toBeNull();
      await expectPostgresOrdered(
        {
          sql: `select ev.occurred_at, i.released_at from public.new_client_waitlist_entry_events ev, public.new_client_waitlist_invitations i
                  where ev.id = $1 and i.id = $2`,
          params: [requeued.id, f.invId],
        },
        "the requeue event predates the invitation's release stamp",
      );
    });

  it("EXPIRE->REQUEUE — requeue cannot see the uncommitted expire, refuses it, and follows it once committed", async () => {
      const { f, a } = await heldTerminal("rq-expire", "expire");
      try {
        await expectStillSees(f.entryId, "invited", "the expire is still uncommitted");
        expect(await blindRequeue(f), "requeue acted on an entry whose expire had not committed").toBe("not_requeueable");
        expect(await entryStatus(f.entryId), "the refused requeue wrote something").toBe("invited");
        await a.query("commit");
      } finally {
        await closeAll(a);
      }

      const before = await eventIdSet(f.entryId);
      expect(await blindRequeue(f), "requeue lost its deployed vocabulary").toBe("requeued");
      const requeued = await expectExactlyOneNewEvent(f.entryId, before, "expired", "waiting");
      // Event identity still comes from the captured id and the unique terminal
      // status — never from a timestamp. PostgreSQL then compares the two
      // stored occurred_at values.
      await soleEventAt(f.entryId, "expired");
      await expectPostgresOrdered(
        {
          sql: `select r.occurred_at, t.occurred_at from public.new_client_waitlist_entry_events r, public.new_client_waitlist_entry_events t
                  where r.id = $1 and t.entry_id = $2 and t.to_status = 'expired'`,
          params: [requeued.id, f.entryId],
        },
        "the requeue event predates the expire it followed",
      );
      expect(await entryStatus(f.entryId)).toBe("waiting");

      const st = await stateOf(f.invId);
      expect(st.expired_at, "the expire stamp was erased from the invitation").not.toBeNull();
      await expectPostgresOrdered(
        {
          sql: `select ev.occurred_at, i.expired_at from public.new_client_waitlist_entry_events ev, public.new_client_waitlist_invitations i
                  where ev.id = $1 and i.id = $2`,
          params: [requeued.id, f.invId],
        },
        "the requeue event predates the invitation's expire stamp",
      );
    });
});

describe("temporal edge — REMOVE parks on the entry mutex, whatever it follows", () => {
  // "WAITING/RELEASED/EXPIRED -> REMOVE" is three source states reached by three
  // different commands, and one label cannot certify three mechanisms — so each
  // predecessor is exercised on its own. (The fourth route to `waiting`, a fresh
  // JOIN, is a visibility edge rather than a lock edge and is proven above.)
  //
  // REMOVE locks by identity alone — `where e.id = … for update`, with no status
  // predicate — which is exactly why it DOES park where REQUEUE does not.
  it("RELEASE->REMOVE — remove parks on the entry mutex the release holds, and is stamped after it", async () => {
      const h = await removeParkedBehind("rm-release", "release");
      try {
        await expectBlockedOn(h.pid, "remove never parked on the entry mutex the release holds");
        await sleep(HOLD_MS);
        await h.a.query("commit");
        const out = await collectRemoveRace(h, "invited", "released");
        await expectPostgresOrdered(
          {
            sql: `select en.removed_at, ev.occurred_at from public.new_client_waitlist_entries en, public.new_client_waitlist_entry_events ev
                    where en.id = $1 and ev.id = $2`,
            params: [h.f.entryId, out.prev.id],
          },
          "removed_at predates the release it waited for",
        );
        await expectEventIsEntryStamp(
          out.removed.id,
          h.f.entryId,
          "removed_at",
          "the removal event and the entry stamp are different instants",
        );
        expect(
          await readStoredInstant(`select occurred_at from ${EV_T} where id = $1`, [out.prev.id]),
          "the released event moved while remove ran",
        ).toBe(out.prevStamp);
      } finally {
        await closeAll(h.a, h.b);
      }
    });

  it("EXPIRE->REMOVE — remove parks on the entry mutex the expire holds, and is stamped after it", async () => {
      const h = await removeParkedBehind("rm-expire", "expire");
      try {
        await expectBlockedOn(h.pid, "remove never parked on the entry mutex the expire holds");
        await sleep(HOLD_MS);
        await h.a.query("commit");
        const out = await collectRemoveRace(h, "invited", "expired");
        await expectPostgresOrdered(
          {
            sql: `select en.removed_at, ev.occurred_at from public.new_client_waitlist_entries en, public.new_client_waitlist_entry_events ev
                    where en.id = $1 and ev.id = $2`,
            params: [h.f.entryId, out.prev.id],
          },
          "removed_at predates the expire it waited for",
        );
        await expectEventIsEntryStamp(
          out.removed.id,
          h.f.entryId,
          "removed_at",
          "the removal event and the entry stamp are different instants",
        );
        expect(
          await readStoredInstant(`select occurred_at from ${EV_T} where id = $1`, [out.prev.id]),
          "the expired event moved while remove ran",
        ).toBe(out.prevStamp);
      } finally {
        await closeAll(h.a, h.b);
      }
    });

  it("REQUEUE->REMOVE — remove parks on the entry mutex the requeue holds, and is stamped after it", async () => {
      // This entry reaches `waiting` twice, so the predecessor event is picked
      // out of the ids that appeared since the snapshot — never by timestamp.
      const h = await removeParkedBehind("rm-requeue", "requeue");
      try {
        await expectBlockedOn(h.pid, "remove never parked on the entry mutex the requeue holds");
        await sleep(HOLD_MS);
        await h.a.query("commit");
        const out = await collectRemoveRace(h, "released", "waiting");
        await expectPostgresOrdered(
          {
            sql: `select en.removed_at, ev.occurred_at from public.new_client_waitlist_entries en, public.new_client_waitlist_entry_events ev
                    where en.id = $1 and ev.id = $2`,
            params: [h.f.entryId, out.prev.id],
          },
          "removed_at predates the requeue it waited for",
        );
        await expectEventIsEntryStamp(
          out.removed.id,
          h.f.entryId,
          "removed_at",
          "the removal event and the entry stamp are different instants",
        );
        expect(
          await readStoredInstant(`select occurred_at from ${EV_T} where id = $1`, [out.prev.id]),
          "the requeue event moved while remove ran",
        ).toBe(out.prevStamp);
      } finally {
        await closeAll(h.a, h.b);
      }
    });
});

// =============================================================================
// REPEATED LIFECYCLE CYCLES — chronology against an OPAQUE causal sequence.
//
// An entry may go round the loop more than once, and that is where reconstructing
// order from the transition labels stops working: the second `waiting -> claimed`
// is indistinguishable from the first.
//
// WHAT WAS TRIED AND REJECTED. First, sorting the repeats by `occurred_at` —
// circular, and demonstrably able to hide an inversion
// (tests/lib/waitlist-event-order.test.ts executes that history). Then, a guard
// that banned the spellings of the helpers which did it. Review was right that
// the blacklist was not the invariant: an in-memory sort, a `reduce` picking the
// minimum, and a composed `order by ${col}` all pass it, and all three reproduce
// as vacuous green proofs.
//
// `occurred_at` is not the problem — validating it is the entire point. The
// invariant is that it must never CONSTRUCT the order it is validated against.
// So the sequence is owned by ObservedLifecycleSequence, whose event list is
// private and can only be appended to by capturing one controlled transition and
// taking the event id that is new. A caller cannot hand it an array.
//
// NOTE WHAT IS *NOT* CLAIMED. The database stores no sequence — `id` is a random
// uuid and there is no ordinal — and nothing here adds one. The ordering is the
// HARNESS's knowledge of what it executed.
// =============================================================================

// =============================================================================
// REPEATED LIFECYCLE CYCLES.
//
// An entry may go round the loop more than once, and that is where reading the
// order out of the rows stops working: the second `waiting -> claimed` looks
// exactly like the first, and the table has no ordinal — `id` is a random uuid.
// Ordering them by `occurred_at` would use the timestamps to decide the sequence
// the timestamps are then checked against, which can hide a real inversion.
//
// So each test below records the order ITSELF. It performs one lifecycle
// operation at a time, and after each one takes the event id that is new. The
// resulting list is in execution order because the test executed it, and only
// then are the timestamps compared along it.
// =============================================================================

/** One controlled transition: snapshot, act, and take the event that appeared. */
async function captureStep(
  entryId: string,
  from: string | null,
  to: string,
  run: () => Promise<void>,
): Promise<ObservedEvent> {
  const before = await eventIdSet(entryId);
  await run();
  return expectExactlyOneNewEvent(entryId, before, from, to);
}

describe("repeated cycles — the log never runs backwards across two full loops", () => {
  for (const terminal of ["release", "expire"] as const) {
    const terminalStatus = terminal === "release" ? "released" : "expired";

    it(`two complete claim, invite, ${terminal} and requeue cycles stay chronological`, async () => {
      const s = await bareStudio(`cyc-${terminal}`);
      const e = await joinEntry(s);

      // The order of this list is the order the test performed the operations.
      const observedEvents: ObservedEvent[] = [];
      observedEvents.push(
        await expectExactlyOneNewEvent(e, new Set<string>(), null, "waiting"),
      );

      for (let round = 1; round <= 2; round += 1) {
        observedEvents.push(
          await captureStep(e, "waiting", "claimed", async () => {
            expect(
              (
                await adminQuery(`select public.claim_new_client_waitlist_entry($1,$2,$3) as r`, [
                  s.studioId,
                  e,
                  s.userId,
                ])
              ).rows[0].r,
              `cycle ${round} claim`,
            ).toBe("claimed");
          }),
        );

        observedEvents.push(
          await captureStep(e, "claimed", "invited", async () => {
            expect(
              (
                await adminQuery(
                  `select result from public.issue_new_client_waitlist_invitation($1,$2,$3,72)`,
                  [s.studioId, e, s.userId],
                )
              ).rows[0].result,
              `cycle ${round} issue`,
            ).toBe("invited");
          }),
        );

        observedEvents.push(
          await captureStep(e, "invited", terminalStatus, async () => {
            if (terminal === "expire") {
              // Bring the deadline forward and PROVE the server clock passed it,
              // rather than assuming elapsed wall time.
              await waitPastDeadline(await restampExpiry((await liveIdOf(e))!, 1));
            }
            const sql =
              terminal === "release"
                ? `select public.release_new_client_waitlist_entry($1,$2,$3) as r`
                : `select public.expire_new_client_waitlist_invitation($1,$2,$3) as r`;
            expect(
              (await adminQuery(sql, [s.studioId, e, s.userId])).rows[0].r,
              `cycle ${round} ${terminal}`,
            ).toBe(terminalStatus);
          }),
        );

        observedEvents.push(
          await captureStep(e, terminalStatus, "waiting", async () => {
            expect(
              (
                await adminQuery(`select public.requeue_new_client_waitlist_entry($1,$2,$3) as r`, [
                  s.studioId,
                  e,
                  s.userId,
                ])
              ).rows[0].r,
              `cycle ${round} requeue`,
            ).toBe("requeued");
          }),
        );
      }

      // Two full loops plus the join.
      expect(observedEvents).toHaveLength(9);
      expect(new Set(observedEvents.map((x) => x.id)).size, "an event was counted twice").toBe(9);
      expect(observedEvents.map((x) => x.to_status)).toEqual([
        "waiting",
        "claimed",
        "invited",
        terminalStatus,
        "waiting",
        "claimed",
        "invited",
        terminalStatus,
        "waiting",
      ]);

      // Chronology along the order the test executed. The ids are the only
      // thing carried out of the database; PostgreSQL re-reads the stamps and
      // counts the inversions itself, at stored precision.
      const chainIds = observedEvents.map((x) => x.id);
      await expectChainChronological(
        chainIds,
        `the repeated ${terminalStatus} cycle is out of order: ` +
        observedEvents.map((x) => `${x.from_status}->${x.to_status}`).join(", "),
      );
      // NON-VACUITY. The same nine ids in reverse must be rejected, so a green
      // assertion above means the inversion counter ran, not that it found
      // nothing to count.
      await expect(
        expectChainChronological([...chainIds].reverse(), "control"),
        "the chronology check accepts a reversed chain",
      ).rejects.toThrow(/runs backwards/i);
    });
  }

  it("a repeated history cannot be linearized from its transition labels alone", () => {
    // Why the tests above capture identity as they go: the label chain admits
    // several orderings once a transition repeats, so the helper refuses rather
    // than guessing. No database needed.
    const labels = [
      [null, "waiting"],
      ["waiting", "claimed"],
      ["claimed", "invited"],
      ["invited", "released"],
      ["released", "waiting"],
      ["waiting", "claimed"],
      ["claimed", "invited"],
      ["invited", "released"],
      ["released", "waiting"],
    ] as const;
    const attempt = linearizeByTransitionChain(
      labels.map(([from, to], i) => ({
        from_status: from,
        to_status: to,
        occurred_at: new Date(1_700_000_000_000 + i * 1000),
      })),
    );
    expect(attempt.ok, "a two-cycle history must not be linearizable from labels").toBe(false);
    if (!attempt.ok) expect(attempt.reason).toBe("ambiguous");
  });
});

// =============================================================================
// THE HELPER ITSELF — chronology must be decided at PostgreSQL precision.
//
// Every chronology verdict in this file rests on expectPostgresOrdered, so the
// helper needs its own regression test. The defect it replaced was invisible by
// inspection: node-postgres converts `timestamptz` to a JS `Date` before any
// assertion runs, and PostgreSQL stores MICROSECONDS while `Date` stores
// milliseconds — so a real sub-millisecond inversion arrived as equality and a
// zero-tolerance comparison passed.
// =============================================================================

describe("stored chronology is judged by PostgreSQL, not by JS Date", () => {
  // 300us apart, successor FIRST: a genuine inversion that shares one JS
  // millisecond. Fixed literals, so this proves the same thing on every host.
  const INVERTED = `select timestamptz '2026-01-01 00:00:00.500300+00',
                           timestamptz '2026-01-01 00:00:00.500600+00'`;
  const ORDERED = `select timestamptz '2026-01-01 00:00:00.500600+00',
                          timestamptz '2026-01-01 00:00:00.500300+00'`;

  it("NEGATIVE CONTROL: the JS-Date comparison this replaced would have passed", async () => {
    const r = await adminQuery(
      `select s, p, s >= p as pg_ordered,
              round(extract(epoch from (s - p)) * 1000000)::bigint as delta_us
         from (${INVERTED}) as t(s, p)`,
    );
    const row = r.rows[0] as { s: Date; p: Date; pg_ordered: boolean; delta_us: string };

    // PostgreSQL sees the inversion.
    expect(row.pg_ordered, "the fixture is supposed to be inverted").toBe(false);
    expect(Number(row.delta_us), "the inversion should be sub-millisecond").toBe(-300);

    // JavaScript cannot: both timestamps collapse into the same millisecond, so
    // the retired `predecessor.getTime() - successor.getTime() <= 0` check
    // yielded 0 and PASSED on this very row.
    expect(row.s.getTime(), "the two stamps must share one JS millisecond").toBe(
      row.p.getTime(),
    );
    expect(row.p.getTime() - row.s.getTime()).toBe(0);
  });

  it("rejects a sub-millisecond inversion that JS Date cannot see", async () => {
    await expect(
      expectPostgresOrdered({ sql: INVERTED }, "control"),
    ).rejects.toThrow(/-300us|EARLIER/);
  });

  it("accepts a correctly ordered pair", async () => {
    await expectPostgresOrdered({ sql: ORDERED }, "a correctly ordered pair must pass");
  });

  // The same 300us gap, asked as an EQUALITY question. Two stamps this close
  // are the same JS millisecond, so `a.getTime() === b.getTime()` calls them one
  // instant; PostgreSQL does not. Ordering and equality fail differently and
  // each needs its own control.
  const NEAR = `select timestamptz '2026-01-01 00:00:00.500600+00',
                       timestamptz '2026-01-01 00:00:00.500300+00'`;
  const SAME = `select timestamptz '2026-01-01 00:00:00.500600+00',
                       timestamptz '2026-01-01 00:00:00.500600+00'`;

  it("NEGATIVE CONTROL: the JS-Date equality this replaced would have passed", async () => {
    const r = await adminQuery(
      `select l, r, l = r as pg_same,
              round(extract(epoch from (l - r)) * 1000000)::bigint as delta_us
         from (${NEAR}) as t(l, r)`,
    );
    const row = r.rows[0] as { l: Date; r: Date; pg_same: boolean; delta_us: string };

    // PostgreSQL sees two different instants.
    expect(row.pg_same, "the fixture is supposed to be two distinct instants").toBe(false);
    expect(Number(row.delta_us), "the gap should be sub-millisecond").toBe(300);

    // JavaScript cannot: the retired `a.getTime() === b.getTime()` equality
    // returned true on this very pair, so a stamp copied 300us late — an event
    // re-reading the clock instead of carrying the transition's instant —
    // passed as "the same instant".
    expect(row.l.getTime(), "the two stamps must share one JS millisecond").toBe(
      row.r.getTime(),
    );
  });

  it("rejects a sub-millisecond difference that JS Date calls equal", async () => {
    await expect(
      expectPostgresSameInstant({ sql: NEAR }, "control"),
    ).rejects.toThrow(/300us|not one instant|holds/i);
  });

  it("accepts two genuinely identical instants", async () => {
    await expectPostgresSameInstant({ sql: SAME }, "an identical pair must pass");
  });
});
