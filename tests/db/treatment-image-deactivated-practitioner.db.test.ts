// A DEACTIVATED PRACTITIONER LOSES THE PHOTO SURFACE — FETT photos (#892).
//
// The same human, before and after deactivation, against a real database:
//   * ACTIVE (positive control): RLS shows their studio's photo, and the note
//     and archive commands act on it;
//   * DEACTIVATED: RLS shows ZERO rows. The signed-URL action re-reads the
//     photo under RLS before it signs (app/(app)/clients/[id]/images/
//     actions.ts), so no row means no URL. The note and archive commands
//     refuse, and creating new metadata is refused.
//
// These are the definitive outcomes the browser proof could not await without
// a storage service (CI runs Supabase with storage-api excluded).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  adminQuery,
  closePool,
  seedMember,
  seedStudio,
  userQuery,
  type SeededStudio,
} from "./helpers/harness";

const CHECK_VIOLATION = "23514";
const CREATE = `select public.create_treatment_image_metadata($1,$2,$3,$4,$5,$6,$7,$8,$9) id`;
const NOTE = `select public.set_treatment_image_note($1,$2,$3) id`;
const ARCHIVE = `select public.archive_treatment_image($1,$2) id`;
/** Exactly what the signed-URL action reads, under the caller's RLS. */
const SIGNER_READ = `select storage_path from public.treatment_images
                      where id = $1 and studio_id = $2 and deleted_at is null`;

let A: SeededStudio;
let member: { userId: string; practitionerId: string };

const create = async (userId: string, s: SeededStudio) => {
  const id = randomUUID();
  return userQuery(userId, CREATE, [
    id,
    s.clientId,
    null,
    null,
    "treatment-images",
    `${s.studioId}/${s.clientId}/${id}.jpg`,
    "synthetic.jpg",
    "image/jpeg",
    1024,
  ]).then((r) => r.rows[0].id as string);
};

async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
}

beforeAll(async () => {
  A = await seedStudio("deact-photos");
  member = await seedMember(A, "deact-photos-m");
});
afterAll(async () => {
  await closePool();
});

describe("a practitioner deactivated in the same studio loses the photo surface", () => {
  it("ACTIVE (positive control): sees the photo, and note + archive act on it", async () => {
    const img = await create(member.userId, A);
    const seen = await userQuery(member.userId, SIGNER_READ, [img, A.studioId]);
    expect(seen.rowCount, "RLS shows an active practitioner their studio's photo").toBe(1);
    const noted = await userQuery(member.userId, NOTE, [img, A.clientId, "synthetic note"]);
    expect(noted.rows[0].id).toBe(img);
    const archived = await userQuery(member.userId, ARCHIVE, [img, A.clientId]);
    expect(archived.rows[0].id).toBe(img);
  });

  it("DEACTIVATED: zero rows (so no signed URL), note and archive refused, no new metadata", async () => {
    // A photo that stays live, created by the owner, so only the actor changes.
    const img = await create(A.userId, A);
    const before = await userQuery(member.userId, SIGNER_READ, [img, A.studioId]);
    expect(before.rowCount, "control: visible while active").toBe(1);

    await adminQuery(`update public.practitioners set active = false where id = $1`, [member.practitionerId]);

    const after = await userQuery(member.userId, SIGNER_READ, [img, A.studioId]);
    expect(after.rowCount, "the signer's own read returns nothing, so no URL is issued").toBe(0);

    const note = await userQuery(member.userId, NOTE, [img, A.clientId, "after deactivation"]);
    expect(note.rows[0].id, "the note command returns null for a non-actor").toBeNull();
    const kept = await adminQuery(`select practitioner_note from public.treatment_images where id = $1`, [img]);
    expect(kept.rows[0].practitioner_note, "and the note is NOT written").not.toBe("after deactivation");

    const archive = await userQuery(member.userId, ARCHIVE, [img, A.clientId]);
    expect(archive.rows[0].id, "archive returns null for a non-actor").toBeNull();
    const still = await adminQuery(`select deleted_at from public.treatment_images where id = $1`, [img]);
    expect(still.rows[0].deleted_at, "and the photo is NOT archived").toBeNull();

    expect(await code(create(member.userId, A))).toBe(CHECK_VIOLATION);
  });
});
