import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { adminQuery, adminTx, closePool } from "./helpers/harness";

// ===========================================================================
// 0227 — DELIVERY-QUARANTINE-BOUND-01 (Codex P2 4252980865 on #832).
//
// claim_email_provider_events quarantines receipts that have spent their five
// attempts. In 0212 the SWEEP path quarantined the entire exhausted backlog in
// one locking statement, whatever limit the caller asked for. These cases
// prove the forward fix against a real database:
//
//   1. a backlog larger than the limit: one sweep quarantines exactly the
//      requested batch, the OLDEST receipts, and the rest drain over later
//      sweeps;
//   2. a targeted call still quarantines exactly its own receipt and no other;
//   3. competing sweeps: while one sweep holds its batch (uncommitted), a
//      second sweep takes the NEXT batch without waiting, and the two batches
//      are disjoint;
//   4. recovery is not starved: in the same bounded sweep, a live receipt
//      whose first attempt never finished is still claimed and then processed
//      to its true outcome, while the exhausted backlog drains at the limit.
//
// Every receipt here is a "never matched" email.sent with no ledger row, so
// nothing outside email_provider_events is touched. The exhausted state is
// seeded by raising processing_attempts to five, the only direction the
// write-once guard allows.
// ===========================================================================

type Row = { id: string; processing_state: string; processing_result: string | null; processing_attempts: number };

const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> =>
  (await adminQuery(text, params)).rows as T[];

/** Receipts this file created, finished after each case so no sweep elsewhere meets them. */
const created: string[] = [];

afterEach(async () => {
  // Quarantine-or-finish everything a case left pending, without a sweep.
  for (const id of created.splice(0)) {
    await q(`select * from public.process_email_provider_event($1)`, [id]);
  }
});

afterAll(async () => {
  await closePool();
});

/** Record one signature-verified receipt the way the webhook route does. */
async function record(): Promise<string> {
  const r = await q<{ receipt_id: string }>(
    `select receipt_id from public.record_email_provider_event($1, 'email.sent', $2, null, null, null, null, null, null)`,
    [`msg_${randomUUID().replace(/-/g, "")}`, randomUUID()],
  );
  created.push(r[0]!.receipt_id);
  return r[0]!.receipt_id;
}

/** n exhausted receipts, oldest first (received_at is the server clock at record time). */
async function exhausted(n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push(await record());
  await q(`update public.email_provider_events set processing_attempts = 5 where id = any($1::uuid[])`, [ids]);
  return ids;
}

/** Move a receipt into the past. received_at is write-once by trigger, so the
 *  trigger is disabled for this one statement, in one transaction, as the table
 *  owner -- the same route the 0212 suite's backdateReceived takes. */
async function backdateReceived(id: string, seconds: number): Promise<void> {
  await adminTx(async (tx) => {
    await tx(`alter table public.email_provider_events disable trigger email_provider_events_identity_guard`);
    await tx(`update public.email_provider_events set received_at = now() - make_interval(secs => $2) where id = $1`, [
      id,
      seconds,
    ]);
    await tx(`alter table public.email_provider_events enable trigger email_provider_events_identity_guard`);
  });
}

async function rows(ids: string[]): Promise<Map<string, Row>> {
  const r = await q<Row>(
    `select id, processing_state, processing_result, processing_attempts
       from public.email_provider_events where id = any($1::uuid[])`,
    [ids],
  );
  return new Map(r.map((x) => [x.id, x]));
}

/** Every pending exhausted receipt in the database, oldest first, as the fix orders them. */
async function exhaustedBacklog(): Promise<string[]> {
  const r = await q<{ id: string }>(
    `select id from public.email_provider_events
      where processing_state = 'pending' and processing_attempts >= 5
        and (processing_claimed_at is null or processing_claimed_at < now() - interval '2 minutes')
      order by received_at, id`,
  );
  return r.map((x) => x.id);
}

const quarantined = (m: Map<string, Row>) =>
  [...m.values()].filter((r) => r.processing_state === "quarantined").map((r) => r.id);

describe("a sweep quarantines at most its requested batch (0227)", () => {
  it("bounds a backlog larger than the limit to exactly the limit, oldest first, and drains the rest later", async () => {
    const L = 3;
    const mine = await exhausted(3 * L);
    const before = await exhaustedBacklog();
    expect(before.length).toBeGreaterThanOrEqual(3 * L);

    // One sweep, limit L.
    await q(`select * from public.claim_email_provider_events(null, $1)`, [L]);

    const after = await exhaustedBacklog();
    // Exactly L left the backlog (0212 would have emptied it), and they were the L oldest.
    expect(before.length - after.length).toBe(L);
    expect(before.filter((id) => !after.includes(id))).toEqual(before.slice(0, L));

    const m = await rows(mine);
    for (const id of before.slice(0, L).filter((id) => mine.includes(id))) {
      expect(m.get(id)).toMatchObject({ processing_state: "quarantined", processing_result: "processing_exhausted" });
    }
    // The remainder is untouched: still pending, still five attempts, not claimed.
    expect(quarantined(m).length).toBeLessThanOrEqual(L);
    for (const id of after.filter((id) => mine.includes(id))) {
      expect(m.get(id)).toMatchObject({ processing_state: "pending", processing_attempts: 5 });
    }

    // Successive sweeps drain the rest, at most L each.
    let prev = after.length;
    while (prev > 0) {
      await q(`select * from public.claim_email_provider_events(null, $1)`, [L]);
      const now = (await exhaustedBacklog()).length;
      expect(prev - now).toBe(Math.min(L, prev));
      prev = now;
    }
    expect(quarantined(await rows(mine))).toHaveLength(3 * L);
  });

  it("clamps the bound like the claim step: null means 10, and nothing above 50", async () => {
    const mine = await exhausted(12);
    const before = (await exhaustedBacklog()).length;
    await q(`select * from public.claim_email_provider_events(null, null)`);
    expect(before - (await exhaustedBacklog()).length).toBe(Math.min(10, before));
    // Drain what is left so the next case starts clean.
    while ((await exhaustedBacklog()).length > 0) {
      await q(`select * from public.claim_email_provider_events(null, 50)`);
    }
    expect(quarantined(await rows(mine))).toHaveLength(12);
  });
});

describe("a targeted call is unchanged (0227)", () => {
  it("quarantines exactly its own exhausted receipt, never any other", async () => {
    const [target, ...others] = await exhausted(4);
    const claimed = await q<{ receipt_id: string }>(`select * from public.claim_email_provider_events($1, 50)`, [target]);
    expect(claimed).toEqual([]);
    const m = await rows([target!, ...others]);
    expect(m.get(target!)).toMatchObject({ processing_state: "quarantined", processing_result: "processing_exhausted" });
    for (const id of others) expect(m.get(id)).toMatchObject({ processing_state: "pending", processing_attempts: 5 });
  });

  it("still claims a live receipt by id, one attempt at a time, and ignores p_limit", async () => {
    const id = await record();
    const claimed = await q<{ receipt_id: string }>(`select * from public.claim_email_provider_events($1, 50)`, [id]);
    expect(claimed.map((r) => r.receipt_id)).toEqual([id]);
    expect((await rows([id])).get(id)).toMatchObject({ processing_state: "pending", processing_attempts: 1 });
  });
});

describe("competing sweeps are safe (0227)", () => {
  it("while one sweep holds its batch, a second takes the next oldest batch without waiting; the batches are disjoint", async () => {
    const L = 2;
    await exhausted(3 * L);
    const before = await exhaustedBacklog();

    let secondBatch: string[] = [];
    await adminTx(async (tx) => {
      // Sweep 1 quarantines its batch and keeps the rows locked (uncommitted).
      await tx(`set local lock_timeout = '2s'`);
      await tx(`select * from public.claim_email_provider_events(null, $1)`, [L]);

      // Sweep 2, on another connection, must neither wait (lock_timeout would
      // raise) nor touch sweep 1's rows: it quarantines the NEXT L.
      const t0 = Date.now();
      await adminTx(async (tx2) => {
        await tx2(`set local lock_timeout = '1s'`);
        await tx2(`select * from public.claim_email_provider_events(null, $1)`, [L]);
      });
      expect(Date.now() - t0).toBeLessThan(1000);

      const visibleOutside = await exhaustedBacklog();
      // Sweep 2's batch is committed; sweep 1's is still pending outside this transaction.
      secondBatch = before.filter((id) => !visibleOutside.includes(id));
      expect(secondBatch).toEqual(before.slice(L, 2 * L));
    });

    const after = await exhaustedBacklog();
    // Together: exactly 2L, the 2L oldest, with no receipt quarantined twice.
    expect(before.length - after.length).toBe(2 * L);
    expect(before.filter((id) => !after.includes(id))).toEqual(before.slice(0, 2 * L));
    const m = await rows(before.slice(0, 2 * L));
    for (const id of before.slice(0, 2 * L)) {
      expect(m.get(id)).toMatchObject({ processing_state: "quarantined", processing_result: "processing_exhausted" });
    }
  });
});

describe("recovery is not starved by an exhausted backlog (0227)", () => {
  it("one bounded sweep quarantines exactly its batch AND still claims a live receipt, which then processes to its true outcome", async () => {
    const L = 2;
    await exhausted(3 * L);
    // A live receipt whose first attempt never ran, older than anything else
    // pending, so the claim step's oldest-first order reaches it first.
    const live = await record();
    await backdateReceived(live, 30 * 24 * 3600);
    const before = await exhaustedBacklog();

    const claimed = (
      await q<{ receipt_id: string }>(`select * from public.claim_email_provider_events(null, $1)`, [L])
    ).map((r) => r.receipt_id);

    // Bounded quarantine...
    expect(before.length - (await exhaustedBacklog()).length).toBe(L);
    // ...and the live receipt was still claimed in the same call, one attempt counted.
    expect(claimed).toContain(live);
    expect(claimed.length).toBeLessThanOrEqual(L);
    expect((await rows([live])).get(live)).toMatchObject({ processing_state: "pending", processing_attempts: 1 });

    // Processing it records its true outcome: an email.sent for an id no
    // ledger row holds is unmatched, not quarantined and not left pending.
    const p = await q<{ result: string; reason: string | null }>(`select * from public.process_email_provider_event($1)`, [
      live,
    ]);
    expect(p[0]).toMatchObject({ result: "unmatched" });
    expect((await rows([live])).get(live)).toMatchObject({ processing_state: "unmatched", processing_result: "unmatched_email_id" });
  });
});

