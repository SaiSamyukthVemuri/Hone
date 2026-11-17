import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, closePool, seedStudio, userQuery, type SeededStudio } from "./helpers/harness";

// HON-77 (imports). Two operators confirm the SAME paste at the same moment. The action plans from a snapshot of existing clients and then inserts, with no
// lock between, so both plans say "create". This models exactly that write sequence through the owner's RLS-backed connection (the action's own path) from
// two concurrent connections, and records what the DATABASE does with the pair. Named for TODAY's behaviour: when a backstop lands, the emailless test is
// the one that flips on purpose. Synthetic data only; one fresh studio.
let s: SeededStudio;
beforeAll(async () => {
  s = await seedStudio("hon77-import-concurrent");
});
afterAll(async () => {
  await closePool();
});

const importOnce = async (client: { name: string; email: string | null; dob: string | null }) => {
  const batchId = randomUUID();
  await userQuery(
    s.userId,
    `insert into public.import_batches (id, studio_id, source_type, source_label, row_count, created_by) values ($1, $2, 'other', 'CSV/TSV import', 1, $3)`,
    [batchId, s.studioId, s.userId],
  );
  try {
    await userQuery(s.userId, `insert into public.clients (studio_id, name, email, date_of_birth) values ($1, $2, $3, $4)`, [s.studioId, client.name, client.email, client.dob]);
    return { ok: true as const, batchId };
  } catch (e) {
    return { ok: false as const, batchId, code: String((e as { code?: string }).code ?? "") };
  }
};
const countClients = async (name: string) => Number((await adminQuery(`select count(*) n from public.clients where studio_id = $1 and name = $2`, [s.studioId, name])).rows[0].n);
const countBatches = async () => Number((await adminQuery(`select count(*) n from public.import_batches where studio_id = $1`, [s.studioId])).rows[0].n);

describe("two concurrent confirms of the same paste (today's behaviour)", () => {
  it("clients WITH an email cannot twin: exactly one insert wins, the other is refused with a unique violation (23505), one client exists", async () => {
    const who = { name: "Synthetic Emailed", email: "synthetic-emailed@harness.local", dob: "1990-01-01" };
    const [a, b] = await Promise.all([importOnce(who), importOnce(who)]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const loser = a.ok ? b : a;
    expect(loser.ok === false && loser.code).toBe("23505");
    expect(await countClients(who.name)).toBe(1);
  });

  it("clients with NO email DO twin: both inserts succeed, so two identical clients exist (no database backstop, the gap)", async () => {
    const who = { name: "Synthetic Emailless", email: null, dob: "1991-02-03" };
    const [a, b] = await Promise.all([importOnce(who), importOnce(who)]);
    expect(a.ok && b.ok).toBe(true);
    expect(await countClients(who.name)).toBe(2);
  });

  it("each concurrent confirm opens its OWN batch, so a concurrent pair leaves two batches, not one", async () => {
    expect(await countBatches()).toBe(4); // two per test above
  });
});
