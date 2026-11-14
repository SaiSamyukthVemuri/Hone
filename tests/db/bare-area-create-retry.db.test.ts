import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

import { adminQuery, asUser, closePool, seedSession, seedStudio, type SeededStudio } from "./helpers/harness";

// ===========================================================================
// A LOST-ANSWER RETRY OF A BARE (SETTINGS-FREE) AREA SAVE MAKES ONE AREA.
//
// Photos R2 (#1369) found that pressing Save again after a lost answer created a SECOND area when nothing machine-related was
// typed: a bare create was unkeyed, so nothing recognised the retry. The same is true on production before #1369. 0223's create
// claim already takes a key with NO groups; these cases prove that is enough, and that deliberate second areas still work.
// ===========================================================================

afterAll(async () => {
  await closePool();
});

const XCELL = "dectro-apilus:xcell";
const SQL = `select public.create_block_with_initial_setup_and_identity(
  $1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6,$7,$8::text[],$9,$10,$11,$12,$13,$14,
  $15::jsonb,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,
  $27,$28,$29,$30::jsonb,$31) as r`;

async function bare(studio: SeededStudio, sessionId: string, over: { key?: string | null; area?: string; profile?: string | null } = {}) {
  return asUser(studio.userId, async (q) => {
    const args: unknown[] = [
      sessionId,
      studio.clientId,
      JSON.stringify({ block_name: "Bare", primary_area: over.area ?? "jaw" }),
      JSON.stringify({}),
      JSON.stringify([]),
      false,
      ...Array(20).fill(null),
      null, // p_studio_machine_id
      null, // p_setup_mode_key
      over.key ?? null,
      JSON.stringify([]),
      over.profile ?? null,
    ];
    return (await q(SQL, args)).rows[0].r as { block_id: string; reused?: boolean };
  });
}

const count = async (sessionId: string) =>
  (await adminQuery(`select count(*)::int as n from public.session_blocks where session_id=$1 and deleted_at is null`, [sessionId])).rows[0].n as number;

describe("a bare area save carries a retry key", () => {
  it("the same key and payload twice (a lost answer, then Save again) is ONE area, the second answer says reused", async () => {
    const studio = await seedStudio("bare-retry");
    const { sessionId } = await seedSession(studio);
    const base = await count(sessionId); // seedSession already creates a block: measure deltas
    const key = randomUUID();
    const first = await bare(studio, sessionId, { key });
    const second = await bare(studio, sessionId, { key });
    expect(second.block_id).toBe(first.block_id);
    expect(second.reused).toBe(true);
    expect((await count(sessionId)) - base).toBe(1);
  });

  it("the xCell Pur choice (identity only, no settings) is absorbed the same way, and keeps its identity", async () => {
    const studio = await seedStudio("bare-retry-xcell");
    const { sessionId } = await seedSession(studio);
    const base = await count(sessionId); // seedSession already creates a block: measure deltas
    const key = randomUUID();
    const first = await bare(studio, sessionId, { key, profile: XCELL });
    const second = await bare(studio, sessionId, { key, profile: XCELL });
    expect(second.block_id).toBe(first.block_id);
    expect((await count(sessionId)) - base).toBe(1);
    const row = await adminQuery(`select machine_profile_id from public.session_blocks where id=$1`, [first.block_id]);
    expect(row.rows[0].machine_profile_id).toBe(XCELL);
  });

  it("a DIFFERENT key is a deliberate second area (two areas)", async () => {
    const studio = await seedStudio("bare-retry-two");
    const { sessionId } = await seedSession(studio);
    const base = await count(sessionId); // seedSession already creates a block: measure deltas
    await bare(studio, sessionId, { key: randomUUID() });
    await bare(studio, sessionId, { key: randomUUID() });
    expect((await count(sessionId)) - base).toBe(2);
  });

  it("the same key with a DIFFERENT payload is refused by name, not turned into a second area", async () => {
    const studio = await seedStudio("bare-retry-mismatch");
    const { sessionId } = await seedSession(studio);
    const base = await count(sessionId); // seedSession already creates a block: measure deltas
    const key = randomUUID();
    await bare(studio, sessionId, { key, area: "jaw" });
    await expect(bare(studio, sessionId, { key, area: "chin" })).rejects.toThrow(/different treatment area/i);
    expect((await count(sessionId)) - base).toBe(1);
  });

  it("NEGATIVE CONTROL (the defect): with NO key the same call twice makes TWO areas", async () => {
    const studio = await seedStudio("bare-retry-unkeyed");
    const { sessionId } = await seedSession(studio);
    const base = await count(sessionId); // seedSession already creates a block: measure deltas
    await bare(studio, sessionId);
    await bare(studio, sessionId);
    expect((await count(sessionId)) - base).toBe(2);
  });
});

// ===========================================================================
// INSURANCE N-1: THE 0223 FALLBACK (0301 NOT APPLIED, or rolled back).
//
// The action falls back to 0223's create_block_with_initial_setup, the SAME command the 0301 wrapper delegates to, when the
// wrapper does not exist. That 0223 takes a key with an EMPTY settings half was only asserted in a comment. These cases call the
// 0223 command directly with exactly the fallback's arguments (the wrapper's, minus p_machine_profile_id), so they prove it for the
// no-0301 path: this local chain has 0301, but nothing here touches a 0301 object, column or the wrapper.
// ===========================================================================
const SQL_0223 = `select public.create_block_with_initial_setup(
  $1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6,$7,$8::text[],$9,$10,$11,$12,$13,$14,
  $15::jsonb,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,
  $27,$28,$29,$30::jsonb) as r`;

async function bare0223(studio: SeededStudio, sessionId: string, key: string | null, area = "jaw") {
  return asUser(studio.userId, async (q) => {
    const args: unknown[] = [
      sessionId,
      studio.clientId,
      JSON.stringify({ block_name: "Bare", primary_area: area }),
      JSON.stringify({}),
      JSON.stringify([]),
      false,
      ...Array(20).fill(null),
      null,
      null,
      key,
      JSON.stringify([]),
    ];
    return (await q(SQL_0223, args)).rows[0].r as { block_id: string; reused?: boolean };
  });
}

describe("the 0223 fallback takes a key with no settings (no 0301 object involved)", () => {
  it("a keyed bare create works, and a same-key retry returns the same area (no duplicate)", async () => {
    const studio = await seedStudio("bare-0223");
    const { sessionId } = await seedSession(studio);
    const base = await count(sessionId);
    const key = randomUUID();
    const first = await bare0223(studio, sessionId, key);
    expect(first.block_id).toBeTruthy();
    const second = await bare0223(studio, sessionId, key);
    expect(second.block_id).toBe(first.block_id);
    expect(second.reused).toBe(true);
    expect((await count(sessionId)) - base).toBe(1);
  });

  it("NEGATIVE CONTROL: with no key the same retry makes a second area", async () => {
    const studio = await seedStudio("bare-0223-nokey");
    const { sessionId } = await seedSession(studio);
    const base = await count(sessionId);
    await bare0223(studio, sessionId, null);
    await bare0223(studio, sessionId, null);
    expect((await count(sessionId)) - base).toBe(2);
  });

  it("the same key with a different payload is refused, not merged", async () => {
    const studio = await seedStudio("bare-0223-diff");
    const { sessionId } = await seedSession(studio);
    const key = randomUUID();
    await bare0223(studio, sessionId, key, "jaw");
    await expect(bare0223(studio, sessionId, key, "chin")).rejects.toThrow(/different treatment area/);
  });
});
