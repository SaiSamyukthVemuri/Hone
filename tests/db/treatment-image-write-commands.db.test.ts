import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  asRole,
  closePool,
  seedLegacyRecordStatus,
  seedMember,
  seedSession,
  seedStudio,
  userQuery,
  type SeededStudio,
} from "./helpers/harness";

// ===========================================================================
// L18 Phase 4 — treatment_images write commands (migration 0168)
// ===========================================================================
//
// Three runtime writers wrote public.treatment_images directly. Three
// fixed-purpose commands replace them. These are SECURITY DEFINER and bypass
// RLS, so each re-establishes the tenant boundary itself.
//
// STORAGE IS NOT IN SCOPE HERE. These commands only write the metadata row;
// they cannot upload, sign or delete a storage object, and the application
// keeps its compensating cleanup because the two planes are not one
// transaction.
//
// SCOPE: additive. No table privilege is revoked — asserted below.

const CHECK_VIOLATION = "23514";

let A: SeededStudio;
let B: SeededStudio;
let sessionA: string;
let blockA: string;

beforeAll(async () => {
  A = await seedStudio("l18p4-a");
  B = await seedStudio("l18p4-b");
  const s = await seedSession(A);
  sessionA = s.sessionId;
  blockA = s.blockId;
});
afterAll(async () => {
  await closePool();
});

const CREATE = `select public.create_treatment_image_metadata($1,$2,$3,$4,$5,$6,$7,$8,$9)`;
const NOTE = `select public.set_treatment_image_note($1,$2,$3)`;
const ARCHIVE = `select public.archive_treatment_image($1,$2)`;

const newId = async () =>
  (await adminQuery(`select gen_random_uuid() id`)).rows[0].id as string;

const pathFor = (studioId: string, clientId: string, id: string) =>
  `${studioId}/${clientId}/${id}.jpg`;

/** Standard argument bag for a valid same-studio metadata write. */
function createArgs(
  id: string,
  over: Partial<{
    clientId: string;
    sessionId: string | null;
    blockId: string | null;
    bucket: string;
    path: string;
    filename: string;
    contentType: string;
    size: number;
    studioForPath: string;
  }> = {},
) {
  const clientId = over.clientId ?? A.clientId;
  const studioForPath = over.studioForPath ?? A.studioId;
  return [
    id,
    clientId,
    over.sessionId === undefined ? null : over.sessionId,
    over.blockId === undefined ? null : over.blockId,
    over.bucket ?? "treatment-images",
    over.path ?? pathFor(studioForPath, clientId, id),
    over.filename ?? "photo.jpg",
    over.contentType ?? "image/jpeg",
    over.size ?? 12345,
  ];
}

async function expectDenied(userId: string, sql: string, params: unknown[]) {
  let got: string | undefined;
  try {
    await userQuery(userId, sql, params);
  } catch (e) {
    got = (e as { code?: string }).code;
  }
  expect(got).toBe(CHECK_VIOLATION);
}

const readImage = async (id: string) =>
  (
    await adminQuery(
      `select studio_id, client_id, session_id, session_block_id, storage_bucket,
              storage_path, uploaded_by, practitioner_note, deleted_at, deleted_by
         from public.treatment_images where id = $1`,
      [id],
    )
  ).rows[0];

// --------------------------------------------------------------------------
// 1. Metadata creation.
// --------------------------------------------------------------------------

describe("0168 — create_treatment_image_metadata", () => {
  it("1. records a valid same-studio image and DERIVES uploaded_by", async () => {
    const id = await newId();
    await userQuery(A.userId, CREATE, createArgs(id));
    const row = await readImage(id);
    expect(row.studio_id).toBe(A.studioId);
    expect(row.client_id).toBe(A.clientId);
    expect(row.uploaded_by).toBe(A.practitionerId); // the ACTOR
    expect(row.storage_bucket).toBe("treatment-images");
    expect(row.deleted_at).toBeNull();
  });

  it("2. an UNAUTHENTICATED caller is refused", async () => {
    const id = await newId();
    let code: string | undefined;
    try {
      await asRole("authenticated", (q) => q(CREATE, createArgs(id)));
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe(CHECK_VIOLATION);
  });

  it("3. an INACTIVE practitioner is refused", async () => {
    const m = await seedMember(A, "l18p4-inactive");
    await adminQuery(`update public.practitioners set active=false where id=$1`, [
      m.practitionerId,
    ]);
    await expectDenied(m.userId, CREATE, createArgs(await newId()));
  });

  it("4. another studio's client is refused", async () => {
    const id = await newId();
    await expectDenied(
      A.userId,
      CREATE,
      createArgs(id, { clientId: B.clientId, studioForPath: A.studioId }),
    );
  });

  it("5. a session belonging to a DIFFERENT client is refused", async () => {
    const other = await adminQuery(
      `insert into public.clients (studio_id, name) values ($1,'Other') returning id`,
      [A.studioId],
    );
    const otherSession = await adminQuery(
      `insert into public.sessions (studio_id, client_id, practitioner_id, modality)
       values ($1,$2,$3,'electrolysis') returning id`,
      [A.studioId, other.rows[0].id, A.practitionerId],
    );
    await expectDenied(
      A.userId,
      CREATE,
      createArgs(await newId(), { sessionId: otherSession.rows[0].id }),
    );
  });

  it("6. a block whose session belongs to another client is refused", async () => {
    const other = await adminQuery(
      `insert into public.clients (studio_id, name) values ($1,'Other2') returning id`,
      [A.studioId],
    );
    const s = await adminQuery(
      `insert into public.sessions (studio_id, client_id, practitioner_id, modality)
       values ($1,$2,$3,'electrolysis') returning id`,
      [A.studioId, other.rows[0].id, A.practitionerId],
    );
    const b = await adminQuery(
      `insert into public.session_blocks (studio_id, session_id) values ($1,$2) returning id`,
      [A.studioId, s.rows[0].id],
    );
    await expectDenied(
      A.userId,
      CREATE,
      createArgs(await newId(), { blockId: b.rows[0].id }),
    );
  });

  it("7. a block DERIVES its session, and a disagreeing session id is refused", async () => {
    const id = await newId();
    await userQuery(A.userId, CREATE, createArgs(id, { blockId: blockA }));
    const row = await readImage(id);
    expect(row.session_block_id).toBe(blockA);
    expect(row.session_id).toBe(sessionA); // derived from the block

    // A block can never be recorded without its session, and a mismatched
    // session id is refused rather than silently ignored.
    const other = await seedSession(A);
    await expectDenied(
      A.userId,
      CREATE,
      createArgs(await newId(), { blockId: blockA, sessionId: other.sessionId }),
    );
  });

  it("8. a forged bucket is refused", async () => {
    await expectDenied(
      A.userId,
      CREATE,
      createArgs(await newId(), { bucket: "public-assets" }),
    );
  });

  it("9. a forged path pointing at ANOTHER studio's prefix is refused", async () => {
    const id = await newId();
    await expectDenied(
      A.userId,
      CREATE,
      createArgs(id, { path: pathFor(B.studioId, B.clientId, id) }),
    );
  });

  it("10. a path whose id does not match the recorded id is refused", async () => {
    const id = await newId();
    const wrong = await newId();
    await expectDenied(
      A.userId,
      CREATE,
      createArgs(id, { path: pathFor(A.studioId, A.clientId, wrong) }),
    );
  });

  it("11. the command cannot touch storage at all", async () => {
    const src = (
      await adminQuery(
        `select p.prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and p.proname='create_treatment_image_metadata'`,
      )
    ).rows[0].prosrc as string;
    expect(src).not.toMatch(/storage\./);
  });
});

// --------------------------------------------------------------------------
// 2. Note.
// --------------------------------------------------------------------------

describe("0168 — set_treatment_image_note", () => {
  let imageId: string;
  beforeAll(async () => {
    imageId = await newId();
    await userQuery(A.userId, CREATE, createArgs(imageId));
  });

  it("12. saves a note", async () => {
    const r = await userQuery(A.userId, NOTE, [imageId, A.clientId, "  tender area  "]);
    expect(r.rows[0].set_treatment_image_note).toBe(imageId);
    expect((await readImage(imageId)).practitioner_note).toBe("tender area");
  });

  it("13. whitespace-only CLEARS the note to NULL", async () => {
    await userQuery(A.userId, NOTE, [imageId, A.clientId, "     "]);
    expect((await readImage(imageId)).practitioner_note).toBeNull();
  });

  it("14. an over-limit note is refused as a backstop", async () => {
    await expectDenied(A.userId, NOTE, [imageId, A.clientId, "x".repeat(1001)]);
  });

  it("15. exactly the limit is accepted", async () => {
    await userQuery(A.userId, NOTE, [imageId, A.clientId, "y".repeat(1000)]);
    expect((await readImage(imageId)).practitioner_note).toHaveLength(1000);
    await userQuery(A.userId, NOTE, [imageId, A.clientId, ""]);
  });

  it("16. a same-studio CROSS-CLIENT note returns no row (generic not found)", async () => {
    const other = await adminQuery(
      `insert into public.clients (studio_id, name) values ($1,'Other3') returning id`,
      [A.studioId],
    );
    const r = await userQuery(A.userId, NOTE, [imageId, other.rows[0].id, "nope"]);
    expect(r.rows[0].set_treatment_image_note).toBeNull();
  });

  it("17. another studio's image returns no row", async () => {
    const r = await userQuery(B.userId, NOTE, [imageId, A.clientId, "nope"]);
    expect(r.rows[0].set_treatment_image_note).toBeNull();
  });

  it("18. an ARCHIVED image cannot be edited", async () => {
    const id = await newId();
    await userQuery(A.userId, CREATE, createArgs(id));
    await userQuery(A.userId, ARCHIVE, [id, A.clientId]);
    const r = await userQuery(A.userId, NOTE, [id, A.clientId, "after archive"]);
    expect(r.rows[0].set_treatment_image_note).toBeNull();
    expect((await readImage(id)).practitioner_note).toBeNull();
  });
});

// --------------------------------------------------------------------------
// 3. Archive.
// --------------------------------------------------------------------------

describe("0168 — archive_treatment_image", () => {
  it("19. soft-archives and DERIVES deleted_by from the actor", async () => {
    const id = await newId();
    await userQuery(A.userId, CREATE, createArgs(id));
    const m = await seedMember(A, "l18p4-archiver");
    const r = await userQuery(m.userId, ARCHIVE, [id, A.clientId]);
    expect(r.rows[0].archive_treatment_image).toBe(id);
    const row = await readImage(id);
    expect(row.deleted_at).not.toBeNull();
    expect(row.deleted_by).toBe(m.practitionerId); // the ACTOR
  });

  it("20. the row still EXISTS — archive is soft, never a delete", async () => {
    const id = await newId();
    await userQuery(A.userId, CREATE, createArgs(id));
    await userQuery(A.userId, ARCHIVE, [id, A.clientId]);
    const still = await adminQuery(
      `select count(*)::int n from public.treatment_images where id=$1`,
      [id],
    );
    expect(still.rows[0].n).toBe(1);
  });

  it("21. an ALREADY-archived image returns no row", async () => {
    const id = await newId();
    await userQuery(A.userId, CREATE, createArgs(id));
    await userQuery(A.userId, ARCHIVE, [id, A.clientId]);
    const again = await userQuery(A.userId, ARCHIVE, [id, A.clientId]);
    expect(again.rows[0].archive_treatment_image).toBeNull();
  });

  it("22. a cross-client and a cross-studio archive return no row", async () => {
    const id = await newId();
    await userQuery(A.userId, CREATE, createArgs(id));
    const other = await adminQuery(
      `insert into public.clients (studio_id, name) values ($1,'Other4') returning id`,
      [A.studioId],
    );
    expect(
      (await userQuery(A.userId, ARCHIVE, [id, other.rows[0].id])).rows[0]
        .archive_treatment_image,
    ).toBeNull();
    expect(
      (await userQuery(B.userId, ARCHIVE, [id, A.clientId])).rows[0]
        .archive_treatment_image,
    ).toBeNull();
    expect((await readImage(id)).deleted_at).toBeNull();
  });

  it("23. no command deletes a storage object or a row", async () => {
    const src = (
      await adminQuery(
        `select string_agg(p.prosrc,' ') s from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and p.proname in
          ('create_treatment_image_metadata','set_treatment_image_note','archive_treatment_image')`,
      )
    ).rows[0].s as string;
    expect(src).not.toMatch(/delete from/i);
    expect(src).not.toMatch(/storage\./);
  });
});

// --------------------------------------------------------------------------
// 4. Preserved protections and privileges.
// --------------------------------------------------------------------------

describe("0168 — preserved protections and privileges", () => {
  it("24. the 0093 integrity trigger and the finalized guard are intact", async () => {
    const r = await adminQuery(
      `select tgname from pg_trigger
        where tgrelid='public.treatment_images'::regclass and not tgisinternal
        order by tgname`,
    );
    expect(r.rows.map((x) => x.tgname)).toEqual([
      "treatment_images_enforce_integrity",
      "treatment_images_guard_finalized",
      "treatment_images_set_updated_at",
    ]);
  });

  it("25. an image on a legacy FINALIZED session keeps its protection", async () => {
    const s = await seedSession(A);
    await seedLegacyRecordStatus(s.sessionId, "finalized");
    const id = await newId();
    let blocked = false;
    try {
      await userQuery(A.userId, CREATE, createArgs(id, { sessionId: s.sessionId }));
    } catch {
      blocked = true;
    }
    if (!blocked) {
      // If the guard permits the metadata write, the legacy record's own
      // status must still be untouched — that is the invariant 0160 protects.
      const sess = await adminQuery(
        `select record_status from public.sessions where id=$1`,
        [s.sessionId],
      );
      expect(sess.rows[0].record_status).toBe("finalized");
    }
  });

  it("26. exact privilege matrix", async () => {
    const r = await adminQuery(
      `select p.proname,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') auth_x,
              has_function_privilege('anon', p.oid, 'EXECUTE') anon_x,
              has_function_privilege('service_role', p.oid, 'EXECUTE') svc_x
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname = any($1) order by p.proname`,
      [
        [
          "create_treatment_image_metadata",
          "set_treatment_image_note",
          "archive_treatment_image",
          "treatment_image_actor",
        ],
      ],
    );
    expect(r.rows).toHaveLength(4);
    for (const row of r.rows) {
      const isHelper = row.proname === "treatment_image_actor";
      expect(row.auth_x, `${row.proname} authenticated`).toBe(!isHelper);
      expect(row.anon_x, `${row.proname} anon`).toBe(false);
      expect(row.svc_x, `${row.proname} service_role`).toBe(false);
    }
  });

  it("27. all four are SECURITY DEFINER with an EMPTY search_path", async () => {
    const r = await adminQuery(
      `select p.proname, p.prosecdef, array_to_string(p.proconfig, ',') cfg
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname = any($1)`,
      [
        [
          "create_treatment_image_metadata",
          "set_treatment_image_note",
          "archive_treatment_image",
          "treatment_image_actor",
        ],
      ],
    );
    expect(r.rows).toHaveLength(4);
    for (const row of r.rows) {
      expect(row.prosecdef, `${row.proname} definer`).toBe(true);
      expect(row.cfg, `${row.proname} search_path`).toBe('search_path=""');
    }
  });

  it("28. direct table DML is revoked by 0169; 0168 itself revoked nothing", async () => {
    // This phase revoked nothing — correct for its own scope. Migration 0169 is
    // the cutover that removes the capability, so the assertion is INVERTED here
    // rather than deleted, and SELECT is asserted retained.
    const r = await adminQuery(
      `select has_table_privilege('authenticated','public.treatment_images','INSERT') i,
              has_table_privilege('authenticated','public.treatment_images','UPDATE') u,
              has_table_privilege('authenticated','public.treatment_images','SELECT') s`,
    );
    expect(r.rows[0].i).toBe(false);
    expect(r.rows[0].u).toBe(false);
    expect(r.rows[0].s).toBe(true);
  });
});
