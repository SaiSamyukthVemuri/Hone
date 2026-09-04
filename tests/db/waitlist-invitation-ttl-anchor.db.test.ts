import { afterAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { adminQuery, closePool, resolveLocalDbUrl } from "./helpers/harness";
import {
  expectPostgresOrdered,
  expectPostgresSameInstant,
  waitUntilBlocked,
} from "./helpers/waitlist-concurrency";

// 0190 — THE REQUESTED TTL MUST START WHEN THE INVITATION IS ISSUED.
//
// THE DEFECT THIS FILE EXISTS TO KEEP CLOSED. `issue_new_client_waitlist_invitation`
// took the entry mutex and read a post-lock instant for the ENTRY's invited_at,
// but computed the invitation's window as `now() + ttl`. `now()` is
// transaction-start, so the window was shortened by however long the issuing
// transaction had already been alive — while redemption, repaired by 0189,
// compares against the current post-lock wall clock. The 0188 BEFORE INSERT
// trigger then overwrote issued_at with the SAME stale now(), so the stored row
// was internally consistent and nothing looked wrong.
//
// Measured before the repair, at PostgreSQL microsecond precision, with the
// RPC's minimum TTL of one hour: a transaction aged 3s lost 3 021 461us of its
// window, and one that parked on the entry mutex for 3s lost 3 122 452us. In
// both cases the shortfall was not approximately the transaction's age — it was
// the transaction's age, exactly.
//
// EVERY TEMPORAL VERDICT HERE IS POSTGRESQL'S. node-postgres truncates
// timestamptz microseconds to JS milliseconds, so instants that must be carried
// across a round trip are carried as microsecond TEXT and compared in the
// database.

const INV_T = "public.new_client_waitlist_invitations";
const EN_T = "public.new_client_waitlist_entries";

/** The RPC's MINIMUM accepted TTL. `v_ttl < 1` is refused, so one hour is the
 *  shortest window this test can ask for. */
const MIN_TTL_HOURS = 1;

/** How long each case ages its transaction before issuing. Must be material
 *  enough that a lost window would be unmistakable against the TTL. */
const AGE_MS = 2500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function conn(): Promise<Client> {
  const c = new Client({ connectionString: resolveLocalDbUrl() });
  await c.connect();
  return c;
}

async function seedClaimed(label: string) {
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
  const j = await adminQuery(
    `select entry_id from public.join_new_client_waitlist($1,$2,$3,null)`,
    [studioId, `P ${uniq}`, `p-${uniq}@harness.local`],
  );
  const entryId = j.rows[0].entry_id as string;
  await adminQuery(`select public.claim_new_client_waitlist_entry($1,$2,$3)`, [
    studioId,
    entryId,
    userId,
  ]);
  return { studioId, userId, entryId };
}

/**
 * The shortfall between the window a caller ASKED for and the window it
 * actually received, measured from the real serialized issuance instant.
 *
 * All arithmetic happens in PostgreSQL. `tx_age_us` is reported alongside so a
 * zero shortfall cannot be mistaken for "there was no age to lose".
 */
async function windowOf(entryId: string, txStartText: string, ttlHours: number) {
  const r = await adminQuery(
    `select (extract(epoch from (i.expires_at - i.issued_at)) * 1e6)::bigint            as window_us,
            (extract(epoch from make_interval(hours => $3::int)) * 1e6)::bigint         as requested_us,
            (extract(epoch from (make_interval(hours => $3::int)
                                 - (i.expires_at - i.issued_at))) * 1e6)::bigint        as shortfall_us,
            (extract(epoch from (i.issued_at - $2::timestamptz)) * 1e6)::bigint         as tx_age_us,
            i.expires_at = i.issued_at + make_interval(hours => $3::int)                as expiry_is_issuance_plus_ttl,
            i.issued_at > $2::timestamptz                                               as issued_after_tx_start
       from ${INV_T} i
      where i.entry_id = $1`,
    [entryId, txStartText, ttlHours],
  );
  expect(r.rows, "no invitation was issued").toHaveLength(1);
  return r.rows[0] as {
    window_us: string;
    requested_us: string;
    shortfall_us: string;
    tx_age_us: string;
    expiry_is_issuance_plus_ttl: boolean;
    issued_after_tx_start: boolean;
  };
}

/** The three stamps are ONE instant, compared by PostgreSQL. */
async function expectOneCanonicalInstant(entryId: string) {
  await expectPostgresSameInstant(
    {
      sql: `select i.issued_at, e.invited_at from ${INV_T} i join ${EN_T} e on e.id = i.entry_id
             where i.entry_id = $1`,
      params: [entryId],
    },
    "issued_at and invited_at are different instants — the command read the clock twice",
  );
  await expectPostgresSameInstant(
    {
      sql: `select i.expires_at, i.issued_at + make_interval(hours => $2::int) from ${INV_T} i
             where i.entry_id = $1`,
      params: [entryId, MIN_TTL_HOURS],
    },
    "expires_at is not exactly the issuance instant plus the requested TTL",
  );
}

afterAll(async () => {
  await closePool();
});

// ---------------------------------------------------------------------------
describe("A — an OLD transaction still gets the full window it asked for", () => {
  it("loses none of the TTL to the transaction's own age", async () => {
    const f = await seedClaimed("ttl-old");
    const c = await conn();
    try {
      await c.query("begin");
      // Microsecond TEXT. A JS Date here truncates to milliseconds and the
      // shortfall comparison would then be wrong by up to 999us.
      const txStart = await readStoredInstantOn(c, "transaction_timestamp()");
      await sleep(AGE_MS);

      const r = await c.query(
        `select result from public.issue_new_client_waitlist_invitation($1,$2,$3,$4)`,
        [f.studioId, f.entryId, f.userId, MIN_TTL_HOURS],
      );
      expect(r.rows[0].result).toBe("invited");
      await c.query("commit");

      const w = await windowOf(f.entryId, txStart, MIN_TTL_HOURS);
      // NON-VACUITY FIRST. A zero shortfall only means something if there really
      // was an age the old shape would have charged against the window.
      expect(
        Number(w.tx_age_us),
        "the transaction was not materially old — a zero shortfall proves nothing here",
      ).toBeGreaterThan(1_000_000);
      expect(w.issued_after_tx_start, "issued_at is still transaction-start").toBe(true);
      expect(
        Number(w.shortfall_us),
        `the caller lost ${w.shortfall_us}us of a ${w.requested_us}us window`,
      ).toBe(0);
      expect(w.expiry_is_issuance_plus_ttl).toBe(true);
      await expectOneCanonicalInstant(f.entryId);
    } finally {
      await c.end();
    }
  });
});

// ---------------------------------------------------------------------------
describe("B — a transaction that PARKS on the entry mutex keeps its full window", () => {
  it("charges the lock wait to nobody", async () => {
    const f = await seedClaimed("ttl-lock");
    const holder = await conn();
    const c = await conn();
    try {
      await holder.query("begin");
      await holder.query(`select 1 from ${EN_T} where id = $1 for update`, [f.entryId]);

      await c.query("begin");
      const txStart = await readStoredInstantOn(c, "transaction_timestamp()");
      const pid = (await c.query(`select pg_backend_pid() as pid`)).rows[0].pid as number;

      const pending = c.query(
        `select result from public.issue_new_client_waitlist_invitation($1,$2,$3,$4)`,
        [f.studioId, f.entryId, f.userId, MIN_TTL_HOURS],
      );
      // PROVE it is really parked on a lock, not merely slow.
      expect(
        await waitUntilBlocked(pid),
        "issue never blocked on the entry mutex — this case tests nothing",
      ).not.toBeNull();

      await sleep(AGE_MS);
      await holder.query("rollback");

      expect((await pending).rows[0].result).toBe("invited");
      await c.query("commit");

      const w = await windowOf(f.entryId, txStart, MIN_TTL_HOURS);
      expect(
        Number(w.tx_age_us),
        "the lock wait was not material — a zero shortfall proves nothing here",
      ).toBeGreaterThan(1_000_000);
      expect(
        Number(w.shortfall_us),
        `the lock wait cost the caller ${w.shortfall_us}us of window`,
      ).toBe(0);
      await expectOneCanonicalInstant(f.entryId);
    } finally {
      await holder.end().catch(() => undefined);
      await c.end().catch(() => undefined);
    }
  });
});

// ---------------------------------------------------------------------------
describe("C — NEGATIVE CONTROL: the pre-0190 computation loses exactly the age", () => {
  const OLD_FN = "zz_ttl_old_shape";

  it("the old `now() + ttl` shape shortens the window by the transaction's age", async () => {
    // Reconstructs the pre-repair arithmetic — the window anchored to
    // transaction start rather than to the post-lock issuance instant. If this
    // ever stops losing time, cases A and B prove nothing.
    await adminQuery(`
      create or replace function public.${OLD_FN}(p_ttl integer)
      returns table (anchored_at timestamptz, expires_at timestamptz)
      language plpgsql volatile set search_path = pg_catalog, pg_temp as $fn$
      begin
        return query select now(), now() + make_interval(hours => p_ttl);
      end; $fn$;`);
    try {
      const c = await conn();
      try {
        await c.query("begin");
        const txStart = await readStoredInstantOn(c, "transaction_timestamp()");
        await sleep(AGE_MS);
        const old = (
          await c.query(
            `select (extract(epoch from (o.expires_at - clock_timestamp())) * 1e6)::bigint as window_from_real_issuance_us,
                    (extract(epoch from make_interval(hours => $1::int)
                             - (o.expires_at - clock_timestamp())) * 1e6)::bigint          as shortfall_us,
                    (extract(epoch from (clock_timestamp() - $2::timestamptz)) * 1e6)::bigint as tx_age_us,
                    o.anchored_at = $2::timestamptz                                        as anchored_to_tx_start
               from public.${OLD_FN}($1::int) o`,
            [MIN_TTL_HOURS, txStart],
          )
        ).rows[0] as Record<string, string | boolean>;
        await c.query("rollback");

        expect(
          old.anchored_to_tx_start,
          "the control no longer anchors to transaction start — it is vacuous",
        ).toBe(true);
        expect(
          Number(old.shortfall_us),
          `the old shape lost only ${old.shortfall_us}us — the control is vacuous`,
        ).toBeGreaterThan(1_000_000);
      } finally {
        await c.end();
      }
    } finally {
      await adminQuery(`drop function if exists public.${OLD_FN}(integer)`);
    }
  });
});

// ---------------------------------------------------------------------------
describe("D — the token is usable inside its window and refused past it", () => {
  it("redeems immediately after issuance", async () => {
    const f = await seedClaimed("ttl-live");
    const r = await adminQuery(
      `select raw_token from public.issue_new_client_waitlist_invitation($1,$2,$3,$4)`,
      [f.studioId, f.entryId, f.userId, MIN_TTL_HOURS],
    );
    const token = r.rows[0].raw_token as string;
    expect(token).not.toBeNull();
    expect(
      (
        await adminQuery(`select result from public.redeem_new_client_waitlist_invitation($1)`, [
          token,
        ])
      ).rows[0].result,
    ).toBe("redeemed");
  });

  it("refuses once the SERVER's wall clock has truly passed expires_at", async () => {
    const f = await seedClaimed("ttl-past");
    const r = await adminQuery(
      `select raw_token from public.issue_new_client_waitlist_invitation($1,$2,$3,$4)`,
      [f.studioId, f.entryId, f.userId, MIN_TTL_HOURS],
    );
    const token = r.rows[0].raw_token as string;

    // Move the deadline into the past. expires_at is frozen by 0188's
    // append-only trigger, so this needs the table owner with that trigger
    // disabled — which is itself the proof that no application role could
    // manufacture or postpone an expiry.
    await adminQuery(
      `alter table ${INV_T} disable trigger new_client_waitlist_invitations_append_only`,
    );
    try {
      // `new_client_waitlist_invitations_ttl_check` requires
      // `expires_at > issued_at`, so the issue time moves back with the
      // deadline — the same shape the wall-clock suite's elapsed fixture uses.
      await adminQuery(
        `update ${INV_T}
            set issued_at  = clock_timestamp() - interval '4 days',
                expires_at = clock_timestamp() - interval '1 minute'
          where entry_id = $1`,
        [f.entryId],
      );
    } finally {
      await adminQuery(
        `alter table ${INV_T} enable trigger new_client_waitlist_invitations_append_only`,
      );
    }
    // POSTGRESQL confirms the clock really passed it before we assert refusal.
    expect(
      (
        await adminQuery(
          `select clock_timestamp() > i.expires_at as past from ${INV_T} i where i.entry_id = $1`,
          [f.entryId],
        )
      ).rows[0].past,
      "the wall clock has not actually passed the deadline",
    ).toBe(true);

    // `invalid_token`, not a distinct "expired" word: redemption deliberately
    // gives one refusal for an unknown token and an elapsed one, so a caller
    // holding a guess cannot use the answer as an oracle. The row is left
    // untouched — refusing is not a terminal outcome.
    expect(
      (
        await adminQuery(`select result from public.redeem_new_client_waitlist_invitation($1)`, [
          token,
        ])
      ).rows[0].result,
    ).toBe("invalid_token");
    expect(
      (await adminQuery(`select redeemed_at from ${INV_T} where entry_id = $1`, [f.entryId]))
        .rows[0].redeemed_at,
      "an elapsed token was still redeemed",
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("E — what 0190 did NOT change", () => {
  it("still refuses a second invitation, and one-live-per-entry still holds structurally", async () => {
    const f = await seedClaimed("ttl-one-live");
    expect(
      (
        await adminQuery(
          `select result from public.issue_new_client_waitlist_invitation($1,$2,$3,$4)`,
          [f.studioId, f.entryId, f.userId, MIN_TTL_HOURS],
        )
      ).rows[0].result,
    ).toBe("invited");
    // The command refuses at the STATUS gate, which the first issue moved to
    // `invited`; `already_invited` guards a racing caller that still sees
    // `claimed`, and is not reachable serially.
    expect(
      (
        await adminQuery(
          `select result from public.issue_new_client_waitlist_invitation($1,$2,$3,$4)`,
          [f.studioId, f.entryId, f.userId, MIN_TTL_HOURS],
        )
      ).rows[0].result,
    ).toBe("not_claimed");

    // The structural law underneath it is untouched: even the table owner
    // cannot store a second LIVE invitation for the same entry.
    await expect(
      adminQuery(
        `insert into ${INV_T} (studio_id, entry_id, token_hash, issued_at, expires_at, issued_by_practitioner_id)
         select $1, $2, encode(extensions.digest($3, 'sha256'), 'hex'),
                clock_timestamp(), clock_timestamp() + interval '1 hour', p.id
           from public.practitioners p where p.studio_id = $1 limit 1`,
        [f.studioId, f.entryId, randomUUID()],
      ),
      "a second live invitation was stored",
    ).rejects.toThrow(/one_live_per_entry/);
  });

  it("still refuses a TTL outside 1..168 hours, and never silently clamps", async () => {
    const f = await seedClaimed("ttl-range");
    for (const bad of [0, 169]) {
      expect(
        (
          await adminQuery(
            `select result from public.issue_new_client_waitlist_invitation($1,$2,$3,$4)`,
            [f.studioId, f.entryId, f.userId, bad],
          )
        ).rows[0].result,
        `ttl ${bad} was accepted`,
      ).toBe("invalid_ttl");
    }
    expect(
      (
        await adminQuery(`select count(*)::int n from ${INV_T} where entry_id = $1`, [f.entryId])
      ).rows[0].n,
      "a refused TTL still wrote an invitation",
    ).toBe(0);
  });

  it("keeps issued_at <= invited_at — now as exact equality", async () => {
    const f = await seedClaimed("ttl-order");
    await adminQuery(`select public.issue_new_client_waitlist_invitation($1,$2,$3,$4)`, [
      f.studioId,
      f.entryId,
      f.userId,
      MIN_TTL_HOURS,
    ]);
    await expectPostgresOrdered(
      {
        sql: `select e.invited_at, i.issued_at from ${EN_T} e join ${INV_T} i on i.entry_id = e.id
               where e.id = $1`,
        params: [f.entryId],
      },
      "invited_at precedes the issuance it followed",
    );
  });

  it("the timestamp trigger still refuses an issue time the transaction has not reached", async () => {
    // The guard 0190 preserved: a supplied instant may not be in the future.
    // Only the table owner can insert at all, so this is the one reachable way
    // to test it.
    const f = await seedClaimed("ttl-future");
    await adminQuery(
      `insert into ${INV_T} (studio_id, entry_id, token_hash, issued_at, expires_at, issued_by_practitioner_id)
       select $1, $2, encode(extensions.digest($3, 'sha256'), 'hex'),
              clock_timestamp() + interval '1 day',
              clock_timestamp() + interval '2 days',
              p.id
         from public.practitioners p where p.studio_id = $1 limit 1`,
      [f.studioId, f.entryId, randomUUID()],
    );
    expect(
      (
        await adminQuery(
          `select i.issued_at <= clock_timestamp() as clamped from ${INV_T} i where i.entry_id = $1`,
          [f.entryId],
        )
      ).rows[0].clamped,
      "a future-dated issued_at was stored — the server-time guard is gone",
    ).toBe(true);
  });
});

/** `transaction_timestamp()` / `clock_timestamp()` as microsecond TEXT, read on
 *  a SPECIFIC connection. readStoredInstant uses the admin pool, which is a
 *  different transaction and therefore a different clock story. */
async function readStoredInstantOn(c: Client, expr: string): Promise<string> {
  const r = await c.query(
    `select to_char(${expr}, 'YYYY-MM-DD"T"HH24:MI:SS.USOF') as t`,
  );
  return (r.rows[0] as { t: string }).t;
}
