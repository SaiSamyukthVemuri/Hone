import { expect } from "vitest";
import { adminQuery } from "./harness";
import type { EventRow } from "./event-order";

/**
 * WAIT-03 — small helpers for the deterministic concurrency tests.
 *
 * Ordinary functions with ordinary assertions. There is no proof framework here:
 * a test passes when its assertions pass, and Vitest's verdict is the verdict.
 *
 * An earlier revision of this suite grew a self-certifying harness — evidence
 * tokens, proof handles, a manifest of required evidence, AST checks that a test
 * had executed, a private writer boundary, and mutation campaigns proving each of
 * those. It was answering "could a future test lie about having run?", which is a
 * code-review question, not a release question, and each layer needed another
 * layer to certify it. The behavioural coverage it wrapped is unchanged; the
 * certification machinery is gone.
 */

export type ObservedEvent = EventRow & { id: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll pg_stat_activity until `pid` is genuinely waiting on a lock, and return
 * the wait it was found in. Returns null on timeout.
 *
 * This is the real blocking observation the concurrency tests rest on: a
 * transaction that merely takes a while is not the same as one parked on a lock,
 * and only pg_stat_activity can tell them apart.
 */
export async function waitUntilBlocked(pid: number, timeoutMs = 12000): Promise<string | null> {
  return (await observeUntilBlocked(pid, timeoutMs)).lockWait;
}

type BlockObservation = {
  /** `wait_event_type/wait_event` once the backend is parked on a lock. */
  lockWait: string | null;
  /** What it was last seen doing, for when it never parked. */
  lastSeen: string;
  polls: number;
  elapsedMs: number;
};

/**
 * The same poll, but reporting what it saw when the backend never blocked.
 *
 * A bare "it never reached a Lock wait" is not diagnosable after the fact: it
 * cannot distinguish a backend that finished early (so there was no contention
 * to observe) from one still running, from one that vanished. This has cost two
 * uncharacterised intermittent failures, so the last observed state is carried
 * into the failure message.
 */
async function observeUntilBlocked(pid: number, timeoutMs: number): Promise<BlockObservation> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let lastSeen = "the backend was never seen in pg_stat_activity";
  let polls = 0;
  while (Date.now() < deadline) {
    polls += 1;
    const r = await adminQuery(
      `select state, wait_event_type, wait_event, left(query, 60) as query
         from pg_stat_activity where pid = $1`,
      [pid],
    );
    const row = r.rows[0] as
      | { state: string; wait_event_type: string | null; wait_event: string | null; query: string }
      | undefined;
    if (row) {
      lastSeen = `state=${row.state} wait=${row.wait_event_type ?? "none"}/${row.wait_event ?? "none"} query=${JSON.stringify(row.query)}`;
      if (row.wait_event_type === "Lock") {
        return {
          lockWait: `${row.wait_event_type}/${row.wait_event}`,
          lastSeen,
          polls,
          elapsedMs: Date.now() - startedAt,
        };
      }
    }
    await sleep(50);
  }
  return { lockWait: null, lastSeen, polls, elapsedMs: Date.now() - startedAt };
}

/** Assert that a backend really parked on a lock. */
export async function expectBlockedOn(pid: number, why: string): Promise<string> {
  const seen = await observeUntilBlocked(pid, 12000);
  expect(
    seen.lockWait,
    `${why} — the backend never reached a Lock wait after ${seen.polls} polls over ` +
      `${seen.elapsedMs}ms. Last seen: ${seen.lastSeen}`,
  ).not.toBeNull();
  return seen.lockWait as string;
}

/** Assert an uncommitted row is invisible to another session. */
export async function expectInvisibleWhileUncommitted(entryId: string, why: string): Promise<void> {
  const r = await adminQuery(
    `select count(*)::int as c from public.new_client_waitlist_entries where id = $1`,
    [entryId],
  );
  expect(r.rows[0].c as number, `${why} — the uncommitted row was visible`).toBe(0);
}

/** Assert other sessions still see the PRE-transition state. */
export async function expectStillSees(
  entryId: string,
  status: string,
  why: string,
): Promise<void> {
  const r = await adminQuery(
    `select status from public.new_client_waitlist_entries where id = $1`,
    [entryId],
  );
  expect(r.rows[0]?.status as string, `${why} — the uncommitted transition was visible`).toBe(
    status,
  );
}

/**
 * A RELATION BETWEEN TWO STORED POSTGRESQL TIMESTAMPS — evaluated BY POSTGRESQL.
 *
 * THE DEFECT THIS EXISTS FOR. node-postgres converts `timestamptz` to a JS
 * `Date` before any assertion runs. PostgreSQL keeps MICROSECONDS; `Date` keeps
 * milliseconds. So two stored values 300us apart arrive identical, and BOTH
 * kinds of verdict lie: an ordering check accepts a real inversion, and an
 * equality check accepts two DIFFERENT instants as "the same decision instant".
 * The second is the one that matters most here, because "the event IS the
 * transition" is the whole claim 0189's post-lock clock is meant to guarantee.
 *
 * So the values never leave the database. The caller supplies a query selecting
 * exactly TWO timestamptz columns — left first, right second — and names the
 * relation. JavaScript chooses WHICH rows to compare, which is the one thing it
 * can do without losing precision; PostgreSQL decides the relation.
 *
 * The relation is a CLOSED enum mapped to an operator in trusted code here. No
 * caller-supplied operator is ever interpolated.
 */
export type PostgresTemporalRelation = "eq" | "lt" | "lte" | "gt" | "gte";

const RELATION_SQL: Record<PostgresTemporalRelation, string> = {
  eq: "=",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
};

export async function expectPostgresTemporalRelation(
  source: {
    sql: string;
    params?: readonly unknown[];
    relation: PostgresTemporalRelation;
  },
  why: string,
): Promise<void> {
  const op = RELATION_SQL[source.relation];
  if (!op) throw new Error(`unknown temporal relation ${source.relation}`);
  const r = await adminQuery(
    `select src.l ${op} src.r                                    as holds,
            to_char(src.l, 'YYYY-MM-DD"T"HH24:MI:SS.USOF')       as left_ts,
            to_char(src.r, 'YYYY-MM-DD"T"HH24:MI:SS.USOF')       as right_ts,
            round(extract(epoch from (src.l - src.r)) * 1000000)::bigint as delta_us
       from (${source.sql}) as src(l, r)`,
    [...(source.params ?? [])],
  );
  expect(r.rows, `${why} — the relation query matched no row`).toHaveLength(1);
  const row = r.rows[0] as {
    holds: boolean | null;
    left_ts: string | null;
    right_ts: string | null;
    delta_us: string | null;
  };
  expect(
    row.holds,
    `${why} — expected left ${source.relation} right, but left ${row.left_ts} is ` +
      `${row.delta_us}us from right ${row.right_ts}`,
  ).toBe(true);
}

/** `successor >= predecessor`, decided by PostgreSQL. */
export async function expectPostgresOrdered(
  source: { sql: string; params?: readonly unknown[] },
  why: string,
): Promise<void> {
  await expectPostgresTemporalRelation({ ...source, relation: "gte" }, why);
}

/**
 * EXACT equality of two stored instants — no tolerance, by design.
 *
 * "The event IS the transition, not a second reading of it" is only meaningful
 * at the precision the database actually stores. A sub-millisecond difference
 * means two clock reads, which is exactly the defect 0189 removes, so it must
 * fail here rather than round away.
 */
export async function expectPostgresSameInstant(
  source: { sql: string; params?: readonly unknown[] },
  why: string,
): Promise<void> {
  await expectPostgresTemporalRelation({ ...source, relation: "eq" }, why);
}

/**
 * CHRONOLOGY ALONG AN ALREADY-ORDERED CHAIN OF EVENTS, judged by PostgreSQL.
 *
 * The ORDER is established in JavaScript and stays there: either by walking the
 * transition labels, or by the order the test executed the operations. That is
 * deliberate and unchanged — timestamps must never decide which event is which.
 *
 * What moves is the VERDICT. The ids are handed back to PostgreSQL, which walks
 * the sequence with `lag` and compares the stored `occurred_at` values at full
 * precision. `firstInversion` used to do this on truncated JS Dates.
 */
export async function expectChainChronological(
  eventIdsInOrder: readonly string[],
  why: string,
): Promise<void> {
  if (eventIdsInOrder.length < 2) return;
  const r = await adminQuery(
    `with seq as (
       select t.ord, e.occurred_at
         from unnest($1::uuid[]) with ordinality as t(id, ord)
         join public.new_client_waitlist_entry_events e on e.id = t.id
     ),
     paired as (
       select ord, occurred_at,
              lag(occurred_at) over (order by ord) as prev
         from seq
     )
     select count(*) filter (where prev is not null and occurred_at < prev) as inversions,
            count(*)                                                        as rows_found,
            min(to_char(occurred_at, 'YYYY-MM-DD"T"HH24:MI:SS.USOF'))
              filter (where prev is not null and occurred_at < prev)        as first_bad,
            min(round(extract(epoch from (occurred_at - prev)) * 1000000)::bigint)
              filter (where prev is not null and occurred_at < prev)        as worst_delta_us
       from paired`,
    [[...eventIdsInOrder]],
  );
  const row = r.rows[0] as {
    inversions: string;
    rows_found: string;
    first_bad: string | null;
    worst_delta_us: string | null;
  };
  expect(
    Number(row.rows_found),
    `${why} — the chain referenced ${eventIdsInOrder.length} events but ` +
      `${row.rows_found} were found`,
  ).toBe(eventIdsInOrder.length);
  expect(
    Number(row.inversions),
    `${why} — the log runs backwards at ${row.first_bad} (${row.worst_delta_us}us)`,
  ).toBe(0);
}

/**
 * Read a stored instant as its FULL-PRECISION text rendering.
 *
 * WHY TEXT. To prove a stored timestamp was not rewritten, the "before" value
 * has to survive the round trip. Passing it back as a JS `Date` parameter does
 * not: it is already truncated, and the comparison then fails against its own
 * source (observed exactly that — a stored `…279342+00` compared against a
 * parameter that arrived as `…279000+00`). Rendered to microsecond text inside
 * PostgreSQL, the value never becomes a `Date`, and two renderings compare
 * exactly as strings.
 */
export async function readStoredInstant(
  sql: string,
  params: readonly unknown[] = [],
): Promise<string | null> {
  const r = await adminQuery(
    `select to_char(src.t, 'YYYY-MM-DD"T"HH24:MI:SS.USOF') as ts from (${sql}) as src(t)`,
    [...params],
  );
  expect(r.rows, "the instant query matched no row").toHaveLength(1);
  return (r.rows[0] as { ts: string | null }).ts;
}

/** The ids of an entry's lifecycle events, for before/after set difference. */
export async function eventIdSet(entryId: string): Promise<Set<string>> {
  const r = await adminQuery(
    `select id from public.new_client_waitlist_entry_events where entry_id = $1`,
    [entryId],
  );
  return new Set(r.rows.map((x: Record<string, unknown>) => x.id as string));
}

/** Events appended since a snapshot, identified by set difference. */
export async function newEventsSince(
  entryId: string,
  before: Set<string>,
): Promise<ObservedEvent[]> {
  const rows = (
    await adminQuery(
      `select id, from_status, to_status, occurred_at
         from public.new_client_waitlist_entry_events where entry_id = $1`,
      [entryId],
    )
  ).rows as ObservedEvent[];
  return rows.filter((r) => !before.has(r.id));
}

/** Pick one of those by its transition, which is unique among them. */
export function pickEvent(events: ObservedEvent[], from: string, to: string): ObservedEvent {
  const hits = events.filter((e) => e.from_status === from && e.to_status === to);
  expect(hits, `expected exactly one new ${from}->${to} event`).toHaveLength(1);
  return hits[0];
}

/**
 * The single event one controlled transition appended, and the transition it was
 * required to be.
 *
 * WHY IDENTITY COMES FROM THE ID SET. The events table has no ordinal — `id` is a
 * random uuid — so on a history that revisits a status (a requeued entry reaches
 * `waiting` twice) nothing in the row itself says which visit an event belongs
 * to. Reading that from `occurred_at` would use the timestamps to decide the
 * order the timestamps are being checked against. Bracketing one operation and
 * taking the id that is new owes nothing to them.
 */
export async function expectExactlyOneNewEvent(
  entryId: string,
  before: Set<string>,
  from: string | null,
  to: string,
): Promise<ObservedEvent> {
  const fresh = await newEventsSince(entryId, before);
  const seen = fresh.map((r) => `${r.from_status}->${r.to_status}`).join(", ") || "none";
  expect(fresh, `expected exactly ONE new ${from}->${to} event, saw: ${seen}`).toHaveLength(1);
  expect(fresh[0].from_status).toBe(from);
  expect(fresh[0].to_status).toBe(to);
  return fresh[0];
}
