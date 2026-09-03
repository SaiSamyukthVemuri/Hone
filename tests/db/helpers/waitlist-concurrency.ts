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
 * CHRONOLOGY OF TWO STORED POSTGRESQL TIMESTAMPS — compared BY POSTGRESQL.
 *
 * THE DEFECT THIS REPLACES. The previous `expectOrdered` took two JS `Date`s.
 * By the time it ran, node-postgres had already converted `timestamptz` to
 * `Date`, and PostgreSQL stores MICROSECONDS while `Date` stores milliseconds.
 * A genuine sub-millisecond inversion therefore collapsed to equality and a
 * zero-tolerance assertion PASSED. Reproduced against real stored values: two
 * timestamps 300us apart, successor first, gave `s >= p` = false in PostgreSQL
 * and `successor.getTime() === predecessor.getTime()` in JavaScript.
 *
 * So the values never leave the database. The caller supplies a query selecting
 * exactly TWO timestamptz columns — successor first, predecessor second — and
 * PostgreSQL evaluates the ordering. JavaScript only chooses WHICH rows to
 * compare, which is the one thing it can do without losing precision.
 *
 * IDENTITY IS STILL ESTABLISHED INDEPENDENTLY. Where events are compared, the
 * caller passes the event ids it captured by before/after set difference. The
 * timestamps decide nothing about which row is which; they are only the values
 * being judged.
 */
export async function expectPostgresOrdered(
  source: { sql: string; params?: readonly unknown[] },
  why: string,
): Promise<void> {
  const r = await adminQuery(
    `select src.s >= src.p                                       as ordered,
            to_char(src.s, 'YYYY-MM-DD"T"HH24:MI:SS.USOF')       as successor,
            to_char(src.p, 'YYYY-MM-DD"T"HH24:MI:SS.USOF')       as predecessor,
            round(extract(epoch from (src.s - src.p)) * 1000000)::bigint as delta_us
       from (${source.sql}) as src(s, p)`,
    [...(source.params ?? [])],
  );
  expect(r.rows, `${why} — the chronology query matched no row`).toHaveLength(1);
  const row = r.rows[0] as {
    ordered: boolean | null;
    successor: string | null;
    predecessor: string | null;
    delta_us: string | null;
  };
  expect(
    row.ordered,
    `${why} — successor ${row.successor} is ${row.delta_us}us relative to ` +
      `predecessor ${row.predecessor} (negative means the successor is EARLIER)`,
  ).toBe(true);
}

/**
 * Chronology against an EXTERNALLY OBSERVED boundary instant, where a
 * millisecond tolerance is the intended semantics rather than a precision leak.
 *
 * This exists so the two cases that legitimately need it cannot be confused
 * with stored-vs-stored chronology: one operand here is an instant read on a
 * DIFFERENT connection from the one that stamped the row, so the two clocks are
 * genuinely separate observations and a small tolerance is meaningful.
 *
 * The tolerance is REQUIRED and must be positive. There is deliberately no
 * zero-tolerance path through this helper — a zero-tolerance comparison of two
 * stored columns belongs in expectPostgresOrdered, where PostgreSQL decides it.
 */
export function expectOrderedWithinMs(
  successor: Date,
  predecessor: Date,
  why: string,
  toleranceMs: number,
): void {
  if (!(toleranceMs > 0)) {
    throw new Error(
      `expectOrderedWithinMs requires a positive tolerance; for two stored ` +
        `PostgreSQL timestamps use expectPostgresOrdered so the database compares them`,
    );
  }
  const drift = predecessor.getTime() - successor.getTime();
  expect(
    drift,
    `${why} — the successor stamp is ${drift}ms BEFORE its predecessor`,
  ).toBeLessThanOrEqual(toleranceMs);
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
