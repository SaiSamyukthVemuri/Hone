import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, asUser, closePool, seedStudio, type SeededStudio } from "./helpers/harness";

// HON-77 (imports). Two operators confirm the SAME paste at the same moment. The action plans from a snapshot of existing clients and then inserts, with no
// lock between. This models that sequence through the owner's RLS-backed connection (the action's own path) with a REAL interleaving: each confirm runs its
// duplicate check inside an open transaction, then waits at a barrier until BOTH have checked, and only then do both insert. So "both passed the check" is
// forced, not hoped for. Named for TODAY's behaviour: when a backstop lands, the emailless test is the one that flips on purpose. Synthetic data only; every
// test seeds its own studio so none depends on another.
afterAll(async () => {
  await closePool();
});

function barrier(parties: number) {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  return async () => {
    arrived += 1;
    if (arrived === parties) release();
    await gate;
  };
}

type Who = { name: string; email: string | null; dob: string | null };
type Outcome = { ok: boolean; sawExisting: number; code?: string };

// One confirm: check for an existing identical client, wait for the other confirm's check, then insert a batch and the client (all in one open transaction).
const confirm = (s: SeededStudio, who: Who, wait: () => Promise<void>): Promise<Outcome> => {
  let sawExisting = -1;
  return asUser(s.userId, async (q) => {
    sawExisting = Number((await q(`select count(*) n from public.clients where studio_id = $1 and name = $2`, [s.studioId, who.name])).rows[0].n);
    await wait();
    await q(`insert into public.import_batches (id, studio_id, source_type, source_label, row_count, created_by) values ($1, $2, 'other', 'CSV/TSV import', 1, $3)`, [randomUUID(), s.studioId, s.userId]);
    await q(`insert into public.clients (studio_id, name, email, date_of_birth) values ($1, $2, $3, $4)`, [s.studioId, who.name, who.email, who.dob]);
    return { ok: true, sawExisting } as Outcome;
  }).catch((e: { code?: string }) => ({ ok: false, sawExisting, code: String(e.code ?? "") }));
};
const count = async (sql: string, studioId: string, extra: unknown[] = []) => Number((await adminQuery(sql, [studioId, ...extra])).rows[0].n);

describe("two concurrent confirms of the same paste, both past their duplicate check (today's behaviour)", () => {
  it("clients WITH an email cannot twin: both passed the check, exactly one insert wins, the other is refused with a unique violation (23505), one client exists", async () => {
    const s = await seedStudio("hon77-import-emailed");
    const who = { name: "Synthetic Emailed", email: "synthetic-emailed@harness.local", dob: "1990-01-01" };
    const wait = barrier(2);
    const [a, b] = await Promise.all([confirm(s, who, wait), confirm(s, who, wait)]);
    expect([a.sawExisting, b.sawExisting]).toEqual([0, 0]); // the race window is real: neither saw the other's client
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect((a.ok ? b : a).code).toBe("23505");
    expect(await count(`select count(*) n from public.clients where studio_id = $1 and name = 'Synthetic Emailed'`, s.studioId)).toBe(1);
  });

  it("clients with NO email DO twin: both passed the check, both inserts succeed, two identical clients exist (no database backstop, the gap)", async () => {
    const s = await seedStudio("hon77-import-emailless");
    const who = { name: "Synthetic Emailless", email: null, dob: "1991-02-03" };
    const wait = barrier(2);
    const [a, b] = await Promise.all([confirm(s, who, wait), confirm(s, who, wait)]);
    expect([a.sawExisting, b.sawExisting]).toEqual([0, 0]);
    expect(a.ok && b.ok).toBe(true);
    expect(await count(`select count(*) n from public.clients where studio_id = $1 and name = 'Synthetic Emailless'`, s.studioId)).toBe(2);
  });

  it("each emailless confirm opens its OWN batch, so a concurrent pair leaves two batches, not one", async () => {
    const s = await seedStudio("hon77-import-batches");
    const before = await count(`select count(*) n from public.import_batches where studio_id = $1`, s.studioId);
    const wait = barrier(2);
    const who = { name: "Synthetic Batches", email: null, dob: null };
    await Promise.all([confirm(s, who, wait), confirm(s, who, wait)]);
    const after = await count(`select count(*) n from public.import_batches where studio_id = $1`, s.studioId);
    expect(after - before).toBe(2);
  });
});
