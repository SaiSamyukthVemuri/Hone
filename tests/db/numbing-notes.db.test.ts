import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  asUser,
  closePool,
  seedSession,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";

// Migration 0156 — conditional numbing notes, proven on the REAL migrated local
// database. The column is additive/nullable; the two atomic RPCs carry it; OLD
// app payloads that omit the key resolve it to NULL (DB-first safe). App-level
// "only when status = used" normalization is unit-tested separately.

let a: SeededStudio;

beforeAll(async () => {
  a = await seedStudio("numbing");
});
afterAll(async () => {
  await closePool();
});

async function rpcCreate(
  studio: SeededStudio,
  sessionId: string,
  block: Record<string, unknown>,
): Promise<string> {
  return asUser(studio.userId, async (q) => {
    const r = await q(
      `select public.create_session_block_with_areas($1,$2,$3::jsonb,$4::jsonb) as id`,
      [studio.studioId, sessionId, JSON.stringify(block), "[]"],
    );
    return r.rows[0].id as string;
  });
}

describe("numbing_notes column (additive, nullable)", () => {
  it("exists as nullable text with no default", async () => {
    const r = await adminQuery(
      "select is_nullable, data_type, column_default from information_schema.columns where table_name='session_blocks' and column_name='numbing_notes'",
    );
    expect(r.rows[0]).toMatchObject({
      is_nullable: "YES",
      data_type: "text",
      column_default: null,
    });
  });
});

describe("the atomic RPCs carry numbing_notes", () => {
  it("create_session_block_with_areas stores numbing_status + numbing_notes together", async () => {
    const { sessionId } = await seedSession(a);
    const id = await rpcCreate(a, sessionId, {
      numbing_status: "used",
      numbing_notes: "EMLA cream, 20 min",
    });
    const r = await adminQuery(
      "select numbing_status, numbing_notes from public.session_blocks where id=$1",
      [id],
    );
    expect(r.rows[0]).toMatchObject({
      numbing_status: "used",
      numbing_notes: "EMLA cream, 20 min",
    });
  });

  it("update_session_block_with_areas replaces numbing_notes", async () => {
    const { sessionId } = await seedSession(a);
    const id = await rpcCreate(a, sessionId, {
      numbing_status: "used",
      numbing_notes: "first note",
    });
    await asUser(a.userId, (q) =>
      q(
        `select public.update_session_block_with_areas($1,$2,$3,$4::jsonb,$5::jsonb,null)`,
        [a.studioId, sessionId, id, JSON.stringify({ numbing_status: "used", numbing_notes: "second note" }), "[]"],
      ),
    );
    const r = await adminQuery(
      "select numbing_notes from public.session_blocks where id=$1",
      [id],
    );
    expect(r.rows[0].numbing_notes).toBe("second note");
  });
});

describe("OLD-app payload compatibility (DB-first safe)", () => {
  it("create RPC omitting numbing_notes → NULL (no fabrication)", async () => {
    const { sessionId } = await seedSession(a);
    const oldPayload = { numbing_status: "used", primary_area: "Chin" };
    expect("numbing_notes" in oldPayload).toBe(false);
    const id = await rpcCreate(a, sessionId, oldPayload);
    const r = await adminQuery(
      "select numbing_status, numbing_notes from public.session_blocks where id=$1",
      [id],
    );
    expect(r.rows[0].numbing_status).toBe("used"); // existing behaviour intact
    expect(r.rows[0].numbing_notes).toBeNull(); // no note fabricated
  });

  it("update RPC omitting numbing_notes → NULL (old app clears to NULL, never invents)", async () => {
    const { sessionId } = await seedSession(a);
    const id = await rpcCreate(a, sessionId, { numbing_status: "used", numbing_notes: "will be cleared" });
    await asUser(a.userId, (q) =>
      q(
        `select public.update_session_block_with_areas($1,$2,$3,$4::jsonb,$5::jsonb,null)`,
        [a.studioId, sessionId, id, JSON.stringify({ numbing_status: "used", primary_area: "Chin" }), "[]"],
      ),
    );
    const r = await adminQuery(
      "select numbing_notes from public.session_blocks where id=$1",
      [id],
    );
    expect(r.rows[0].numbing_notes).toBeNull();
  });
});

describe("authorization + studio scoping unchanged", () => {
  it("a NON-member cannot create a block via the RPC (is_studio_member gate holds)", async () => {
    const b = await seedStudio("numbing-other");
    const { sessionId } = await seedSession(a);
    // Studio B's user attempts to write into studio A's session → rejected.
    await expect(
      asUser(b.userId, (q) =>
        q(
          `select public.create_session_block_with_areas($1,$2,$3::jsonb,$4::jsonb)`,
          [a.studioId, sessionId, JSON.stringify({ numbing_status: "used", numbing_notes: "x" }), "[]"],
        ),
      ),
    ).rejects.toThrow(/not authorized/i);
  });
});
