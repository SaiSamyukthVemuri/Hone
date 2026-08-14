// TREATMENT-IMAGE ACTOR ACROSS MULTI-STUDIO MEMBERSHIP, 0178.
//
// 0168 resolved the actor with `where user_id = auth.uid() and active limit 1`,
// with no studio scope and no ORDER BY. For a human who is an active
// practitioner in TWO studios that is a planner-dependent choice: the same call
// could resolve to either membership, and the commands then validated the
// resource against whichever studio came back. The consequence was
// NONDETERMINISM AND INTERMITTENT REFUSAL, the resource check meant a wrong
// pick failed closed rather than attributing across tenants, but "usually
// right" is not an authorization model.
//
// 0178 inverts the order:  RESOURCE -> STUDIO -> ACTIVE PRACTITIONER THERE.
//
// WHY THESE CASES WOULD BE FLAKY, NOT RED, AGAINST THE OLD HELPER: they assert
// the SPECIFIC practitioner id attributed for each studio. Under `limit 1` the
// answer depended on the plan, so a run could pass by luck. That is exactly why
// the assertions name ids instead of merely checking "it worked".

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  adminQuery,
  closePool,
  seedStudio,
  userQuery,
  type SeededStudio,
} from "./helpers/harness";

const CHECK_VIOLATION = "23514";

let A: SeededStudio;
let B: SeededStudio;
/** ONE human, active in BOTH studios. */
let sharedUser: string;
let practInA: string;
let practInB: string;

beforeAll(async () => {
  A = await seedStudio("mstudio-a");
  B = await seedStudio("mstudio-b");
  sharedUser = A.userId;
  practInA = A.practitionerId;
  practInB = randomUUID();
  await adminQuery(
    `insert into public.practitioners
       (id, studio_id, user_id, display_name, email, role, active)
     values ($1, $2, $3, 'Shared In B', $4, 'practitioner', true)`,
    [practInB, B.studioId, sharedUser, `shared-${practInB.slice(0, 8)}@harness.local`],
  );
});
afterAll(async () => {
  await closePool();
});

const CREATE = `select public.create_treatment_image_metadata($1,$2,$3,$4,$5,$6,$7,$8,$9) id`;
const NOTE = `select public.set_treatment_image_note($1,$2,$3) id`;
const ARCHIVE = `select public.archive_treatment_image($1,$2) id`;

const pathFor = (studioId: string, clientId: string, id: string) =>
  `${studioId}/${clientId}/${id}.jpg`;

const createArgs = (id: string, studioId: string, clientId: string) => [
  id,
  clientId,
  null,
  null,
  "treatment-images",
  pathFor(studioId, clientId, id),
  "photo.jpg",
  "image/jpeg",
  1234,
];

const readImage = async (id: string) =>
  (
    await adminQuery(
      `select studio_id, client_id, uploaded_by, deleted_by, practitioner_note, deleted_at
         from public.treatment_images where id = $1`,
      [id],
    )
  ).rows[0];

describe("0178: treatment-image actor is resolved PER RESOURCE STUDIO", () => {
  it("uploading for studio A's client attributes studio A's practitioner", async () => {
    const id = randomUUID();
    const r = await userQuery(sharedUser, CREATE, createArgs(id, A.studioId, A.clientId));
    expect(r.rows[0].id).toBe(id);
    const img = await readImage(id);
    expect(img.studio_id).toBe(A.studioId);
    expect(img.uploaded_by).toBe(practInA);
  });

  it("uploading for studio B's client attributes studio B's practitioner", async () => {
    // THE CASE THE OLD HELPER COULD NOT ANSWER. Same human, same session, other
    // studio, the attribution must follow the RESOURCE, not the planner.
    const id = randomUUID();
    const r = await userQuery(sharedUser, CREATE, createArgs(id, B.studioId, B.clientId));
    expect(r.rows[0].id).toBe(id);
    const img = await readImage(id);
    expect(img.studio_id).toBe(B.studioId);
    expect(img.uploaded_by).toBe(practInB);
    expect(img.uploaded_by).not.toBe(practInA);
  });

  it("attribution is STABLE across repeated interleaved writes", async () => {
    // Order-dependence is the failure mode, so alternate studios and assert
    // every single attribution rather than sampling one.
    for (let i = 0; i < 4; i++) {
      const target = i % 2 === 0 ? A : B;
      const expected = i % 2 === 0 ? practInA : practInB;
      const id = randomUUID();
      await userQuery(sharedUser, CREATE, createArgs(id, target.studioId, target.clientId));
      expect((await readImage(id)).uploaded_by, `iteration ${i}`).toBe(expected);
    }
  });

  it("NOTE and ARCHIVE resolve against the IMAGE's studio, not a guessed one", async () => {
    const id = randomUUID();
    await userQuery(sharedUser, CREATE, createArgs(id, B.studioId, B.clientId));

    const noted = await userQuery(sharedUser, NOTE, [id, B.clientId, "  a note  "]);
    expect(noted.rows[0].id).toBe(id);
    expect((await readImage(id)).practitioner_note).toBe("a note");

    const archived = await userQuery(sharedUser, ARCHIVE, [id, B.clientId]);
    expect(archived.rows[0].id).toBe(id);
    const after = await readImage(id);
    expect(after.deleted_at).not.toBeNull();
    expect(after.deleted_by).toBe(practInB);
  });
});

describe("0178: a non-member cannot be attributed, and learns nothing", () => {
  it("CREATE for another studio's client is refused with the SAME message as a nonexistent client", async () => {
    // NON-DISCLOSURE. `C`'s owner is a member of neither A nor B. "That client
    // is not available." must cover both "no such client" and "not your studio",
    // or the wording itself becomes a tenant-existence oracle.
    const C = await seedStudio("mstudio-c");
    const codes: Array<string | undefined> = [];
    for (const clientId of [A.clientId, randomUUID()]) {
      try {
        await userQuery(C.userId, CREATE, createArgs(randomUUID(), A.studioId, clientId));
        codes.push(undefined);
      } catch (e) {
        codes.push((e as { code?: string }).code);
      }
    }
    expect(codes).toEqual([CHECK_VIOLATION, CHECK_VIOLATION]);
  });

  it("NOTE and ARCHIVE return the generic NULL for a non-member, no leak", async () => {
    const C = await seedStudio("mstudio-c2");
    const id = randomUUID();
    await userQuery(sharedUser, CREATE, createArgs(id, A.studioId, A.clientId));

    // Real image, real client, but the caller is not an active member of its
    // studio: indistinguishable from "unknown image".
    const note = await userQuery(C.userId, NOTE, [id, A.clientId, "x"]);
    expect(note.rows[0].id).toBeNull();
    const arch = await userQuery(C.userId, ARCHIVE, [id, A.clientId]);
    expect(arch.rows[0].id).toBeNull();
    const unknown = await userQuery(C.userId, NOTE, [randomUUID(), A.clientId, "x"]);
    expect(unknown.rows[0].id).toBeNull();

    // ...and nothing was mutated.
    const img = await readImage(id);
    expect(img.practitioner_note).toBeNull();
    expect(img.deleted_at).toBeNull();
  });

  it("an INACTIVE membership in the resource's studio cannot be attributed", async () => {
    const id = randomUUID();
    await adminQuery(`update public.practitioners set active=false where id=$1`, [practInB]);
    try {
      let code: string | undefined;
      try {
        await userQuery(sharedUser, CREATE, createArgs(id, B.studioId, B.clientId));
      } catch (e) {
        code = (e as { code?: string }).code;
      }
      expect(code).toBe(CHECK_VIOLATION);
    } finally {
      await adminQuery(`update public.practitioners set active=true where id=$1`, [practInB]);
    }
  });
});

describe("0178: the actor helper itself", () => {
  it("is studio-scoped, returns zero rows off-studio, and is granted to nobody", async () => {
    const r = await adminQuery(
      `select (select count(*)::int from public.treatment_image_actor($1)) in_a,
              (select count(*)::int from public.treatment_image_actor($2)) in_c,
              has_function_privilege('authenticated', 'public.treatment_image_actor(uuid)', 'EXECUTE') auth_x,
              has_function_privilege('anon',          'public.treatment_image_actor(uuid)', 'EXECUTE') anon_x,
              has_function_privilege('service_role',  'public.treatment_image_actor(uuid)', 'EXECUTE') svc_x`,
      [A.studioId, randomUUID()],
    );
    // Run as the table owner, so the auth.uid() predicate matches nothing,
    // what matters here is the SHAPE and the grant posture.
    expect(r.rows[0].in_c).toBe(0);
    expect(r.rows[0].auth_x).toBe(false);
    expect(r.rows[0].anon_x).toBe(false);
    expect(r.rows[0].svc_x).toBe(false);
  });

  it("the old GLOBAL no-argument helper is gone", async () => {
    // Leaving it would preserve the exact nondeterministic selection 0178
    // exists to remove, one call site away.
    const r = await adminQuery(
      `select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='treatment_image_actor'
          and pg_get_function_identity_arguments(p.oid) = ''`,
    );
    expect(r.rows[0].n).toBe(0);
  });
});
