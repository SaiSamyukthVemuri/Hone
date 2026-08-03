import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  asUser,
  closePool,
  seedMember,
  seedSession,
  seedStudio,
  adminQuery,
  userQuery,
  type SeededStudio,
} from "./helpers/harness";
import { randomUUID } from "node:crypto";

// PR #271 (migration 0092): treatment_images RLS, proven on the REAL migrated
// local database.
//   treatment_images
//     SELECT  any active member        INSERT  any active member (own studio)
//     UPDATE  any active member (soft-delete)   DELETE  nobody (no policy)
//   Cross-studio isolation; TRUNCATE/DELETE revoked from authenticated.

let s: SeededStudio; // owner studio
let member: { userId: string; practitionerId: string };
let foreign: SeededStudio;
let imageId: string;
let sessionRefs: { sessionId: string; blockId: string };

beforeAll(async () => {
  s = await seedStudio("timg");
  member = await seedMember(s, "timg-member");
  foreign = await seedStudio("timg-foreign");
  sessionRefs = await seedSession(s);
  imageId = randomUUID();

  // Owner inserts a treatment image metadata row for the studio's client.
  // Fixture only — after 0169 `authenticated` holds no direct INSERT, and this
  // seed is not the property under test.
  await adminQuery(
    `insert into public.treatment_images
       (id, studio_id, client_id, session_id, session_block_id,
        storage_bucket, storage_path, original_filename, content_type,
        size_bytes, uploaded_by)
     values ($1, $2, $3, $4, $5, 'treatment-images', $6, 'lip.jpg',
        'image/jpeg', 1234, $7)`,
    [
      imageId,
      s.studioId,
      s.clientId,
      sessionRefs.sessionId,
      sessionRefs.blockId,
      `${s.studioId}/${s.clientId}/${imageId}.jpg`,
      s.practitionerId,
    ],
  );
});

afterAll(async () => {
  await closePool();
});

describe("read access", () => {
  it("same-studio members can read the studio's images", async () => {
    const owner = await userQuery(
      s.userId,
      "select id from public.treatment_images where studio_id = $1",
      [s.studioId],
    );
    expect(owner.rowCount).toBeGreaterThanOrEqual(1);
    const mem = await userQuery(
      member.userId,
      "select id from public.treatment_images where studio_id = $1",
      [s.studioId],
    );
    expect(mem.rowCount).toBeGreaterThanOrEqual(1);
  });

  it("cross-studio reads are blocked (by studio_id and by row id)", async () => {
    await asUser(foreign.userId, async (q) => {
      const byStudio = await q(
        "select id from public.treatment_images where studio_id = $1",
        [s.studioId],
      );
      expect(byStudio.rowCount).toBe(0);
      const byId = await q(
        "select id from public.treatment_images where id = $1",
        [imageId],
      );
      expect(byId.rowCount).toBe(0);
    });
  });
});

describe("write access", () => {
  it("a member can create image metadata for their own studio (via the 0168 command)", async () => {
    // After 0169 the direct INSERT is revoked; the member reaches this through
    // create_treatment_image_metadata, which derives studio and uploader from
    // auth.uid(). The capability under test — a member CAN record an image for
    // their own studio — is unchanged.
    const id = randomUUID();
    const res = await userQuery(
      member.userId,
      `select public.create_treatment_image_metadata($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        id,
        s.clientId,
        null,
        null,
        "treatment-images",
        `${s.studioId}/${s.clientId}/${id}.png`,
        "shot.png",
        "image/png",
        10,
      ],
    );
    expect(res.rows[0].create_treatment_image_metadata).toBe(id);
  });

  it("cross-studio insert is blocked (privilege after 0169; the command refuses it too)", async () => {
    // The command path refuses a foreign studio's client explicitly.
    await expect(
      userQuery(foreign.userId,
        `select public.create_treatment_image_metadata($1,$2,null,null,$3,$4,null,$5,$6)`,
        [randomUUID(), s.clientId, "treatment-images",
         `${s.studioId}/${s.clientId}/x.png`, "image/png", 10]),
    ).rejects.toThrow();
    // ...and the direct path is gone entirely.
    await expect(
      userQuery(
        foreign.userId,
        `insert into public.treatment_images
           (id, studio_id, client_id, storage_bucket, storage_path,
            content_type, size_bytes)
         values ($1, $2, $3, 'treatment-images', $4, 'image/png', 10)`,
        [
          randomUUID(),
          s.studioId, // foreign user writing into studio s -> denied
          s.clientId,
          `${s.studioId}/${s.clientId}/x.png`,
        ],
      ),
    ).rejects.toThrow();
  });
});

describe("correction posture: soft-delete only", () => {
  it("a member can soft-delete their studio's image (via the 0168 command)", async () => {
    const res = await userQuery(
      member.userId,
      `select public.archive_treatment_image($1,$2)`,
      [imageId, s.clientId],
    );
    expect(res.rows[0].archive_treatment_image).toBe(imageId);
  });

  it("no authenticated user can hard-delete or truncate", async () => {
    await expect(
      userQuery(s.userId, "delete from public.treatment_images where id = $1", [
        imageId,
      ]),
    ).rejects.toThrow();
    await expect(
      userQuery(s.userId, "truncate public.treatment_images"),
    ).rejects.toThrow();
  });
});
