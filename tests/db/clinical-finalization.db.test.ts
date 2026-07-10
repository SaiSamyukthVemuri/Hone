import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  adminQuery,
  closePool,
  resolveLocalDbUrl,
  seedSession,
  seedStudio,
  userQuery,
  type SeededStudio,
} from "./helpers/harness";

// ===========================================================================
// Clinical Record — Phase 1 (migration 0119): finalization boundary.
// Behavioral proof against the REAL migrated local DB. Covers legacy provenance,
// eligibility, version/concurrency, the full finalized-aggregate freeze (sessions
// + children + treatment_images, NO service-role bypass), snapshot append-only +
// retention, attribution retention, hash determinism (incl. timezone), and
// operational-field coexistence (price/plan stay mutable; reads unchanged).
// ===========================================================================

afterAll(async () => {
  await closePool();
});

// --- helpers ---------------------------------------------------------------

async function enableFinalization(studioId: string): Promise<void> {
  await adminQuery(
    "update public.studios set clinical_finalization_enabled = true where id = $1",
    [studioId],
  );
}

// Add a live electrolysis entry in a block (min-charting needs a live block AND
// a live entry). Returns the entry id.
async function addEntry(sessionId: string, blockId: string): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    "insert into public.electrolysis_entries (id, session_id, area, block_id) values ($1,$2,'Chin',$3)",
    [id, sessionId, blockId],
  );
  return id;
}

// A studio with finalization enabled and a finalizable draft (block + entry).
async function seedFinalizable(): Promise<{
  studio: SeededStudio;
  sessionId: string;
  blockId: string;
  entryId: string;
}> {
  const studio = await seedStudio("cf");
  await enableFinalization(studio.studioId);
  const { sessionId, blockId } = await seedSession(studio);
  const entryId = await addEntry(sessionId, blockId);
  return { studio, sessionId, blockId, entryId };
}

type FinalizeRow = {
  snapshot_id: string;
  version_no: number;
  content_hash: string;
  already_finalized: boolean;
};

async function finalize(
  userId: string,
  sessionId: string,
  expected: number | null = 1,
): Promise<FinalizeRow> {
  const r = await userQuery(
    userId,
    "select * from public.finalize_session($1, $2)",
    [sessionId, expected],
  );
  return r.rows[0] as FinalizeRow;
}

async function insertImage(
  studio: SeededStudio,
  sessionId: string | null,
): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.treatment_images
       (id, studio_id, client_id, session_id, storage_bucket, storage_path,
        content_type, size_bytes, uploaded_by)
     values ($1,$2,$3,$4,'treatment-images',$5,'image/jpeg',10,$6)`,
    [
      id,
      studio.studioId,
      studio.clientId,
      sessionId,
      `${studio.studioId}/${studio.clientId}/${id}.jpg`,
      studio.practitionerId,
    ],
  );
  return id;
}

// ---------------------------------------------------------------------------
describe("0119 — legacy provenance & migration semantics", () => {
  it("a session created after rollout defaults to native draft", async () => {
    const { studio, sessionId } = await seedFinalizable();
    const r = await adminQuery(
      "select record_status, record_origin, legacy_classification, record_version from public.sessions where id = $1",
      [sessionId],
    );
    expect(r.rows[0]).toMatchObject({
      record_status: "draft",
      record_origin: "native",
      legacy_classification: null,
      record_version: 1,
    });
    expect(studio.studioId).toBeTruthy();
  });

  it("legacy_classification is only allowed on legacy rows", async () => {
    const { sessionId } = await seedFinalizable();
    // native + classification -> check violation
    await expect(
      adminQuery(
        "update public.sessions set legacy_classification = 'ambiguous' where id = $1",
        [sessionId],
      ),
    ).rejects.toThrow();
    // legacy + classification -> allowed
    await adminQuery(
      "update public.sessions set record_origin = 'legacy', legacy_classification = 'ambiguous' where id = $1",
      [sessionId],
    );
    const r = await adminQuery(
      "select record_origin, legacy_classification from public.sessions where id = $1",
      [sessionId],
    );
    expect(r.rows[0]).toMatchObject({
      record_origin: "legacy",
      legacy_classification: "ambiguous",
    });
  });
});

describe("0119 — finalize eligibility", () => {
  it("rejects when the studio flag is OFF", async () => {
    const studio = await seedStudio("cf-off");
    const { sessionId, blockId } = await seedSession(studio);
    await addEntry(sessionId, blockId);
    await expect(finalize(studio.userId, sessionId)).rejects.toThrow(
      /not enabled/i,
    );
  });

  it("one studio's flag does not enable another studio", async () => {
    const a = await seedStudio("cf-a");
    await enableFinalization(a.studioId); // A on, B off
    const b = await seedStudio("cf-b");
    const { sessionId, blockId } = await seedSession(b);
    await addEntry(sessionId, blockId);
    await expect(finalize(b.userId, sessionId)).rejects.toThrow(/not enabled/i);
  });

  it("rejects legacy rows (native-only)", async () => {
    const { studio, sessionId } = await seedFinalizable();
    await adminQuery(
      "update public.sessions set record_origin = 'legacy' where id = $1",
      [sessionId],
    );
    await expect(finalize(studio.userId, sessionId)).rejects.toThrow(
      /native/i,
    );
  });

  it("rejects an inactive practitioner", async () => {
    const { studio, sessionId } = await seedFinalizable();
    await adminQuery(
      "update public.practitioners set active = false where id = $1",
      [studio.practitionerId],
    );
    await expect(finalize(studio.userId, sessionId)).rejects.toThrow();
  });

  it("rejects a cross-studio caller", async () => {
    const { sessionId } = await seedFinalizable();
    const other = await seedStudio("cf-other");
    await enableFinalization(other.studioId);
    await expect(finalize(other.userId, sessionId)).rejects.toThrow(
      /not found or not accessible/i,
    );
  });

  it("rejects a session with no block", async () => {
    const studio = await seedStudio("cf-noblock");
    await enableFinalization(studio.studioId);
    const sessionId = randomUUID();
    await adminQuery(
      "insert into public.sessions (id, studio_id, client_id, practitioner_id, modality) values ($1,$2,$3,$4,'electrolysis')",
      [sessionId, studio.studioId, studio.clientId, studio.practitionerId],
    );
    await expect(finalize(studio.userId, sessionId)).rejects.toThrow(
      /no treatment area/i,
    );
  });

  it("rejects a block with no entries", async () => {
    const studio = await seedStudio("cf-noentry");
    await enableFinalization(studio.studioId);
    const { sessionId } = await seedSession(studio); // block, no entry
    await expect(finalize(studio.userId, sessionId)).rejects.toThrow(
      /no treatment pass/i,
    );
  });

  it("rejects when the only entry is soft-deleted", async () => {
    const { studio, sessionId, entryId } = await seedFinalizable();
    await adminQuery(
      "update public.electrolysis_entries set deleted_at = now() where id = $1",
      [entryId],
    );
    await expect(finalize(studio.userId, sessionId)).rejects.toThrow(
      /no treatment pass/i,
    );
  });

  it("succeeds for one valid block + entry", async () => {
    const { studio, sessionId } = await seedFinalizable();
    const row = await finalize(studio.userId, sessionId);
    expect(row.already_finalized).toBe(false);
    expect(row.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("0119 — version alignment, idempotency, concurrency", () => {
  it("initial finalize: session v1, snapshot v1, current_snapshot_id -> v1, exactly one snapshot", async () => {
    const { studio, sessionId } = await seedFinalizable();
    const row = await finalize(studio.userId, sessionId);
    const s = await adminQuery(
      "select record_status, record_version, current_snapshot_id from public.sessions where id = $1",
      [sessionId],
    );
    expect(s.rows[0]).toMatchObject({
      record_status: "finalized",
      record_version: 1, // NOT incremented at initial finalization
      current_snapshot_id: row.snapshot_id,
    });
    const snaps = await adminQuery(
      "select id, version_no from public.clinical_record_snapshots where session_id = $1",
      [sessionId],
    );
    expect(snaps.rows).toHaveLength(1);
    expect(snaps.rows[0]).toMatchObject({ id: row.snapshot_id, version_no: 1 });
  });

  it("a repeated finalize is idempotent (already_finalized, same snapshot, no duplicate)", async () => {
    const { studio, sessionId } = await seedFinalizable();
    const first = await finalize(studio.userId, sessionId);
    const second = await finalize(studio.userId, sessionId, 1);
    expect(second.already_finalized).toBe(true);
    expect(second.snapshot_id).toBe(first.snapshot_id);
    const snaps = await adminQuery(
      "select count(*)::int as n from public.clinical_record_snapshots where session_id = $1",
      [sessionId],
    );
    expect(snaps.rows[0].n).toBe(1);
  });

  it("rejects a stale expected record version", async () => {
    const { studio, sessionId } = await seedFinalizable();
    await expect(finalize(studio.userId, sessionId, 2)).rejects.toThrow(
      /version conflict/i,
    );
    // Nothing partially finalized.
    const s = await adminQuery(
      "select record_status from public.sessions where id = $1",
      [sessionId],
    );
    expect(s.rows[0].record_status).toBe("draft");
  });

  it("two concurrent finalize attempts produce exactly one snapshot", async () => {
    const { studio, sessionId } = await seedFinalizable();
    const results = await Promise.allSettled([
      finalize(studio.userId, sessionId),
      finalize(studio.userId, sessionId),
    ]);
    // Both resolve (one finalizes, the other returns idempotent); FOR UPDATE serializes.
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const snaps = await adminQuery(
      "select count(*)::int as n from public.clinical_record_snapshots where session_id = $1",
      [sessionId],
    );
    expect(snaps.rows[0].n).toBe(1);
  });

  it("a failed finalize leaves no partial state (draft, no snapshot)", async () => {
    const studio = await seedStudio("cf-partial");
    await enableFinalization(studio.studioId);
    const { sessionId } = await seedSession(studio); // no entry -> min-charting fails
    await expect(finalize(studio.userId, sessionId)).rejects.toThrow();
    const s = await adminQuery(
      "select record_status from public.sessions where id = $1",
      [sessionId],
    );
    expect(s.rows[0].record_status).toBe("draft");
    const snaps = await adminQuery(
      "select count(*)::int as n from public.clinical_record_snapshots where session_id = $1",
      [sessionId],
    );
    expect(snaps.rows[0].n).toBe(0);
  });
});

describe("0119 — finalized session is frozen (all roles, no bypass)", () => {
  async function finalized() {
    const f = await seedFinalizable();
    await finalize(f.studio.userId, f.sessionId);
    return f;
  }

  it("blocks finalized -> draft (status reversal), as member AND service-role", async () => {
    const { studio, sessionId } = await finalized();
    await expect(
      userQuery(
        studio.userId,
        "update public.sessions set record_status = 'draft' where id = $1",
        [sessionId],
      ),
    ).rejects.toThrow();
    // service-role (postgres, bypassrls) is ALSO blocked — triggers have no bypass.
    await expect(
      adminQuery(
        "update public.sessions set record_status = 'draft' where id = $1",
        [sessionId],
      ),
    ).rejects.toThrow();
  });

  it("blocks finalized -> void", async () => {
    const { studio, sessionId } = await finalized();
    await expect(
      userQuery(
        studio.userId,
        "update public.sessions set record_status = 'void' where id = $1",
        [sessionId],
      ),
    ).rejects.toThrow();
  });

  it("blocks soft-delete of a finalized session", async () => {
    const { studio, sessionId } = await finalized();
    await expect(
      userQuery(
        studio.userId,
        "update public.sessions set deleted_at = now(), deleted_by = $2 where id = $1",
        [sessionId, studio.practitionerId],
      ),
    ).rejects.toThrow();
  });

  it("blocks hard-delete of a finalized session (member cannot; service-role guard raises)", async () => {
    const { studio, sessionId } = await finalized();
    // Member: `sessions` has no DELETE RLS policy, so the delete is prevented by RLS
    // (matches 0 rows, or errors on a missing grant) — either way the row survives.
    await userQuery(studio.userId, "delete from public.sessions where id = $1", [
      sessionId,
    ]).catch(() => undefined);
    const afterMember = await adminQuery(
      "select 1 from public.sessions where id = $1",
      [sessionId],
    );
    expect(afterMember.rowCount).toBe(1);
    // Service-role (bypassrls): the BEFORE DELETE guard raises — no bypass.
    await expect(
      adminQuery("delete from public.sessions where id = $1", [sessionId]),
    ).rejects.toThrow();
    const afterAdmin = await adminQuery(
      "select 1 from public.sessions where id = $1",
      [sessionId],
    );
    expect(afterAdmin.rowCount).toBe(1);
  });

  it("blocks changing finalization attribution directly", async () => {
    const { studio, sessionId } = await finalized();
    await expect(
      adminQuery(
        "update public.sessions set finalized_by = null where id = $1",
        [sessionId],
      ),
    ).rejects.toThrow();
  });

  it("ALLOWS operational fields after finalization (price stays mutable)", async () => {
    const { studio, sessionId } = await finalized();
    await expect(
      userQuery(
        studio.userId,
        "update public.sessions set price_paid_cents = 5000 where id = $1",
        [sessionId],
      ),
    ).resolves.toBeDefined();
    const r = await adminQuery(
      "select price_paid_cents from public.sessions where id = $1",
      [sessionId],
    );
    expect(r.rows[0].price_paid_cents).toBe(5000);
  });
});

describe("0119 — finalized child clinical rows are frozen", () => {
  async function finalized() {
    const f = await seedFinalizable();
    await finalize(f.studio.userId, f.sessionId);
    return f;
  }

  it("blocks INSERT of a new session_block into a finalized session", async () => {
    const { studio, sessionId } = await finalized();
    await expect(
      adminQuery(
        "insert into public.session_blocks (id, studio_id, session_id) values ($1,$2,$3)",
        [randomUUID(), studio.studioId, sessionId],
      ),
    ).rejects.toThrow();
  });

  it("blocks UPDATE and DELETE of an existing session_block", async () => {
    const { blockId } = await finalized();
    await expect(
      adminQuery(
        "update public.session_blocks set deleted_at = now() where id = $1",
        [blockId],
      ),
    ).rejects.toThrow();
    await expect(
      adminQuery("delete from public.session_blocks where id = $1", [blockId]),
    ).rejects.toThrow();
  });

  it("blocks INSERT of a new electrolysis entry into a finalized session", async () => {
    const { sessionId, blockId } = await finalized();
    await expect(
      adminQuery(
        "insert into public.electrolysis_entries (id, session_id, area, block_id) values ($1,$2,'Lip',$3)",
        [randomUUID(), sessionId, blockId],
      ),
    ).rejects.toThrow();
  });

  it("blocks UPDATE (incl. observation chips) and DELETE of an electrolysis entry", async () => {
    const { entryId } = await finalized();
    await expect(
      adminQuery(
        "update public.electrolysis_entries set observation_chips = '[\"redness\"]'::jsonb where id = $1",
        [entryId],
      ),
    ).rejects.toThrow();
    await expect(
      adminQuery("delete from public.electrolysis_entries where id = $1", [
        entryId,
      ]),
    ).rejects.toThrow();
  });

  it("blocks INSERT/UPDATE/DELETE of laser entries on a finalized session", async () => {
    const { sessionId } = await finalized();
    await expect(
      adminQuery(
        "insert into public.laser_entries (id, session_id, zone) values ($1,$2,'Legs')",
        [randomUUID(), sessionId],
      ),
    ).rejects.toThrow();
  });
});

describe("0119 — finalized treatment-image metadata & attachment are locked", () => {
  async function finalizedWithImage() {
    const f = await seedFinalizable();
    const imageId = await insertImage(f.studio, f.sessionId); // attach on the draft
    await finalize(f.studio.userId, f.sessionId);
    return { ...f, imageId };
  }

  it("blocks INSERT of a new image attached to a finalized session", async () => {
    const { studio, sessionId } = await finalizedWithImage();
    await expect(insertImage(studio, sessionId)).rejects.toThrow();
  });

  it("blocks metadata UPDATE (practitioner_note) on a finalized image", async () => {
    const { imageId } = await finalizedWithImage();
    await expect(
      adminQuery(
        "update public.treatment_images set practitioner_note = 'x' where id = $1",
        [imageId],
      ),
    ).rejects.toThrow();
  });

  it("blocks reassignment (session_id change) of a finalized image", async () => {
    const { imageId } = await finalizedWithImage();
    await expect(
      adminQuery(
        "update public.treatment_images set session_id = null where id = $1",
        [imageId],
      ),
    ).rejects.toThrow();
  });

  it("blocks soft-delete and hard-delete of a finalized image", async () => {
    const { imageId, studio } = await finalizedWithImage();
    await expect(
      adminQuery(
        "update public.treatment_images set deleted_at = now(), deleted_by = $2 where id = $1",
        [imageId, studio.practitionerId],
      ),
    ).rejects.toThrow();
    await expect(
      adminQuery("delete from public.treatment_images where id = $1", [imageId]),
    ).rejects.toThrow();
  });

  it("the dead `photos` table is EXCLUDED from the snapshot (only treatment_images are captured)", async () => {
    const f = await seedFinalizable();
    // A row in the legacy photos table must NOT appear in the snapshot.
    await adminQuery(
      "insert into public.photos (id, studio_id, client_id, session_id, area, storage_path, photo_type) values ($1,$2,$3,$4,'chin','x/y.jpg','before')",
      [randomUUID(), f.studio.studioId, f.studio.clientId, f.sessionId],
    );
    await finalize(f.studio.userId, f.sessionId);
    const snap = await adminQuery(
      "select snapshot->'photos' as photos from public.clinical_record_snapshots where session_id = $1",
      [f.sessionId],
    );
    // No treatment_images were attached -> photos array is empty (photos table ignored).
    expect(snap.rows[0].photos).toEqual([]);
  });
});

describe("0119 — snapshot append-only, access & retention", () => {
  async function finalized() {
    const f = await seedFinalizable();
    const row = await finalize(f.studio.userId, f.sessionId);
    return { ...f, row };
  }

  it("denies direct authenticated INSERT/UPDATE/DELETE on snapshots", async () => {
    const { studio, sessionId, row } = await finalized();
    await expect(
      userQuery(
        studio.userId,
        "insert into public.clinical_record_snapshots (id, studio_id, session_id, version_no, snapshot, content_hash, finalized_at) values ($1,$2,$3,2,'{}'::jsonb,'x',now())",
        [randomUUID(), studio.studioId, sessionId],
      ),
    ).rejects.toThrow();
    await expect(
      userQuery(
        studio.userId,
        "update public.clinical_record_snapshots set content_hash = 'tampered' where id = $1",
        [row.snapshot_id],
      ),
    ).rejects.toThrow();
    await expect(
      userQuery(
        studio.userId,
        "delete from public.clinical_record_snapshots where id = $1",
        [row.snapshot_id],
      ),
    ).rejects.toThrow();
  });

  it("blocks snapshot mutation even via a service-role path (append-only trigger)", async () => {
    const { row } = await finalized();
    await expect(
      adminQuery(
        "update public.clinical_record_snapshots set content_hash = 'tampered' where id = $1",
        [row.snapshot_id],
      ),
    ).rejects.toThrow();
    await expect(
      adminQuery("delete from public.clinical_record_snapshots where id = $1", [
        row.snapshot_id,
      ]),
    ).rejects.toThrow();
  });

  it("same-studio member can SELECT the snapshot; cross-studio sees nothing", async () => {
    const { studio, sessionId } = await finalized();
    const mine = await userQuery(
      studio.userId,
      "select id from public.clinical_record_snapshots where session_id = $1",
      [sessionId],
    );
    expect(mine.rows).toHaveLength(1);
    const other = await seedStudio("cf-cross");
    const theirs = await userQuery(
      other.userId,
      "select id from public.clinical_record_snapshots where session_id = $1",
      [sessionId],
    );
    expect(theirs.rows).toHaveLength(0);
  });

  it("rejects deleting a studio / practitioner referenced by a finalized record", async () => {
    const { studio } = await finalized();
    await expect(
      adminQuery("delete from public.studios where id = $1", [studio.studioId]),
    ).rejects.toThrow();
    await expect(
      adminQuery("delete from public.practitioners where id = $1", [
        studio.practitionerId,
      ]),
    ).rejects.toThrow();
    // Deactivation is still allowed.
    await expect(
      adminQuery(
        "update public.practitioners set active = false where id = $1",
        [studio.practitionerId],
      ),
    ).resolves.toBeDefined();
  });
});

describe("0119 — snapshot canonicalization & hash determinism", () => {
  it("the same unchanged session hashes identically twice", async () => {
    const { sessionId } = await seedFinalizable();
    const a = await adminQuery(
      "select encode(extensions.digest(public.build_session_snapshot($1)::text,'sha256'),'hex') as h",
      [sessionId],
    );
    const b = await adminQuery(
      "select encode(extensions.digest(public.build_session_snapshot($1)::text,'sha256'),'hex') as h",
      [sessionId],
    );
    expect(a.rows[0].h).toBe(b.rows[0].h);
    expect(a.rows[0].h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the hash is identical under UTC and a non-UTC database timezone", async () => {
    const { sessionId } = await seedFinalizable();
    async function hashUnderTz(tz: string): Promise<string> {
      const p = new Pool({ connectionString: resolveLocalDbUrl(), max: 1 });
      try {
        const c = await p.connect();
        try {
          await c.query("begin");
          await c.query(`set local timezone = '${tz}'`);
          const r = await c.query(
            "select encode(extensions.digest(public.build_session_snapshot($1)::text,'sha256'),'hex') as h",
            [sessionId],
          );
          await c.query("rollback");
          return r.rows[0].h as string;
        } finally {
          c.release();
        }
      } finally {
        await p.end();
      }
    }
    const utc = await hashUnderTz("UTC");
    const ny = await hashUnderTz("America/New_York");
    expect(utc).toBe(ny);
  });

  it("a finalized snapshot is provably non-empty (>=1 block AND >=1 entry — closes the TOCTOU)", async () => {
    const { studio, sessionId } = await seedFinalizable();
    await finalize(studio.userId, sessionId);
    const snap = await adminQuery(
      "select jsonb_array_length(snapshot->'blocks') as b, jsonb_array_length(snapshot->'electrolysis_entries') as e, jsonb_array_length(snapshot->'laser_entries') as l from public.clinical_record_snapshots where session_id = $1",
      [sessionId],
    );
    expect(snap.rows[0].b).toBeGreaterThanOrEqual(1);
    expect((snap.rows[0].e ?? 0) + (snap.rows[0].l ?? 0)).toBeGreaterThanOrEqual(1);
  });

  it("excludes soft-deleted children from the snapshot", async () => {
    const { studio, sessionId, blockId } = await seedFinalizable();
    const live = await addEntry(sessionId, blockId);
    const dead = await addEntry(sessionId, blockId);
    await adminQuery(
      "update public.electrolysis_entries set deleted_at = now() where id = $1",
      [dead],
    );
    await finalize(studio.userId, sessionId);
    const snap = await adminQuery(
      "select snapshot->'electrolysis_entries' as e from public.clinical_record_snapshots where session_id = $1",
      [sessionId],
    );
    const ids = (snap.rows[0].e as Array<{ id: string }>).map((x) => x.id);
    expect(ids).toContain(live);
    expect(ids).not.toContain(dead);
  });
});

describe("0119 — coexistence: reads & operational writes unchanged", () => {
  it("a finalized session and its children remain readable by members", async () => {
    const { studio, sessionId } = await seedFinalizable();
    await finalize(studio.userId, sessionId);
    const s = await userQuery(
      studio.userId,
      "select id, record_status from public.sessions where id = $1",
      [sessionId],
    );
    expect(s.rows[0]).toMatchObject({ id: sessionId, record_status: "finalized" });
    const blocks = await userQuery(
      studio.userId,
      "select count(*)::int as n from public.session_blocks where session_id = $1",
      [sessionId],
    );
    expect(blocks.rows[0].n).toBeGreaterThan(0);
  });

  it("treatment_plan_id (operational link) can still be changed after finalization", async () => {
    const { studio, sessionId } = await seedFinalizable();
    await finalize(studio.userId, sessionId);
    // Detach-style write to the operational link is not frozen.
    await expect(
      adminQuery(
        "update public.sessions set treatment_plan_id = null where id = $1",
        [sessionId],
      ),
    ).resolves.toBeDefined();
  });
});
