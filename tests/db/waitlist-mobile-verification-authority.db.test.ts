import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { adminQuery, adminTx, closePool, seedStudio, type SeededStudio } from "./helpers/harness";

// ===========================================================================
// 0203 — THE ONE WRITER, PROVEN BY BEHAVIOUR ON THE REAL DATABASE
// ===========================================================================
//
// WHY THIS FILE EXISTS. tests/migrations/0203-*.test.ts reads the SQL and proves
// things about its TEXT: that the guard differs from 0202's by exactly one
// region, that the region is the mobile_verified_at clause, that the outer
// condition is untouched. A review then showed the limit of that whole approach
// by naming a mutation it cannot see: insert `return new;` immediately after the
// unchanged outer condition and every text assertion still passes -- one diff
// region, correct position, all markers present, survivor equalities intact --
// while the raises below it become UNREACHABLE and any update may set
// mobile_verified_at.
//
// TEXT CANNOT PROVE REACHABILITY. Only running it can. So the properties that
// would actually hurt if they were wrong are asserted here against a real
// migrated Postgres:
//
//   1. AN UNPERMITTED UPDATE RAISES. The exception is reachable, not merely
//      present in the source.
//   2. A PERMIT FOR ROW A AUTHORIZES NOTHING OVER ROW B.
//   3. A PROVED INSTANT CANNOT MOVE AND CANNOT BE CLEARED.
//   4. THE COMMAND COMPARES THE STORED PHONE EXACTLY, and answers rather than
//      raising when it does not match.
//   5. EVERY RULE CARRIED FROM 0202 STILL RAISES -- `create or replace function`
//      drops silently, so this is the half that catches a forgotten rule.
//
// AND A MUTATION CONTROL PERFORMED FOR REAL: the `return new;` mutation above is
// applied inside a rolled-back transaction, and this suite proves it would be
// caught. A test that cannot fail is not evidence.
//
// ---------------------------------------------------------------------------
// WHY 0203 IS APPLIED BY THE TEST AND NOT BY THE HARNESS
// ---------------------------------------------------------------------------
//
// 0203 IS APPLIED TO PRODUCTION (2026-09-27) AND FROZEN. That changes nothing
// about how this suite runs, and the reason is worth stating: in CI the db lane
// runs `supabase db reset --local`, so the migration is present; on a developer
// machine the shared local database may still be at an older head, and resetting
// or migrating it would disturb whatever other worktrees are using it.
//
// So every test applies 0203's own bytes INSIDE A TRANSACTION AND ROLLS BACK.
// `create or replace function` is transactional in Postgres, so the previous
// definition is restored on rollback and the shared database is left exactly as
// it was found. That also makes the suite honest about what it tested: the file
// on disk, not whatever a database happened to have.

const ROOT = path.resolve(__dirname, "../..");
const SQL_0203 = readFileSync(
  path.join(ROOT, "supabase/migrations/0203_waitlist_mobile_verification_authority.sql"),
  "utf8",
);

/**
 * 0203's statements with its OWN TRANSACTION CONTROL REMOVED.
 *
 * THIS IS NOT COSMETIC, AND GETTING IT WRONG LEAKED INTO A SHARED DATABASE. The
 * migration opens with `begin;` and closes with `commit;`, as every migration in
 * this repository does. Executing the file verbatim inside the test's own
 * transaction COMMITS that transaction at the migration's `commit;` -- so the
 * rollback this file relies on never happened, 0203's guard and command were left
 * installed on the shared local database, and every row the tests verified kept
 * its `mobile_verified_at`. The suite passed the whole time, because committing
 * early is invisible to an assertion made after it.
 *
 * Stripping them makes the statements participate in the CALLER's transaction,
 * which is the only way `rolledBack` can mean anything.
 */
const GUARD_AND_COMMAND = SQL_0203.replace(/^\s*(begin|commit)\s*;\s*$/gim, "");

// A GUARD ON THE GUARD. If a future edit to 0203 writes its transaction control
// in a form this strip does not match, the leak returns silently -- so it is
// asserted rather than assumed, before any test runs.
describe("the migration is applied inside the CALLER's transaction", () => {
  it("carries no transaction control of its own once stripped", () => {
    expect(SQL_0203, "0203 is expected to open its own transaction").toMatch(/^\s*begin\s*;/im);
    expect(GUARD_AND_COMMAND, "a `begin` survived the strip").not.toMatch(/^\s*begin\s*;/im);
    expect(GUARD_AND_COMMAND, "a `commit` survived the strip").not.toMatch(/^\s*commit\s*;/im);
  });
});

let studio: SeededStudio;

beforeAll(async () => {
  studio = await seedStudio("wait-b2b");
});

afterAll(async () => {
  await closePool();
});

type Q = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

/**
 * Run `fn` in a transaction that ALWAYS rolls back.
 *
 * `adminTx` commits on success, so a sentinel throw is used to force the
 * rollback and is swallowed outside. Nothing this file does survives.
 */
async function rolledBack<T>(fn: (q: Q) => Promise<T>): Promise<T> {
  const SENTINEL = `__rollback_${randomUUID()}__`;
  let out: T | undefined;
  let captured: unknown;
  try {
    await adminTx(async (q) => {
      try {
        out = await fn(q as Q);
      } catch (e) {
        captured = e;
      }
      throw new Error(SENTINEL);
    });
  } catch (e) {
    if (!(e instanceof Error) || e.message !== SENTINEL) throw e;
  }
  if (captured) throw captured;
  return out as T;
}

/** Apply 0203 (optionally mutated) and seed one entry holding a mobile. */
async function with0203<T>(
  fn: (q: Q, ids: { a: string; b: string }) => Promise<T>,
  mutate: (sql: string) => string = (s) => s,
): Promise<T> {
  return rolledBack(async (q) => {
    await q(mutate(GUARD_AND_COMMAND));
    const a = randomUUID();
    const b = randomUUID();
    for (const [id, phone] of [
      [a, "647-555-1234"],
      [b, "416-555-9999"],
    ] as const) {
      await q(
        // `source = 'public_booking'` with a NULL created_by is the one shape
        // 0193's created_by_evidence_check permits for a self-serve join.
        `insert into public.new_client_waitlist_entries
           (id, studio_id, name, email, phone, status, joined_at, source,
            created_by_practitioner_id)
         values ($1, $2, $3, $4, $5, 'waiting', now(), 'public_booking', null)`,
        [id, studio.studioId, `B2b ${id.slice(0, 8)}`, `${id.slice(0, 8)}@harness.local`, phone],
      );
    }
    return fn(q, { a, b });
  });
}

/**
 * Assert a statement RAISES, without poisoning the surrounding transaction.
 *
 * Postgres aborts the whole transaction on a failed statement, so a bare
 * `expect(...).rejects` leaves every later read failing with "current
 * transaction is aborted". These tests only appeared to work before because the
 * migration's own `commit;` had already ended the transaction and each statement
 * ran in auto-commit -- the same leak, showing up a second way.
 *
 * A savepoint contains the abort so the assertions after it are real.
 */
async function mustRaise(q: Q, re: RegExp, sql: string, params: unknown[] = []): Promise<void> {
  const sp = `sp_${randomUUID().replace(/-/g, "")}`;
  await q(`savepoint ${sp}`);
  let message: string | null = null;
  try {
    await q(sql, params);
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  await q(`rollback to savepoint ${sp}`);
  expect(message, `the statement did not raise at all: ${sql.slice(0, 70)}`).not.toBeNull();
  expect(message ?? "", `raised, but not with the expected rule`).toMatch(re);
}

const verifiedAt = async (q: Q, id: string): Promise<string | null> => {
  const r = await q("select mobile_verified_at from public.new_client_waitlist_entries where id = $1", [
    id,
  ]);
  return (r.rows[0]?.mobile_verified_at as string | null) ?? null;
};

describe("0203: mobile_verified_at has exactly one writer, and it is reachable", () => {
  it("A DIRECT UPDATE RAISES — the one-writer exception is not dead code", async () => {
    // THE ASSERTION THE SOURCE TEST CANNOT MAKE. If a `return new;` were inserted
    // above these raises they would never run, and every text assertion about
    // 0203 would still pass. This one would not.
    await with0203(async (q, ids) => {
      await mustRaise(q, /exactly one writer/i, "update public.new_client_waitlist_entries set mobile_verified_at = now() where id = $1", [ids.a,]);
      expect(await verifiedAt(q, ids.a)).toBeNull();
    });
  });

  it("the COMMAND may write, and writes the database's own clock", async () => {
    await with0203(async (q, ids) => {
      const r = await q("select public.mark_waitlist_mobile_verified($1, $2) as out", [
        ids.a,
        "647-555-1234",
      ]);
      expect(r.rows[0].out).toBe("verified");
      const at = await verifiedAt(q, ids.a);
      expect(at, "the promotion did not land").not.toBeNull();
    });
  });

  it("A PERMIT FOR ROW A AUTHORIZES NOTHING OVER ROW B", async () => {
    // The permit is row-scoped. Setting it by hand for A and then writing B is
    // the attack this closes, and it must raise rather than silently succeed.
    await with0203(async (q, ids) => {
      await q("select set_config('hone.mobile_verified_entry_id', $1, true)", [ids.a]);
      await mustRaise(q, /exactly one writer/i, "update public.new_client_waitlist_entries set mobile_verified_at = now() where id = $1", [ids.b,]);
      expect(await verifiedAt(q, ids.b)).toBeNull();
    });
  });

  it("a proved instant can neither MOVE nor be CLEARED", async () => {
    await with0203(async (q, ids) => {
      await q("select public.mark_waitlist_mobile_verified($1, $2)", [ids.a, "647-555-1234"]);
      // Even holding the permit, the instant is one-way.
      await q("select set_config('hone.mobile_verified_entry_id', $1, true)", [ids.a]);
      await mustRaise(q, /immutable once proved/i, "update public.new_client_waitlist_entries set mobile_verified_at = now() where id = $1", [ids.a,]);
      await mustRaise(q, /immutable once proved|may not be cleared/i, "update public.new_client_waitlist_entries set mobile_verified_at = null where id = $1", [ids.a,]);
    });
  });

  it("the command compares the stored phone EXACTLY, and answers instead of raising", async () => {
    await with0203(async (q, ids) => {
      for (const wrong of ["+16475551234", "6475551234", "416-555-9999"]) {
        const r = await q("select public.mark_waitlist_mobile_verified($1, $2) as out", [
          ids.a,
          wrong,
        ]);
        expect(r.rows[0].out, `${wrong} should not have verified`).toBe("phone_mismatch");
      }
      expect(await verifiedAt(q, ids.a)).toBeNull();
      // And the exact stored string does verify, so the comparison is not simply
      // refusing everything.
      const ok = await q("select public.mark_waitlist_mobile_verified($1, $2) as out", [
        ids.a,
        "647-555-1234",
      ]);
      expect(ok.rows[0].out).toBe("verified");
    });
  });

  it("a second proof is idempotent, not a second promotion", async () => {
    await with0203(async (q, ids) => {
      await q("select public.mark_waitlist_mobile_verified($1, $2)", [ids.a, "647-555-1234"]);
      const first = await verifiedAt(q, ids.a);
      const again = await q("select public.mark_waitlist_mobile_verified($1, $2) as out", [
        ids.a,
        "647-555-1234",
      ]);
      expect(again.rows[0].out).toBe("already_verified");
      // Compared as instants, not object identity: pg returns a fresh Date each
      // read, so `toBe` fails on two Dates that are the same moment.
      expect(
        new Date(await verifiedAt(q, ids.a) as unknown as string).getTime(),
        "the recorded instant moved",
      ).toBe(new Date(first as unknown as string).getTime());
    });
  });

  it("an unknown entry is answered, never raised", async () => {
    await with0203(async (q) => {
      const r = await q("select public.mark_waitlist_mobile_verified($1, $2) as out", [
        randomUUID(),
        "647-555-1234",
      ]);
      expect(r.rows[0].out).toBe("not_found");
    });
  });
});

describe("0203 carries 0202's rules, proven by making each one raise", () => {
  // `create or replace function` silently drops what the new body omits. The
  // source test pins the carried rules by NAME; this proves they still FIRE.
  it("identity stays frozen", async () => {
    await with0203(async (q, ids) => {
      await mustRaise(q, /immutable/i, "update public.new_client_waitlist_entries set joined_at = now() - interval '1 day' where id = $1", [ids.a,]);
    });
  });

  it("name and email stay immutable", async () => {
    await with0203(async (q, ids) => {
      await mustRaise(q, /name and email are immutable/i, "update public.new_client_waitlist_entries set name = 'Renamed' where id = $1", [ids.a]);
    });
  });

  it("a stored mobile is one-way", async () => {
    await with0203(async (q, ids) => {
      await mustRaise(q, /may not be replaced or cleared/i, "update public.new_client_waitlist_entries set phone = '905-555-0000' where id = $1", [ids.a,]);
    });
  });

  it("an illegal lifecycle transition is REFUSED", async () => {
    // THE PROPERTY, NOT THE MECHANISM. `waiting -> claimed` by direct UPDATE is
    // refused by 0193's cycle-evidence CHECK before the trigger's transition
    // graph is reached, so asserting the graph's own message here would be
    // asserting which rule happens to fire first. Both are the database
    // refusing, and either is a pass; the graph itself is pinned by name in
    // tests/migrations/0203-*.test.ts and carried verbatim from 0202.
    await with0203(async (q, ids) => {
      await mustRaise(q, /./, "update public.new_client_waitlist_entries set status = 'claimed' where id = $1", [ids.a]);
    });
  });

  it("the transition GRAPH itself still raises, by its own message", async () => {
    // A pair the constraints permit but the graph forbids, so the refusal can
    // only be the carried trigger. If 0203 had dropped the graph this passes
    // nothing -- which is exactly what it is here to catch.
    await with0203(async (q, ids) => {
      // `source` sits in the identity-freeze clause, which no CHECK constraint
      // duplicates -- so this refusal can only come from the carried trigger.
      await mustRaise(
        q,
        /id, studio_id, joined_at and source are immutable/i,
        "update public.new_client_waitlist_entries set source = 'staff_manual' where id = $1",
        [ids.a],
      );
    });
  });
});

describe("NEGATIVE CONTROL: the mutation the source test could not see", () => {
  it("`return new;` above the raises DEFEATS the guard, and this suite catches it", async () => {
    // PERFORMED FOR REAL, inside a rolled-back transaction, exactly as
    // tests/db/new-client-waitlist-entries.db.test.ts does for 0185.
    //
    // This is the mutation a review used to show that a text-only proof of 0203
    // was insufficient: every assertion in tests/migrations/0203-*.test.ts still
    // passes with it applied. Here it must make the database behave wrongly --
    // which is what proves the behavioural assertions above are load-bearing.
    const OUTER = "  if new.mobile_verified_at is distinct from old.mobile_verified_at then";
    const mutate = (sql: string) => {
      expect(sql.split(OUTER).length - 1, "the outer condition must appear once").toBe(1);
      return sql.replace(OUTER, `${OUTER}\n    return new;`);
    };

    const permitted = await with0203(async (q, ids) => {
      // With the guard short-circuited, an UNPERMITTED direct update succeeds.
      await q("update public.new_client_waitlist_entries set mobile_verified_at = now() where id = $1", [
        ids.a,
      ]);
      return await verifiedAt(q, ids.a);
    }, mutate);

    expect(
      permitted,
      "the mutation did not actually defeat the guard, so this control proves nothing",
    ).not.toBeNull();
  });

  it("and with the REAL 0203 the same update is refused", async () => {
    // The two halves together are the control: same statement, opposite outcome,
    // and the only difference is the mutation.
    await with0203(async (q, ids) => {
      await mustRaise(q, /exactly one writer/i, "update public.new_client_waitlist_entries set mobile_verified_at = now() where id = $1", [ids.a,]);
    });
  });
});
