import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  adminQuery,
  closePool,
  seedSession,
  seedStudio,
  userQuery,
  type SeededStudio,
} from "./helpers/harness";

// ===========================================================================
// Clinical Record — Phase 2 (migration 0120): corrections & amendments.
// Behavioral proof against the REAL migrated local DB. Proves: amendments are
// append-only + additive (never touch the original), corrections create an
// immutable version N+1 atomically (supersede chain, single record_version bump,
// CAS, one-winner concurrency), the NARROW session-scoped correction permit lets
// ONLY the trusted RPC write frozen rows (service-role/direct writes stay blocked,
// GUC auto-resets, no cross-session leak), late photos attach via the amendment
// path, and cross-tenant isolation holds.
// ===========================================================================

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

// A finalized, corrections-enabled session owned by the studio owner.
async function seedFinalized(): Promise<{
  studio: SeededStudio;
  sessionId: string;
  blockId: string;
  entryId: string;
  snapV1: string;
}> {
  const studio = await seedStudio("cc");
  await adminQuery(
    "update public.studios set clinical_finalization_enabled=true, clinical_corrections_enabled=true where id=$1",
    [studio.studioId],
  );
  const { sessionId, blockId } = await seedSession(studio);
  const entryId = await addEntry(sessionId, blockId);
  const fin = await userQuery(
    studio.userId,
    "select * from public.finalize_session($1,$2)",
    [sessionId, 1],
  );
  return { studio, sessionId, blockId, entryId, snapV1: fin.rows[0].snapshot_id as string };
}

async function amend(
  userId: string,
  sessionId: string,
  snapshotId: string,
  type: string,
  reason: string,
  body: string | null,
) {
  const r = await userQuery(
    userId,
    "select * from public.amend_finalized_session($1,$2,$3,$4,$5,$6::jsonb)",
    [sessionId, snapshotId, type, reason, body, null],
  );
  return r.rows[0];
}

async function correct(
  userId: string,
  sessionId: string,
  expected: number,
  reason: string,
  payload: unknown,
) {
  const r = await userQuery(
    userId,
    "select * from public.correct_finalized_session($1,$2,$3,$4::jsonb)",
    [sessionId, expected, reason, JSON.stringify(payload)],
  );
  return r.rows[0];
}

// ---------------------------------------------------------------------------
describe("0120 — amendments (append-only, additive)", () => {
  it("a same-studio amendment succeeds and does NOT change the original or version", async () => {
    const { studio, sessionId, snapV1 } = await seedFinalized();
    const before = await adminQuery(
      "select record_version, current_snapshot_id, (select content_hash from public.clinical_record_snapshots where id=$1) as h from public.sessions where id=$2",
      [snapV1, sessionId],
    );
    const a = await amend(studio.userId, sessionId, snapV1, "late_note", "forgot a note", "left cheek stung more");
    expect(a.content_hash).toMatch(/^[0-9a-f]{64}$/);
    const after = await adminQuery(
      "select record_version, current_snapshot_id, (select content_hash from public.clinical_record_snapshots where id=$1) as h, (select count(*)::int from public.clinical_record_snapshots where session_id=$2) as n from public.sessions where id=$2",
      [snapV1, sessionId],
    );
    // Version + snapshot pointer + original hash + snapshot count all unchanged.
    expect(after.rows[0].record_version).toBe(before.rows[0].record_version);
    expect(after.rows[0].current_snapshot_id).toBe(before.rows[0].current_snapshot_id);
    expect(after.rows[0].h).toBe(before.rows[0].h);
    expect(after.rows[0].n).toBe(1);
  });

  it("rejects a missing reason, an invalid type, and empty content", async () => {
    const { studio, sessionId, snapV1 } = await seedFinalized();
    await expect(amend(studio.userId, sessionId, snapV1, "late_note", "  ", "body")).rejects.toThrow(/reason/i);
    await expect(amend(studio.userId, sessionId, snapV1, "bogus", "reason", "body")).rejects.toThrow();
    await expect(amend(studio.userId, sessionId, snapV1, "late_note", "reason", null)).rejects.toThrow(/content/i);
  });

  it("rejects a cross-studio caller and an inactive practitioner", async () => {
    const { studio, sessionId, snapV1 } = await seedFinalized();
    const other = await seedStudio("cc-other");
    await adminQuery("update public.studios set clinical_corrections_enabled=true where id=$1", [other.studioId]);
    await expect(amend(other.userId, sessionId, snapV1, "late_note", "r", "b")).rejects.toThrow(/not found or not accessible/i);
    await adminQuery("update public.practitioners set active=false where id=$1", [studio.practitionerId]);
    await expect(amend(studio.userId, sessionId, snapV1, "late_note", "r", "b")).rejects.toThrow();
  });

  it("rejects when the Phase-2 flag is OFF", async () => {
    const { studio, sessionId, snapV1 } = await seedFinalized();
    await adminQuery("update public.studios set clinical_corrections_enabled=false where id=$1", [studio.studioId]);
    await expect(amend(studio.userId, sessionId, snapV1, "late_note", "r", "b")).rejects.toThrow(/not enabled/i);
  });

  it("amendment rows are append-only: no direct INSERT/UPDATE/DELETE (member or service-role)", async () => {
    const { studio, sessionId, snapV1 } = await seedFinalized();
    const a = await amend(studio.userId, sessionId, snapV1, "clarification", "r", "b");
    // Direct member INSERT/UPDATE/DELETE.
    await expect(
      userQuery(studio.userId, "insert into public.clinical_record_amendments (studio_id,session_id,applies_to_snapshot_id,amendment_type,reason,authored_by,content_hash) values ($1,$2,$3,'other','x',$4,'h')", [studio.studioId, sessionId, snapV1, studio.practitionerId]),
    ).rejects.toThrow();
    await expect(userQuery(studio.userId, "update public.clinical_record_amendments set reason='z' where id=$1", [a.amendment_id])).rejects.toThrow();
    await expect(userQuery(studio.userId, "delete from public.clinical_record_amendments where id=$1", [a.amendment_id])).rejects.toThrow();
    // Service-role UPDATE/DELETE also blocked by the append-only trigger.
    await expect(adminQuery("update public.clinical_record_amendments set reason='z' where id=$1", [a.amendment_id])).rejects.toThrow();
    await expect(adminQuery("delete from public.clinical_record_amendments where id=$1", [a.amendment_id])).rejects.toThrow();
  });

  it("amendment content hash is deterministic; identical amendments append (not idempotent)", async () => {
    const { studio, sessionId, snapV1 } = await seedFinalized();
    const a1 = await amend(studio.userId, sessionId, snapV1, "late_note", "same", "same body");
    const a2 = await amend(studio.userId, sessionId, snapV1, "late_note", "same", "same body");
    expect(a2.content_hash).toBe(a1.content_hash); // deterministic
    expect(a2.amendment_id).not.toBe(a1.amendment_id); // append-only, two distinct rows
    const n = await adminQuery("select count(*)::int as n from public.clinical_record_amendments where session_id=$1", [sessionId]);
    expect(n.rows[0].n).toBe(2);
  });
});

describe("0120 — corrections (immutable version N -> N+1)", () => {
  it("creates version 2: record_version=2, snapshot v2 once, current points to v2, v1 unchanged, supersede chain", async () => {
    const { studio, sessionId, snapV1 } = await seedFinalized();
    const v1hash = (await adminQuery("select content_hash from public.clinical_record_snapshots where id=$1", [snapV1])).rows[0].content_hash;
    const r = await correct(studio.userId, sessionId, 1, "wrong note", { session: { session_notes: "corrected value" } });
    expect(r.new_version).toBe(2);
    const s = await adminQuery("select record_version, current_snapshot_id, session_notes from public.sessions where id=$1", [sessionId]);
    expect(s.rows[0].record_version).toBe(2);
    expect(s.rows[0].current_snapshot_id).toBe(r.snapshot_id);
    // Normalized corrected value applied.
    expect(s.rows[0].session_notes).toBe("corrected value");
    const snaps = await adminQuery("select id, version_no, version_type, supersedes_snapshot_id, signed, corrected_by, (snapshot->'session'->>'session_notes') as note, content_hash from public.clinical_record_snapshots where session_id=$1 order by version_no", [sessionId]);
    expect(snaps.rows).toHaveLength(2);
    // v1 immutable.
    expect(snaps.rows[0].version_no).toBe(1);
    expect(snaps.rows[0].version_type).toBe("original");
    expect(snaps.rows[0].content_hash).toBe(v1hash);
    // v2 correction, supersedes v1, signed, corrected_by set, snapshot reflects the new value.
    expect(snaps.rows[1].version_no).toBe(2);
    expect(snaps.rows[1].version_type).toBe("correction");
    expect(snaps.rows[1].supersedes_snapshot_id).toBe(snapV1);
    expect(snaps.rows[1].signed).toBe(true);
    expect(snaps.rows[1].corrected_by).toBe(studio.practitionerId);
    expect(snaps.rows[1].note).toBe("corrected value"); // normalized == snapshot v2
    // Session remains finalized.
    const st = await adminQuery("select record_status from public.sessions where id=$1", [sessionId]);
    expect(st.rows[0].record_status).toBe("finalized");
  });

  it("requires a reason and a compare-and-set match (stale version rejected)", async () => {
    const { studio, sessionId } = await seedFinalized();
    await expect(correct(studio.userId, sessionId, 1, "  ", { session: { session_notes: "x" } })).rejects.toThrow(/reason/i);
    await expect(correct(studio.userId, sessionId, 99, "r", { session: { session_notes: "x" } })).rejects.toThrow(/version conflict/i);
    // A successful correction moves to v2; a second attempt at expected=1 now conflicts.
    await correct(studio.userId, sessionId, 1, "r", { session: { session_notes: "x" } });
    await expect(correct(studio.userId, sessionId, 1, "r2", { session: { session_notes: "y" } })).rejects.toThrow(/version conflict/i);
  });

  it("rejects arbitrary / disallowed field mutation and cross-studio + inactive callers", async () => {
    const { studio, sessionId } = await seedFinalized();
    // Disallowed field in the typed payload.
    await expect(correct(studio.userId, sessionId, 1, "r", { session: { studio_id: randomUUID() } })).rejects.toThrow();
    await expect(correct(studio.userId, sessionId, 1, "r", { bogus_section: {} })).rejects.toThrow(/payload section/i);
    const other = await seedStudio("cc-x");
    await adminQuery("update public.studios set clinical_corrections_enabled=true where id=$1", [other.studioId]);
    await expect(correct(other.userId, sessionId, 1, "r", { session: { session_notes: "z" } })).rejects.toThrow(/not found or not accessible/i);
  });

  it("two concurrent corrections at expected=1 produce exactly one v2", async () => {
    const { studio, sessionId } = await seedFinalized();
    const res = await Promise.allSettled([
      correct(studio.userId, sessionId, 1, "a", { session: { session_notes: "a" } }),
      correct(studio.userId, sessionId, 1, "b", { session: { session_notes: "b" } }),
    ]);
    const ok = res.filter((r) => r.status === "fulfilled").length;
    expect(ok).toBe(1); // one winner; the other hits the version conflict
    const n = await adminQuery("select count(*)::int as n, max(record_version) as v from public.clinical_record_snapshots s join public.sessions se on se.id=s.session_id where s.session_id=$1", [sessionId]);
    expect(n.rows[0].n).toBe(2); // v1 + one v2
  });

  it("a failed correction leaves NO partial normalized change (rollback) and record still finalized", async () => {
    const { studio, sessionId } = await seedFinalized();
    const before = (await adminQuery("select session_notes from public.sessions where id=$1", [sessionId])).rows[0].session_notes;
    // Payload: a valid session change + an invalid block id -> the whole tx must roll back.
    await expect(
      correct(studio.userId, sessionId, 1, "r", {
        session: { session_notes: "should not persist" },
        blocks: [{ id: randomUUID(), primary_area: "x" }],
      }),
    ).rejects.toThrow();
    const after = await adminQuery("select session_notes, record_version, record_status, (select count(*)::int from public.clinical_record_snapshots where session_id=$1) as n from public.sessions where id=$1", [sessionId]);
    expect(after.rows[0].session_notes).toBe(before); // no partial change
    expect(after.rows[0].record_version).toBe(1);
    expect(after.rows[0].record_status).toBe("finalized");
    expect(after.rows[0].n).toBe(1); // no v2 snapshot
  });
});

describe("0120 — narrow bypass: only the trusted RPC can write frozen rows", () => {
  it("Phase-1 direct writes remain blocked even with corrections enabled (member AND service-role)", async () => {
    const { studio, sessionId } = await seedFinalized();
    await expect(userQuery(studio.userId, "update public.sessions set session_notes='hack' where id=$1", [sessionId])).rejects.toThrow();
    await expect(adminQuery("update public.sessions set session_notes='hack' where id=$1", [sessionId])).rejects.toThrow();
    // The frozen value is unchanged.
    const s = await adminQuery("select session_notes from public.sessions where id=$1", [sessionId]);
    expect(s.rows[0].session_notes).not.toBe("hack");
  });

  it("the correction GUC auto-resets: after a correction commits, direct finalized writes are still blocked", async () => {
    const { studio, sessionId } = await seedFinalized();
    await correct(studio.userId, sessionId, 1, "r", { session: { session_notes: "v2" } });
    // The permit is transaction-local; a subsequent direct write must still be frozen.
    await expect(adminQuery("update public.sessions set session_notes='after' where id=$1", [sessionId])).rejects.toThrow();
    await expect(adminQuery("update public.electrolysis_entries set area='after' where session_id=$1", [sessionId])).rejects.toThrow();
  });

  it("correcting session A does not permit writes to a different finalized session B", async () => {
    const a = await seedFinalized();
    const b = await seedFinalized();
    // Even mid-correcting A's studio, B (different session/studio) stays frozen to direct writes.
    await correct(a.studio.userId, a.sessionId, 1, "r", { session: { session_notes: "A2" } });
    await expect(adminQuery("update public.sessions set session_notes='leak' where id=$1", [b.sessionId])).rejects.toThrow();
  });
});

describe("0120 — late-photo amendment + cross-tenant isolation", () => {
  async function lastArg(userId: string, sessionId: string, snapshotId: string, studio: SeededStudio) {
    return userQuery(
      userId,
      "select * from public.amend_finalized_session_with_image($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [
        sessionId, snapshotId, "post-visit photo", "treatment-images",
        `${studio.studioId}/${studio.clientId}/${randomUUID()}.jpg`, "image/jpeg", 10, "late.jpg", null, null,
      ],
    );
  }

  it("attaches a late photo to a finalized session via the amendment path (direct insert stays blocked)", async () => {
    const { studio, sessionId, snapV1 } = await seedFinalized();
    // Direct finalized image insert is rejected.
    await expect(
      adminQuery(
        "insert into public.treatment_images (studio_id,client_id,session_id,storage_bucket,storage_path,content_type,size_bytes) values ($1,$2,$3,'treatment-images',$4,'image/jpeg',10)",
        [studio.studioId, studio.clientId, sessionId, `${studio.studioId}/${studio.clientId}/${randomUUID()}.jpg`],
      ),
    ).rejects.toThrow();
    // Amendment path succeeds.
    const r = (await lastArg(studio.userId, sessionId, snapV1, studio)).rows[0];
    expect(r.image_id).toBeTruthy();
    // Image is attached to the finalized session; amendment references it.
    const img = await adminQuery("select session_id from public.treatment_images where id=$1", [r.image_id]);
    expect(img.rows[0].session_id).toBe(sessionId);
    const am = await adminQuery("select linked_entity_type, linked_entity_id, amendment_type from public.clinical_record_amendments where id=$1", [r.amendment_id]);
    expect(am.rows[0]).toMatchObject({ linked_entity_type: "treatment_image", linked_entity_id: r.image_id, amendment_type: "photo" });
    // Original v1 snapshot unchanged (still 1 snapshot; no version bump for an amendment).
    const s = await adminQuery("select record_version, (select count(*)::int from public.clinical_record_snapshots where session_id=$1) as n from public.sessions where id=$1", [sessionId]);
    expect(s.rows[0]).toMatchObject({ record_version: 1, n: 1 });
  });

  it("Studio B cannot read Studio A's amendments, audit events, or snapshot versions", async () => {
    const a = await seedFinalized();
    await amend(a.studio.userId, a.sessionId, a.snapV1, "late_note", "r", "b");
    await correct(a.studio.userId, a.sessionId, 1, "r", { session: { session_notes: "x" } });
    const b = await seedStudio("cc-reader");
    for (const t of ["clinical_record_amendments", "clinical_audit_events", "clinical_record_snapshots"]) {
      const rows = await userQuery(b.userId, `select id from public.${t} where session_id=$1`, [a.sessionId]);
      expect(rows.rows, t).toHaveLength(0);
    }
  });
});
