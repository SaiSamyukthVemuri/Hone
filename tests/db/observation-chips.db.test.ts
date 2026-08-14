import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  closePool,
  seedStudio,
  seedSession,
  type SeededStudio,
} from "./helpers/harness";
import { randomUUID } from "node:crypto";

// Migration 0108: electrolysis_entries.observation_chips is a jsonb array of
// canonical chip labels, default [] (legacy-safe), constrained to a JSON array.
// Free-text notes stay in `comments`. This exercises the REAL migrated DB:
// omitted → []; an array round-trips and comments are preserved alongside it;
// a non-array value is rejected by the CHECK.

let studio: SeededStudio;
let sessionId: string;
let blockId: string;

beforeAll(async () => {
  studio = await seedStudio("observation-chips");
  const s = await seedSession(studio);
  sessionId = s.sessionId;
  blockId = s.blockId;
});

afterAll(async () => {
  await closePool();
});

describe("electrolysis_entries.observation_chips (migration 0108)", () => {
  it("defaults to [] when not provided, legacy/additive rows stay valid", async () => {
    const id = randomUUID();
    await adminQuery(
      `insert into public.electrolysis_entries (id, session_id, block_id, area)
       values ($1, $2, $3, 'Chin')`,
      [id, sessionId, blockId],
    );
    const { rows } = await adminQuery(
      `select observation_chips from public.electrolysis_entries where id = $1`,
      [id],
    );
    expect(rows[0].observation_chips).toEqual([]);
  });

  it("stores a chip array and round-trips it; comments preserved separately (not overwritten)", async () => {
    const id = randomUUID();
    await adminQuery(
      `insert into public.electrolysis_entries
         (id, session_id, block_id, area, comments, observation_chips)
       values ($1, $2, $3, 'Lip', $4, $5::jsonb)`,
      [id, sessionId, blockId, "client was chatty", JSON.stringify(["Coarse hair", "Erythema"])],
    );
    const { rows } = await adminQuery(
      `select comments, observation_chips from public.electrolysis_entries where id = $1`,
      [id],
    );
    expect(rows[0].observation_chips).toEqual(["Coarse hair", "Erythema"]);
    expect(rows[0].comments).toBe("client was chatty");
  });

  it("rejects a non-array jsonb value via the array CHECK", async () => {
    await expect(
      adminQuery(
        `insert into public.electrolysis_entries (id, session_id, block_id, area, observation_chips)
         values ($1, $2, $3, 'Chin', '{}'::jsonb)`,
        [randomUUID(), sessionId, blockId],
      ),
    ).rejects.toThrow(/observation_chips_is_array/);
    await expect(
      adminQuery(
        `insert into public.electrolysis_entries (id, session_id, block_id, area, observation_chips)
         values ($1, $2, $3, 'Chin', '"nope"'::jsonb)`,
        [randomUUID(), sessionId, blockId],
      ),
    ).rejects.toThrow(/observation_chips_is_array/);
  });
});
