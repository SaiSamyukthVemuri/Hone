import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, asUser, closePool, seedMember, seedStudio, type SeededStudio } from "./helpers/harness";

// Direct storage reads with a practitioner's own JWT (the bypass OPS asked about). The bucket is service-role only (0093), so
// the answer must be "no rows / refused" in EVERY key state: clin.view_photos Off, On, and another studio. NOT a proof of the
// signer; that is the server-side gate. Needs the storage schema: a stack started without storage-api skips, and a skip is
// NOT a pass.
let A: SeededStudio, B: SeededStudio;
let prac: { userId: string; practitionerId: string };
let objectPath = "";
let hasStorage = false;

beforeAll(async () => {
  hasStorage = Boolean((await adminQuery("select to_regclass('storage.objects') as t")).rows[0].t);
  if (!hasStorage) return;
  A = await seedStudio("img-boundary-a");
  B = await seedStudio("img-boundary-b");
  prac = await seedMember(A, "img-prac");
  await adminQuery("insert into storage.buckets (id, name, public) values ('treatment-images','treatment-images',false) on conflict (id) do nothing");
  objectPath = `${A.studioId}/${A.clientId}/${randomUUID()}.jpg`;
  await adminQuery("insert into storage.objects (bucket_id, name) values ('treatment-images', $1)", [objectPath]);
});
afterAll(async () => { await closePool(); });

const read = (userId: string) =>
  asUser(userId, async (q) => (await q("select name from storage.objects where bucket_id='treatment-images' and name=$1", [objectPath])).rows.length)
    .catch(() => 0); // a privilege error is also a refusal

describe("direct storage read of a treatment image with a practitioner JWT", () => {
  it("is refused with clin.view_photos at the existing snapshot (On), Off, and from another studio", async (ctx) => {
    if (!hasStorage) ctx.skip();
    expect(await read(prac.userId), "snapshot (On)").toBe(0);
    await adminQuery("insert into public.studio_role_permissions (studio_id, role, key, scope) values ($1,'practitioner','clin.view_photos','off') on conflict (studio_id, role, key) do update set scope='off'", [A.studioId]);
    expect(await read(prac.userId), "key Off").toBe(0);
    expect(await read(B.userId), "other studio's owner").toBe(0);
  });
});
