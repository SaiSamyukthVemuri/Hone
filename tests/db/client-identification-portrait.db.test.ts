// CLIENT IDENTIFICATION PORTRAIT — 0231 (FETT photos, HON-43), RETIRED by 0275.
//
// 0231 let a practitioner mark one of a client's treatment photos as the
// client's identification portrait. Sam chose a separate ID-photo store (P2,
// 0275) and ruled out reusing treatment photos (decision 7), so the setter is
// retired: 0275 revokes EXECUTE on set_client_portrait from every API role and
// freezes the pointer column against any non-null write.
//
// The setter's old behavioural cases (wrong client, wrong studio, archived
// photo, lock ordering) went with the setter. What is proved here is what
// remains true of the 0231 column and what 0275 changed:
//   * no API role can call the setter;
//   * no role can set the pointer by a direct write, even to a perfectly valid
//     client-scoped photo;
//   * clearing it to null still works;
//   * archiving a treatment photo is unaffected and leaves no pointer behind.
// The new store is proved in tests/db/client-id-photo.db.test.ts.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, asRole, closePool, seedStudio, userQuery, type SeededStudio } from "./helpers/harness";

const INSUFFICIENT_PRIVILEGE = "42501";
const RETIRED = "P0275";

let A: SeededStudio;

async function refusal(p: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; message: string };
    return { code: err.code, message: err.message };
  }
  throw new Error("expected a refusal, but the call succeeded");
}

async function image(): Promise<string> {
  const id = randomUUID();
  await userQuery(A.userId, `select public.create_treatment_image_metadata($1,$2,null,null,$3,$4,$5,$6,$7)`, [
    id, A.clientId, "treatment-images", `${A.studioId}/${A.clientId}/${id}.jpg`, "synthetic.jpg", "image/jpeg", 1024,
  ]);
  return id;
}

const pointer = async () =>
  (await adminQuery(`select portrait_image_id from public.clients where id = $1`, [A.clientId])).rows[0].portrait_image_id as string | null;

beforeAll(async () => {
  A = await seedStudio("portrait-retired");
});
afterAll(async () => {
  await closePool();
});

describe("0231 portrait setter: retired by 0275", () => {
  it("no API role can call set_client_portrait, with or without a valid photo", async () => {
    const img = await image();
    for (const role of ["anon", "authenticated", "service_role"] as const) {
      const r = await refusal(asRole(role, (q) => q(`select public.set_client_portrait($1,$2)`, [A.clientId, img])));
      expect(r.code).toBe(INSUFFICIENT_PRIVILEGE);
    }
    // the owner's signed-in session is `authenticated` and is refused the same way
    const owner = await refusal(userQuery(A.userId, `select public.set_client_portrait($1,$2)`, [A.clientId, img]));
    expect(owner.code).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await pointer()).toBeNull();
  });

  it("the pointer cannot be set by a direct write, even to a valid client-scoped photo", async () => {
    const img = await image();
    const signedIn = await refusal(
      userQuery(A.userId, `update public.clients set portrait_image_id = $2 where id = $1`, [A.clientId, img]),
    );
    expect([RETIRED, INSUFFICIENT_PRIVILEGE]).toContain(signedIn.code);
    const admin = await refusal(adminQuery(`update public.clients set portrait_image_id = $2 where id = $1`, [A.clientId, img]));
    expect(admin.code).toBe(RETIRED);
    expect(await pointer()).toBeNull();
  });

  it("clearing the pointer to null stays possible", async () => {
    const r = await adminQuery(`update public.clients set portrait_image_id = null where id = $1`, [A.clientId]);
    expect(r.rowCount).toBe(1);
  });

  it("archiving a treatment photo still works and leaves no pointer", async () => {
    const img = await image();
    await userQuery(A.userId, `select public.archive_treatment_image($1,$2)`, [img, A.clientId]);
    const archived = await adminQuery(`select deleted_at from public.treatment_images where id = $1`, [img]);
    expect(archived.rows[0].deleted_at).not.toBeNull();
    expect(await pointer()).toBeNull();
  });
});
