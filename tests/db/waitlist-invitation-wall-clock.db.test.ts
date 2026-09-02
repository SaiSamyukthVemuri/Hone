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

  await adminQuery(
    `alter table public.new_client_waitlist_invitations disable trigger new_client_waitlist_invitations_append_only`,
  );
  const upd = await adminQuery(
    `update public.new_client_waitlist_invitations
        set expires_at = clock_timestamp() + make_interval(secs => $2)
      where entry_id = $1 and redeemed_at is null and expired_at is null and released_at is null
      returning id, expires_at`,
    [entryId, seconds],
  );
  await adminQuery(
    `alter table public.new_client_waitlist_invitations enable trigger new_client_waitlist_invitations_append_only`,
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
    ).toBeLessThan(f.expiresAt.getTime());

    // Fire the redemption WITHOUT awaiting it, then prove it is really blocked.
    const pending = b.query(
      `select result from public.redeem_new_client_waitlist_invitation($1)`,
      [f.token],
    );
    const ev = await waitUntilBlocked(t0.pid);
    expect(ev, "the redeeming backend never actually blocked on a lock").not.toBeNull();
    expect(ev).toContain("Lock");

    // The window closes WHILE it waits.
    const releasedAt = await waitPastDeadline(f.expiresAt);
    expect(releasedAt.getTime()).toBeGreaterThan(f.expiresAt.getTime());

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
    expect(t0.t.getTime()).toBeLessThan(f.expiresAt.getTime());

    const pending = b.query(
      `select public.expire_new_client_waitlist_invitation($1,$2,$3) as r`,
      [f.studioId, f.entryId, f.userId],
    );
    const ev = await waitUntilBlocked(t0.pid);
    expect(ev, "the expiring backend never actually blocked on the entry mutex").not.toBeNull();

    await waitPastDeadline(f.expiresAt);
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

    // A redemption begins while live and blocks behind the entry mutex holder.
    const a = await conn();
    await a.query("begin");
    await a.query(`select 1 from public.new_client_waitlist_invitations where id = $1 for update`, [
      f.invId,
    ]);

    const b = await conn();
    await b.query("begin");
    const t0 = (await b.query(`select transaction_timestamp() as t, pg_backend_pid() as pid`))
      .rows[0] as { t: Date; pid: number };
    expect(t0.t.getTime()).toBeLessThan(f.expiresAt.getTime());
    const redeeming = b.query(
      `select result from public.redeem_new_client_waitlist_invitation($1)`,
      [f.token],
    );
    expect(await waitUntilBlocked(t0.pid)).not.toBeNull();

    await waitPastDeadline(f.expiresAt);
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
