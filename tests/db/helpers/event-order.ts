/**
 * WAIT-03 — reconstructing the order of an entry's lifecycle events.
 *
 * THE CIRCULARITY THIS MODULE EXISTS TO REFUSE. `new_client_waitlist_entry_events`
 * has no independent sequence: `id` is a random uuid, and `occurred_at` is the
 * very evidence these tests exist to validate. An earlier version of this code
 * reconstructed a history by walking the transition chain and then, where a
 * transition REPEATED, assigning the repeats to their slots in `occurred_at`
 * order. That is circular — the timestamp decided which event was which, and the
 * resulting sequence was then used to prove the timestamps were ordered — and it
 * is not merely inelegant: it can HIDE a real inversion.
 *
 * Two release/requeue cycles produce the multiset
 *
 *     waiting->claimed  {10, 50}   claimed->invited  {20, 60}
 *     invited->released {30, 70}   released->waiting {40}
 *
 * Sorting each class independently reconstructs 0,10,20,30,40,50,60,70 — flawless
 * — while the execution that actually produced those rows may have been
 * 0,50,20,30,40,10,60,70, in which the FIRST cycle ran backwards. The rows are
 * identical; only the cycle identity differs, and the timestamps cannot supply
 * it. tests/lib/waitlist-event-order.test.ts executes exactly that history.
 *
 * SO THIS MODULE NEVER USES A TIMESTAMP TO DECIDE IDENTITY. It linearizes a
 * history only when the transition labels alone determine one, and REFUSES
 * otherwise. A repeated history is not "ordered by best effort"; it is handed
 * back as ambiguous, and the caller must establish identity independently — by
 * observing which event ids appeared at each controlled operation boundary. The
 * harness can do that because it controls the operations; the database cannot,
 * because it stores no sequence.
 */

export type EventRow = {
  from_status: string | null;
  to_status: string;
  occurred_at: Date;
};

export type Linearization<T extends EventRow> =
  | { ok: true; chain: T[] }
  | { ok: false; reason: "no-head" | "no-chain" | "ambiguous"; detail: string };

const label = (r: EventRow) => `${r.from_status}->${r.to_status}`;

/**
 * Reconstruct execution order from the transition labels ALONE.
 *
 * Succeeds only when exactly one ordering of the rows forms a single chain from
 * the INSERT event. A history that repeats a transition admits several orderings
 * that differ only in which repeat sits where; those are reported `ambiguous`
 * rather than resolved, because the only thing that could resolve them is the
 * timestamp under test.
 */
export function linearizeByTransitionChain<T extends EventRow>(rows: T[]): Linearization<T> {
  const heads = rows.filter((r) => r.from_status === null);
  if (heads.length !== 1) {
    return {
      ok: false,
      reason: "no-head",
      detail: `expected exactly one INSERT event, found ${heads.length}`,
    };
  }

  const used = rows.map(() => false);
  const path: T[] = [];
  const found: T[][] = [];
  const walk = (i: number): void => {
    if (found.length > 1) return; // ambiguity established; no need to enumerate
    used[i] = true;
    path.push(rows[i]);
    if (path.length === rows.length) {
      found.push([...path]);
    } else {
      for (let j = 0; j < rows.length; j += 1) {
        if (!used[j] && rows[j].from_status === rows[i].to_status) walk(j);
      }
    }
    path.pop();
    used[i] = false;
  };
  walk(rows.indexOf(heads[0]));

  if (found.length === 0) {
    return {
      ok: false,
      reason: "no-chain",
      detail: `no ordering of these ${rows.length} events forms a single chain: ${rows.map(label).join(", ")}`,
    };
  }
  if (found.length > 1) {
    return {
      ok: false,
      reason: "ambiguous",
      detail:
        `${rows.length} events admit more than one ordering — this history repeats a ` +
        `transition, so its sequence cannot be recovered from the labels. Capture event ` +
        `identity at each operation boundary instead (see observedSequence in the WAIT-03 ` +
        `temporal suite); do NOT fall back to occurred_at, which is the evidence under test.`,
    };
  }
  return { ok: true, chain: found[0] };
}

/** The first place a sequence goes backwards in time, or null. The sequence must
 *  already be in a known execution order — this function establishes nothing. */
export function firstInversion(rows: EventRow[]): string | null {
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i].occurred_at.getTime() < rows[i - 1].occurred_at.getTime()) {
      return `${label(rows[i - 1])}(${rows[i - 1].occurred_at.toISOString()}) -> ${label(rows[i])}(${rows[i].occurred_at.toISOString()})`;
    }
  }
  return null;
}
