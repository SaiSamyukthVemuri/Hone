import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  seedLegacyRecordStatus,
  adminQuery,
  closePool,
  seedSession,
  seedStudio,
  userQuery,
  type SeededStudio,
} from "./helpers/harness";

// Willow P1-B: the soft_delete_session_area RPC (migration 0123) removes a whole
// treatment AREA from a DRAFT chart in ONE atomic soft-delete transaction, the
// block + its block-scoped passes + its block-scoped images, never a hard
// delete, finalized-safe, same-studio only, fully audited.

afterAll(async () => {
  await closePool();
});

async function addEntry(sessionId: string, blockId: string): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    "insert into public.electrolysis_entries (id, session_id, area, block_id) values ($1,$2,'chin',$3)",
    [id, sessionId, blockId],
  );
  return id;
}

async function addImage(studio: SeededStudio, sessionId: string, blockId: string): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.treatment_images
       (id, studio_id, client_id, session_id, session_block_id, storage_path, content_type, size_bytes)
     values ($1,$2,$3,$4,$5,$6,'image/jpeg',1024)`,
    [
      id,
      studio.studioId,
      studio.clientId,
      sessionId,
      blockId,
      // Must match treatment_images_path_shape_chk: <studio_id>/<client_id>/<file>.
      `${studio.studioId}/${studio.clientId}/${id}.jpg`,
    ],
  );
  return id;
}

async function removeArea(userId: string, sessionId: string, blockId: string, reason: string) {
  const r = await userQuery(
    userId,
    "select * from public.soft_delete_session_area($1,$2,$3)",
    [sessionId, blockId, reason],
  );
  return r.rows[0];
}

describe("soft_delete_session_area: aggregate soft-delete", () => {
  it("removes an empty draft area: block soft-deleted, row preserved", async () => {
    const studio = await seedStudio("areaEmpty");
    const { sessionId, blockId } = await seedSession(studio);

    const res = await removeArea(studio.userId, sessionId, blockId, "recorded on the wrong client");
    expect(Number(res.entries_removed)).toBe(0);
    expect(Number(res.images_removed)).toBe(0);

    const block = await adminQuery(
      "select deleted_at, deleted_by, delete_reason from public.session_blocks where id = $1",
      [blockId],
    );
    expect(block.rowCount).toBe(1); // preserved, not hard-deleted
    expect(block.rows[0].deleted_at).not.toBeNull();
    expect(block.rows[0].delete_reason).toMatch(/wrong client/);
  });

  it("removes an area WITH children atomically, passes + images soft-deleted, none orphaned", async () => {
    const studio = await seedStudio("areaChildren");
    const { sessionId, blockId } = await seedSession(studio);
    const e1 = await addEntry(sessionId, blockId);
    const e2 = await addEntry(sessionId, blockId);
    const img = await addImage(studio, sessionId, blockId);

    const res = await removeArea(studio.userId, sessionId, blockId, "duplicate area entered twice");
    expect(Number(res.entries_removed)).toBe(2);
    expect(Number(res.images_removed)).toBe(1);

    // Every child is soft-deleted (deleted_at set), none left active/orphaned.
    const entries = await adminQuery(
      "select count(*) filter (where deleted_at is null) as active from public.electrolysis_entries where id in ($1,$2)",
      [e1, e2],
    );
    expect(Number(entries.rows[0].active)).toBe(0);
    const image = await adminQuery(
      "select deleted_at from public.treatment_images where id = $1",
      [img],
    );
    expect(image.rows[0].deleted_at).not.toBeNull();
    // History preserved.
    const stillThere = await adminQuery(
      "select count(*)::int as n from public.electrolysis_entries where id in ($1,$2)",
      [e1, e2],
    );
    expect(stillThere.rows[0].n).toBe(2);
  });

  it("writes an area_removed audit event", async () => {
    const studio = await seedStudio("areaAudit");
    const { sessionId, blockId } = await seedSession(studio);
    await removeArea(studio.userId, sessionId, blockId, "wrong area selected");
    const audit = await adminQuery(
      "select field, new_value from public.session_audit where session_id = $1 and field = 'area_removed'",
      [sessionId],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].new_value).toMatch(/wrong area/);
  });

  it("reduces two duplicate areas to one active area", async () => {
    const studio = await seedStudio("areaDup");
    const { sessionId, blockId } = await seedSession(studio);
    const block2 = randomUUID();
    await adminQuery(
      "insert into public.session_blocks (id, studio_id, session_id) values ($1,$2,$3)",
      [block2, studio.studioId, sessionId],
    );
    await removeArea(studio.userId, sessionId, block2, "second area is a duplicate of the first");
    const active = await adminQuery(
      "select count(*)::int as n from public.session_blocks where session_id = $1 and deleted_at is null",
      [sessionId],
    );
    expect(active.rows[0].n).toBe(1);
  });

  it("rejects a short reason", async () => {
    const studio = await seedStudio("areaReason");
    const { sessionId, blockId } = await seedSession(studio);
    await expect(removeArea(studio.userId, sessionId, blockId, "oops")).rejects.toThrow();
  });

  it("rejects removal of a FINALIZED record", async () => {
    const studio = await seedStudio("areaFinal");
    const { sessionId, blockId } = await seedSession(studio);
    // 0159 retired the finalized lifecycle; build the legacy state owner-only.
    await seedLegacyRecordStatus(sessionId, "finalized");
    await expect(
      removeArea(studio.userId, sessionId, blockId, "trying to remove a finalized area"),
    ).rejects.toThrow();
    // The block is untouched.
    const block = await adminQuery("select deleted_at from public.session_blocks where id = $1", [blockId]);
    expect(block.rows[0].deleted_at).toBeNull();
  });

  it("rejects a cross-studio removal (another studio cannot remove this area)", async () => {
    const a = await seedStudio("areaIsoA");
    const b = await seedStudio("areaIsoB");
    const { sessionId, blockId } = await seedSession(a);
    await expect(
      removeArea(b.userId, sessionId, blockId, "cross-studio removal attempt"),
    ).rejects.toThrow();
    const block = await adminQuery("select deleted_at from public.session_blocks where id = $1", [blockId]);
    expect(block.rows[0].deleted_at).toBeNull();
  });
});
