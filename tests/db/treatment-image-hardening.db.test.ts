import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  closePool,
  seedMember,
  seedSession,
  seedStudio,
  userQuery,
  type SeededStudio,
} from "./helpers/harness";
import { randomUUID } from "node:crypto";

// PR #276 (migration 0093): treatment image storage trust-boundary hardening,
// proven on the REAL migrated local database.
//   * objects are service-role only (no authenticated storage.objects policy);
//   * metadata path/bucket are bound to the row's studio_id/client_id (CHECK);
//   * parent rows (client/session/block) must be same-studio (trigger);
//   * identity columns are immutable post-insert (trigger);
//   * soft-archive + service-mediated valid inserts still work.

let s: SeededStudio; // studio A (owner)
let member: { userId: string; practitionerId: string };
let foreign: SeededStudio; // studio B
let aSession: { sessionId: string; blockId: string };
let bSession: { sessionId: string; blockId: string };
let baseId: string;

// Insert as the studio-A owner (RLS authenticated). Defaults are a VALID row;
// override individual fields to exercise a specific rejection.
function insertAsOwner(overrides: Record<string, unknown> = {}) {
  const id = (overrides.id as string) ?? randomUUID();
  const row = {
    studio_id: s.studioId,
    client_id: s.clientId,
    session_id: null,
    session_block_id: null,
    storage_bucket: "treatment-images",
    storage_path: `${s.studioId}/${s.clientId}/${id}.jpg`,
    content_type: "image/jpeg",
    size_bytes: 10,
    uploaded_by: s.practitionerId,
    ...overrides,
  };
  // Fixture only — after 0169 `authenticated` holds no direct INSERT on this
  // table. The properties under test below are the identity-column freezes,
  // which are trigger-enforced and role-independent.
  return adminQuery(
    `insert into public.treatment_images
       (id, studio_id, client_id, session_id, session_block_id,
        storage_bucket, storage_path, content_type, size_bytes, uploaded_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      id,
      row.studio_id,
      row.client_id,
      row.session_id,
      row.session_block_id,
      row.storage_bucket,
      row.storage_path,
      row.content_type,
      row.size_bytes,
      row.uploaded_by,
    ],
  );
}

beforeAll(async () => {
  s = await seedStudio("harden");
  member = await seedMember(s, "harden-member");
  foreign = await seedStudio("harden-foreign");
  aSession = await seedSession(s);
  bSession = await seedSession(foreign);
  baseId = randomUUID();
  await insertAsOwner({ id: baseId });
});

afterAll(async () => {
  await closePool();
});

describe("bucket privacy + no direct object access", () => {
  it("treatment-images bucket is private", async () => {
    const r = await adminQuery(
      "select public from storage.buckets where id = 'treatment-images'",
    );
    expect(r.rows[0]?.public).toBe(false);
  });

  it("no authenticated treatment-images storage.objects policy remains", async () => {
    const r = await adminQuery(
      `select policyname from pg_policies
        where schemaname = 'storage' and tablename = 'objects'
          and policyname like 'treatment_images_objects%'`,
    );
    expect(r.rowCount).toBe(0);
  });

  it("an authenticated member cannot directly insert a treatment-images object", async () => {
    await expect(
      userQuery(
        member.userId,
        "insert into storage.objects (bucket_id, name) values ('treatment-images', $1)",
        [`${s.studioId}/${s.clientId}/${randomUUID()}.jpg`],
      ),
    ).rejects.toThrow();
  });

  it("an authenticated member cannot directly select/list treatment-images objects", async () => {
    // Seed an object as service-role so the read policy is genuinely exercised
    // (a member must still see zero).
    await adminQuery(
      "insert into storage.objects (bucket_id, name) values ('treatment-images', $1) on conflict do nothing",
      [`${s.studioId}/${s.clientId}/${randomUUID()}.jpg`],
    );
    const r = await userQuery(
      member.userId,
      "select id from storage.objects where bucket_id = 'treatment-images'",
    );
    expect(r.rowCount).toBe(0);
  });
});

describe("metadata bucket/path CHECK constraints", () => {
  it("rejects a wrong bucket", async () => {
    await expect(insertAsOwner({ storage_bucket: "public-bucket" })).rejects.toThrow();
  });
  it("rejects a path whose studio segment != row studio", async () => {
    await expect(
      insertAsOwner({ storage_path: `${foreign.studioId}/${s.clientId}/x.jpg` }),
    ).rejects.toThrow();
  });
  it("rejects a path whose client segment != row client", async () => {
    await expect(
      insertAsOwner({ storage_path: `${s.studioId}/${foreign.clientId}/x.jpg` }),
    ).rejects.toThrow();
  });
  it("rejects malformed / traversal / extra-segment / bad-extension paths", async () => {
    await expect(insertAsOwner({ storage_path: "not-a-path" })).rejects.toThrow();
    await expect(
      insertAsOwner({ storage_path: `${s.studioId}/${s.clientId}/../secret.jpg` }),
    ).rejects.toThrow();
    await expect(
      insertAsOwner({ storage_path: `${s.studioId}/${s.clientId}/sub/x.jpg` }),
    ).rejects.toThrow();
    await expect(
      insertAsOwner({ storage_path: `${s.studioId}/${s.clientId}/x.svg` }),
    ).rejects.toThrow();
  });
});

describe("parent consistency (trigger)", () => {
  it("rejects a cross-studio client", async () => {
    await expect(
      insertAsOwner({
        client_id: foreign.clientId,
        storage_path: `${s.studioId}/${foreign.clientId}/${randomUUID()}.jpg`,
      }),
    ).rejects.toThrow();
  });
  it("rejects a cross-studio session", async () => {
    await expect(insertAsOwner({ session_id: bSession.sessionId })).rejects.toThrow();
  });
  it("rejects a block from another session/studio", async () => {
    await expect(
      insertAsOwner({
        session_id: aSession.sessionId,
        session_block_id: bSession.blockId,
      }),
    ).rejects.toThrow();
  });
  it("rejects a block without a session", async () => {
    await expect(
      insertAsOwner({ session_block_id: aSession.blockId }),
    ).rejects.toThrow();
  });
  it("accepts a valid same-studio session + block", async () => {
    const r = await insertAsOwner({
      session_id: aSession.sessionId,
      session_block_id: aSession.blockId,
    });
    expect(r.rowCount).toBe(1);
  });
});

describe("identity immutability (trigger) + soft archive", () => {
  it("cannot update storage_path", async () => {
    await expect(
      userQuery(
        s.userId,
        "update public.treatment_images set storage_path = $1 where id = $2",
        [`${s.studioId}/${s.clientId}/moved.jpg`, baseId],
      ),
    ).rejects.toThrow();
  });
  it("cannot update storage_bucket / studio_id / client_id", async () => {
    await expect(
      userQuery(s.userId, "update public.treatment_images set storage_bucket = 'x' where id = $1", [baseId]),
    ).rejects.toThrow();
    await expect(
      userQuery(s.userId, "update public.treatment_images set studio_id = $1 where id = $2", [foreign.studioId, baseId]),
    ).rejects.toThrow();
    await expect(
      userQuery(s.userId, "update public.treatment_images set client_id = $1 where id = $2", [foreign.clientId, baseId]),
    ).rejects.toThrow();
  });
  it("soft archive (deleted_at/deleted_by) still works through the 0168 command", async () => {
    const r = await userQuery(
      s.userId,
      `select public.archive_treatment_image($1,$2)`,
      [baseId, s.clientId],
    );
    expect(r.rows[0].archive_treatment_image).toBe(baseId);
  });
});

describe("FK detach (ON DELETE SET NULL) is allowed; re-point is blocked", () => {
  it("clearing session/block to NULL via parent delete passes; re-pointing is blocked", async () => {
    const sess = await seedSession(s);
    const id = randomUUID();
    await insertAsOwner({
      id,
      session_id: sess.sessionId,
      session_block_id: sess.blockId,
    });
    // Re-pointing to a DIFFERENT non-null session is blocked (immutability).
    await expect(
      userQuery(
        s.userId,
        "update public.treatment_images set session_id = $1 where id = $2",
        [aSession.sessionId, id],
      ),
    ).rejects.toThrow();
    // Hard-deleting the parent session SET-NULLs session_id + session_block_id
    // (cascade through session_blocks) — the trigger must allow the detach.
    await adminQuery("delete from public.sessions where id = $1", [sess.sessionId]);
    const r = await adminQuery(
      "select session_id, session_block_id from public.treatment_images where id = $1",
      [id],
    );
    expect(r.rows[0]?.session_id).toBeNull();
    expect(r.rows[0]?.session_block_id).toBeNull();
  });
});

describe("service-mediated path still works", () => {
  it("service-role can create a valid metadata row", async () => {
    const id = randomUUID();
    const r = await adminQuery(
      `insert into public.treatment_images
         (id, studio_id, client_id, storage_bucket, storage_path,
          content_type, size_bytes, uploaded_by)
       values ($1,$2,$3,'treatment-images',$4,'image/png',10,$5)`,
      [id, s.studioId, s.clientId, `${s.studioId}/${s.clientId}/${id}.png`, s.practitionerId],
    );
    expect(r.rowCount).toBe(1);
  });
  it("a valid row remains readable by a same-studio member", async () => {
    const r = await userQuery(
      member.userId,
      "select id from public.treatment_images where studio_id = $1",
      [s.studioId],
    );
    expect(r.rowCount).toBeGreaterThanOrEqual(1);
  });
});
