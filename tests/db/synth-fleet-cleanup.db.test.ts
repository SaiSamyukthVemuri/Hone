import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, closePool } from "./helpers/harness";
import {
  dropSynthStudio,
  seedSynthStudioA,
  seedSynthStudioB,
} from "./helpers/synth-fleet";

// Proves the SAFE-SYNTH cleanup contract instead of asserting it:
//  (1) dropSynthStudio leaves ZERO residual rows across every table the fleet
//      touches, studios, practitioners, clients, and auth.users;
//  (2) dropping Studio A cannot delete any Studio B row.
// db-integration lane, real migrated schema.

afterAll(async () => {
  await closePool();
});

async function count(sql: string, params: unknown[]): Promise<number> {
  const r = await adminQuery(sql, params);
  return Number(r.rows[0].n);
}

describe("dropSynthStudio removes every seeded row (no residue)", () => {
  it("zero residual rows across studios/practitioners/clients/auth.users", async () => {
    const A = await seedSynthStudioA();
    const userIds = A.practitioners.map((p) => p.userId);

    // Ground truth BEFORE drop: rows exist.
    expect(await count(`select count(*) n from public.studios where id = $1`, [A.studioId])).toBe(1);
    expect(
      await count(`select count(*) n from public.practitioners where studio_id = $1`, [A.studioId]),
    ).toBe(1);
    expect(
      await count(`select count(*) n from public.clients where studio_id = $1`, [A.studioId]),
    ).toBe(1);
    expect(
      await count(`select count(*) n from auth.users where id = any($1::uuid[])`, [userIds]),
    ).toBe(userIds.length);

    await dropSynthStudio(A);

    // AFTER drop: zero residue everywhere the fleet wrote.
    expect(await count(`select count(*) n from public.studios where id = $1`, [A.studioId])).toBe(0);
    expect(
      await count(`select count(*) n from public.practitioners where studio_id = $1`, [A.studioId]),
    ).toBe(0);
    expect(
      await count(`select count(*) n from public.clients where studio_id = $1`, [A.studioId]),
    ).toBe(0);
    expect(
      await count(`select count(*) n from auth.users where id = any($1::uuid[])`, [userIds]),
    ).toBe(0);
  });
});

describe("dropping Studio A cannot touch Studio B", () => {
  it("leaves every Studio B row intact", async () => {
    const A = await seedSynthStudioA();
    const B = await seedSynthStudioB();
    const bUserIds = B.practitioners.map((p) => p.userId);

    await dropSynthStudio(A);

    expect(await count(`select count(*) n from public.studios where id = $1`, [B.studioId])).toBe(1);
    expect(
      await count(`select count(*) n from public.practitioners where studio_id = $1`, [B.studioId]),
    ).toBe(3);
    expect(
      await count(`select count(*) n from public.clients where studio_id = $1`, [B.studioId]),
    ).toBe(1);
    expect(
      await count(`select count(*) n from auth.users where id = any($1::uuid[])`, [bUserIds]),
    ).toBe(bUserIds.length);

    await dropSynthStudio(B); // clean up B too
  });
});
