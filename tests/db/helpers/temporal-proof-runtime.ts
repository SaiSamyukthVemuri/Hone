import { afterAll, expect, it } from "vitest";
import { adminQuery } from "./harness";
import type { EventRow } from "./event-order";
import {
  edgeTitle,
  MECHANISM_EVIDENCE,
  REPEATED_CYCLE_EVIDENCE,
  REPEATED_CYCLE_PROOFS,
  TEMPORAL_EDGES,
  VERDICT_EVIDENCE,
  type EvidenceToken,
} from "./temporal-edges";

/**
 * WAIT-03 — THE TEMPORAL PROOF RUNTIME.
 *
 * WHY THIS MODULE EXISTS AT ALL. Closure for the temporal edges has now been
 * wrong four times, and each generation fixed the previous one's mistake while
 * making a subtler version of it:
 *
 *   1. A label table asserting its own labels were allowed labels.
 *   2. Raw source text — a block-commented test still certified its edge.
 *   3. The syntax tree — better, but a call that EXISTS is not a call that RUNS:
 *      an early return, an `if (false)`, and `it.skip` all certified edges that
 *      proved nothing.
 *   4. Runtime evidence — recorded by the assertion helpers after their
 *      assertions. Correct in direction, but the callback was handed the object
 *      that could WRITE evidence. So a test could record every token the
 *      manifest asked for and return without touching the database, and closure
 *      stayed green. That is reproduced, and it is why this module exists.
 *
 * THE AUTHORITY LAW. A callback may choose WHICH proof to invoke. It may not
 * declare the RESULT of one. So the evidence store is module-private, the writer
 * is never exported, and what a callback receives is a frozen handle carrying an
 * id and nothing else — no recorder, no token set, no completion flag. Assertion
 * helpers hold the write capability because they live in here, on the other side
 * of the module boundary, and each records only AFTER the expect that could
 * throw.
 *
 * SCOPE. This is a test harness for WAIT-03's temporal proofs. It is not a
 * general capability system, and no product code uses it.
 */

/**
 * What a callback receives. A frozen brand — the id, and nothing that can write.
 * Its identity is the key to the private store, so a look-alike object made by a
 * test is not accepted by anything in here.
 */
export type ProofHandle = { readonly proofId: string };

type InternalProofState = { readonly counts: Map<EvidenceToken, number> };

/** MODULE-PRIVATE. Never exported, in any shape. */
const STATE = new WeakMap<ProofHandle, InternalProofState>();
const STARTED: string[] = [];
const COMPLETED: string[] = [];

function newHandle(proofId: string): ProofHandle {
  const handle: ProofHandle = Object.freeze({ proofId });
  STATE.set(handle, { counts: new Map() });
  return handle;
}

/**
 * MODULE-PRIVATE WRITER. The only way evidence is ever recorded. It refuses a
 * handle it did not mint, so passing a hand-made `{ proofId: "…" }` cannot
 * produce evidence for a real edge.
 */
function recordEvidenceInternal(handle: ProofHandle, token: EvidenceToken): void {
  const state = STATE.get(handle);
  expect(
    state,
    `an unregistered proof handle tried to record ${token} — evidence can only be ` +
      `recorded against a handle this runtime created`,
  ).toBeDefined();
  state!.counts.set(token, (state!.counts.get(token) ?? 0) + 1);
}

const observedOf = (handle: ProofHandle): EvidenceToken[] =>
  [...(STATE.get(handle)?.counts.keys() ?? [])].sort();
const countOf = (handle: ProofHandle, token: EvidenceToken): number =>
  STATE.get(handle)?.counts.get(token) ?? 0;

/**
 * For assertions made OUTSIDE a registered proof. It is a real handle, so the
 * helpers work, but no closure requirement ever reads it: it certifies nothing.
 */
export const UNREGISTERED_HANDLE: ProofHandle = newHandle("(unregistered)");

// ---------------------------------------------------------------------------
// THE ASSERTION HELPERS. Each ASSERTS, and only then RECORDS. The order is
// load-bearing: the record line is unreachable when the expect throws.
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll pg_stat_activity until `pid` is genuinely waiting on a lock. */
export async function waitUntilBlocked(pid: number, timeoutMs = 12000): Promise<string | null> {
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

/**
 * THE MECHANISM PROOF for an EXECUTED_BLOCKING_RACE: the successor backend is
 * genuinely PARKED on a lock. `waitUntilBlocked` returns non-null only when
 * pg_stat_activity reports wait_event_type = 'Lock', so this is the lock proof
 * itself — not a timer, and not an inference from elapsed time.
 */
export async function proveBlockedOn(
  handle: ProofHandle,
  pid: number,
  why: string,
): Promise<string> {
  const ev = await waitUntilBlocked(pid);
  expect(ev, `${why} — the backend never reached a Lock wait`).not.toBeNull();
  recordEvidenceInternal(handle, "BLOCKED_ON_EXPECTED_LOCK");
  return ev as string;
}

/**
 * THE MECHANISM PROOF for MVCC_VISIBILITY_ORDERED. Where the predecessor INSERTS
 * the row there is no blocking schedule to exercise: the row is invisible until
 * it commits, so a successor cannot park on it — it simply cannot find it.
 */
export async function proveInvisibleWhileUncommitted(
  handle: ProofHandle,
  entryId: string,
  why: string,
): Promise<void> {
  const r = await adminQuery(
    `select count(*)::int as c from public.new_client_waitlist_entries where id = $1`,
    [entryId],
  );
  expect(r.rows[0].c as number, `${why} — the uncommitted row was visible`).toBe(0);
  recordEvidenceInternal(handle, "MVCC_INVISIBLE");
}

/**
 * THE MECHANISM PROOF for PREDICATE_VISIBILITY_ORDERED. The row exists, but the
 * STATE the successor's WHERE clause requires does not exist in any version
 * another session can see, so the statement matches zero rows and never reaches
 * a lock.
 */
export async function proveNotYetVisible(
  handle: ProofHandle,
  entryId: string,
  stillSees: string,
  why: string,
): Promise<void> {
  const r = await adminQuery(
    `select status from public.new_client_waitlist_entries where id = $1`,
    [entryId],
  );
  expect(r.rows[0].status as string, `${why} — the uncommitted transition was visible`).toBe(
    stillSees,
  );
  recordEvidenceInternal(handle, "PREDICATE_NOT_YET_VISIBLE");
}

/**
 * THE VERDICT for an ORDERED edge: the successor's stamp does not predate its
 * predecessor. `toleranceMs` is non-zero ONLY where the boundary instant is read
 * on a different connection from the one that stamps; when both values come from
 * the rows themselves it is 0 and the ordering is exact.
 */
export function expectOrdered(
  handle: ProofHandle,
  successor: Date,
  predecessor: Date,
  why: string,
  toleranceMs = 0,
): void {
  const drift = predecessor.getTime() - successor.getTime();
  expect(
    drift,
    `${why} — the successor stamp is ${drift}ms BEFORE its predecessor`,
  ).toBeLessThanOrEqual(toleranceMs);
  recordEvidenceInternal(handle, "ORDERED");
}

/** THE VERDICT for a REFUSED edge: the successor declined, in the exact deployed
 *  vocabulary. */
export function expectRefused(
  handle: ProofHandle,
  actual: string,
  expected: string,
  why: string,
): void {
  expect(actual, why).toBe(expected);
  recordEvidenceInternal(handle, "REFUSED");
}

// ---------------------------------------------------------------------------
// INDEPENDENT EVENT IDENTITY.
// ---------------------------------------------------------------------------

export type ObservedEvent = EventRow & { id: string };

export async function eventIdSet(entryId: string): Promise<Set<string>> {
  const r = await adminQuery(
    `select id from public.new_client_waitlist_entry_events where entry_id = $1`,
    [entryId],
  );
  return new Set(r.rows.map((x: Record<string, unknown>) => x.id as string));
}

/** All events appended since the snapshot, identified by set difference. */
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

/** Pick one of those by its transition, which is unique among them. Identity
 *  comes from the id set and the label — never from the timestamp. */
export function pickEvent(events: ObservedEvent[], from: string, to: string): ObservedEvent {
  const hits = events.filter((e) => e.from_status === from && e.to_status === to);
  expect(hits, `expected exactly one new ${from}->${to} event`).toHaveLength(1);
  return hits[0];
}

/** The single event a controlled transition appended. More than one, or none, is
 *  itself a failure: the caller believed it performed exactly one transition. */
export async function expectExactlyOneNewEvent(
  handle: ProofHandle,
  entryId: string,
  before: Set<string>,
  from: string | null,
  to: string,
): Promise<ObservedEvent> {
  const fresh = await newEventsSince(entryId, before);
  expect(
    fresh.map((r) => `${r.from_status}->${r.to_status}`),
    `expected exactly ONE new event for ${from}->${to}`,
  ).toHaveLength(1);
  expect(fresh[0].from_status).toBe(from);
  expect(fresh[0].to_status).toBe(to);
  recordEvidenceInternal(handle, "INDEPENDENT_EVENT_CAPTURE");
  return fresh[0];
}

/**
 * THE OPAQUE CAUSAL SEQUENCE.
 *
 * The events table stores no ordinal — `id` is a random uuid — so a repeated
 * history cannot be ordered from the rows themselves. What CAN order it is the
 * harness, because the harness performed the operations.
 *
 * The sequence is a private field with no setter and no constructor intake, so a
 * caller cannot hand it a pre-sorted array. The only way in is
 * `captureTransition`, which brackets one controlled operation and takes the
 * event id that is new; `assertChronology` walks that list in APPEND order and
 * never sorts. `occurred_at` is validated here, never used to construct the
 * order it is validated against.
 */
export class ObservedLifecycleSequence {
  readonly #events: ObservedEvent[] = [];
  readonly #entryId: string;
  readonly #handle: ProofHandle;

  constructor(entryId: string, handle: ProofHandle) {
    this.#entryId = entryId;
    this.#handle = handle;
  }

  /** Adopt the INSERT event of a freshly created entry as step zero. */
  async adopt(from: string | null, to: string): Promise<ObservedEvent> {
    const e = await expectExactlyOneNewEvent(
      this.#handle,
      this.#entryId,
      new Set<string>(),
      from,
      to,
    );
    this.#events.push(e);
    return e;
  }

  /** Run ONE controlled transition and append the event it created. */
  async captureTransition(
    from: string | null,
    to: string,
    run: () => Promise<void>,
  ): Promise<ObservedEvent> {
    const before = await eventIdSet(this.#entryId);
    await run();
    const e = await expectExactlyOneNewEvent(this.#handle, this.#entryId, before, from, to);
    this.#events.push(e);
    return e;
  }

  get length(): number {
    return this.#events.length;
  }

  /** The statuses in the order they were OBSERVED to happen. */
  statuses(): string[] {
    return this.#events.map((e) => e.to_status);
  }

  /** Chronology over the captured causal order. Nothing here sorts, and no
   *  caller can supply the order. */
  assertChronology(why: string): void {
    for (let i = 1; i < this.#events.length; i += 1) {
      const prev = this.#events[i - 1];
      const cur = this.#events[i];
      expect(
        cur.occurred_at.getTime(),
        `${why} — step ${i} (${cur.from_status}->${cur.to_status}) precedes step ${i - 1} ` +
          `(${prev.from_status}->${prev.to_status})`,
      ).toBeGreaterThanOrEqual(prev.occurred_at.getTime());
    }
    recordEvidenceInternal(this.#handle, "CHRONOLOGY_CHECK_EXECUTED");
  }

  /** Declared complete only after the expected transitions were all captured. */
  assertCompleted(expected: readonly string[]): void {
    expect(this.statuses(), "the observed cycle did not follow the expected path").toEqual([
      ...expected,
    ]);
    recordEvidenceInternal(this.#handle, "REPEATED_CYCLE_COMPLETE");
  }
}

// ---------------------------------------------------------------------------
// REGISTRATION. The wrapper mints the handle, runs the proof, and then compares
// the manifest's requirement against evidence read from the PRIVATE store. The
// callback never holds the writer, and never sees the requirement it must meet.
// ---------------------------------------------------------------------------

export function temporalEdgeTest(
  edgeId: string,
  what: string,
  fn: (proof: ProofHandle) => Promise<void>,
): void {
  it(edgeTitle(edgeId, what), async () => {
    const row = TEMPORAL_EDGES.find((e) => e.id === edgeId);
    expect(row, `${edgeId} is registered but the manifest declares no such edge`).toBeDefined();
    const handle = newHandle(edgeId);
    STARTED.push(edgeId);
    await fn(handle);
    const required = [
      MECHANISM_EVIDENCE[row!.proof],
      ...row!.verdicts.map((v) => VERDICT_EVIDENCE[v]),
    ];
    const missing = required.filter((t) => countOf(handle, t) === 0);
    expect(
      missing,
      `${edgeId}: required evidence never EXECUTED (observed: ${observedOf(handle).join(", ") || "nothing"})`,
    ).toEqual([]);
    COMPLETED.push(edgeId);
  });
}

export function repeatedCycleTest(
  cycleId: string,
  what: string,
  fn: (
    proof: ProofHandle,
    sequenceFor: (entryId: string) => ObservedLifecycleSequence,
  ) => Promise<void>,
): void {
  it(`[${cycleId}] ${what}`, async () => {
    const row = REPEATED_CYCLE_PROOFS.find((c) => c.id === cycleId);
    expect(row, `${cycleId} is registered but the manifest declares no such cycle`).toBeDefined();
    const handle = newHandle(cycleId);
    STARTED.push(cycleId);
    await fn(handle, (entryId) => new ObservedLifecycleSequence(entryId, handle));
    const missing = REPEATED_CYCLE_EVIDENCE.filter((t) => countOf(handle, t) === 0);
    expect(
      missing,
      `${cycleId}: required evidence never EXECUTED (observed: ${observedOf(handle).join(", ") || "nothing"})`,
    ).toEqual([]);
    expect(
      countOf(handle, "INDEPENDENT_EVENT_CAPTURE"),
      `${cycleId}: too few independently captured transitions`,
    ).toBeGreaterThanOrEqual(row!.captures);
    COMPLETED.push(cycleId);
  });
}

/**
 * EXACT SET EQUALITY at suite completion. A proof that never runs records
 * nothing, so it can never fail its own evidence check — this is what catches
 * `it.skip`, `it.todo`, a filtered run, or a wrapper quietly changed to skip.
 * STARTED and COMPLETED are module-private; a callback cannot append to them.
 */
export function assertAllTemporalProofsRan(): void {
  const expected = [
    ...TEMPORAL_EDGES.map((e) => e.id),
    ...REPEATED_CYCLE_PROOFS.map((c) => c.id),
  ].sort();
  expect([...new Set(STARTED)].sort(), "some registered proof never STARTED").toEqual(expected);
  expect([...new Set(COMPLETED)].sort(), "some proof started but never COMPLETED").toEqual(
    expected,
  );
}

/** Registered here so no test file can forget it. */
afterAll(() => {
  assertAllTemporalProofsRan();
});
