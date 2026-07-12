import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, closePool, seedSession, seedStudio } from "./helpers/harness";

// Emergency chip-loading fix — DB persistence for electrolysis_entries.observation_chips
// (LOCAL disposable Supabase only). Proves the structured column round-trips, the
// jsonb-array guard (0108) holds, and a legacy comments-only row keeps its data.

afterAll(async () => {
  await closePool();
});

async function insertEntry(
  studioId: string,
  sessionId: string,
  blockId: string,
  opts: { chipsJson?: string; comments?: string | null } = {},
): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.electrolysis_entries (id, session_id, block_id, area, areas, comments, observation_chips)
     values ($1,$2,$3,'Chin',array['Chin']::text[],$4, coalesce($5::jsonb, '[]'::jsonb))`,
    [id, sessionId, blockId, opts.comments ?? null, opts.chipsJson ?? null],
  );
  return id;
}

describe("observation_chips column persistence", () => {
  it("round-trips a structured chip array", async () => {
    const studio = await seedStudio("chipsA");
    const { sessionId, blockId } = await seedSession(studio);
    const id = await insertEntry(studio.studioId, sessionId, blockId, {
      chipsJson: JSON.stringify(["Coarse hair", "Slight edema", "Lots of anagen"]),
    });
    const r = await adminQuery("select observation_chips from public.electrolysis_entries where id=$1", [id]);
    expect(r.rows[0].observation_chips).toEqual(["Coarse hair", "Slight edema", "Lots of anagen"]);
  });

  it("defaults to [] (0108) when not provided — legacy rows stay valid", async () => {
    const studio = await seedStudio("chipsDefault");
    const { sessionId, blockId } = await seedSession(studio);
    const id = await insertEntry(studio.studioId, sessionId, blockId, { comments: "Coarse hair, tender near jaw" });
    const r = await adminQuery("select observation_chips, comments from public.electrolysis_entries where id=$1", [id]);
    expect(r.rows[0].observation_chips).toEqual([]); // legacy: chips live in comments, hydrated app-side
    expect(r.rows[0].comments).toBe("Coarse hair, tender near jaw"); // never destroyed
  });

  it("rejects a non-array observation_chips (0108 jsonb-array CHECK)", async () => {
    const studio = await seedStudio("chipsGuard");
    const { sessionId, blockId } = await seedSession(studio);
    await expect(
      adminQuery(
        `insert into public.electrolysis_entries (id, session_id, block_id, area, areas, observation_chips)
         values ($1,$2,$3,'Chin',array['Chin']::text[], '{"not":"an array"}'::jsonb)`,
        [randomUUID(), sessionId, blockId],
      ),
    ).rejects.toThrow();
  });

  it("an updated entry can gain chips without touching comments", async () => {
    const studio = await seedStudio("chipsUpdate");
    const { sessionId, blockId } = await seedSession(studio);
    const id = await insertEntry(studio.studioId, sessionId, blockId, { comments: "existing note" });
    await adminQuery(
      "update public.electrolysis_entries set observation_chips = $1::jsonb where id=$2",
      [JSON.stringify(["Coarse hair"]), id],
    );
    const r = await adminQuery("select observation_chips, comments from public.electrolysis_entries where id=$1", [id]);
    expect(r.rows[0].observation_chips).toEqual(["Coarse hair"]);
    expect(r.rows[0].comments).toBe("existing note");
  });
});
