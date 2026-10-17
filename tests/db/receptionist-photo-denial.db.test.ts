import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, asUser, closePool } from "./helpers/harness";
import { dropSynthStudio, seedSynthStudioB, type SynthStudio } from "./helpers/synth-fleet";
import { randomUUID } from "node:crypto";

// ===========================================================================
// #824 ROLE MATRIX — the receptionist is denied the CLIENT PHOTO surface.
// ===========================================================================
//
// WHY THIS IS A DB TEST AND NOT A BROWSER TEST. A signed URL is bearer access
// once it exists, so "the link is not on the page" is not a denial. The claim
// has to be made at the MINTING step. There are exactly two minting sites,
// both server-side:
//
//   * app/(app)/clients/[id]/images/page.tsx  — createSignedUrl at :119, :150,
//     reached only after requirePractitionerWithStudio(), which redirects a
//     non-practitioner to /no-access (lib/supabase/queries.ts:251-278). A
//     receptionist never reaches the page body.
//   * app/(app)/clients/[id]/images/actions.ts — getTreatmentImageSignedUrlAction
//     READS THE ROW FIRST and signs at :326. That action is auth-gated only and
//     lets the DATABASE decide, which is the plane a direct server-action POST
//     actually hits.
//
// WHAT THIS SUITE PROVES, AND WHAT IT DOES NOT. The signing action has three
// barriers, and this file owns only the second:
//
//   1. IDENTITY (primary, app layer) — getCurrentPractitionerWithStudio()
//      THROWS "No active practitioner found for the signed-in user." for a
//      membership of none (lib/supabase/queries.ts:218-220), before any query.
//      Pinned by tests/source-guards/photo-signing-sites.test.ts, shown in the
//      browser spec. NOT proven here.
//   2. THE ROW READ — studio-scoped and under RLS; no row, no signature.
//      THIS FILE. For a receptionist the read yields NOTHING, so
//      createSignedUrl is unreachable even if barrier 1 were removed.
//   3. PATH BINDING — validateTreatmentImagePath, before the service-role
//      signer. NOT proven here.
//
// Stated this way on purpose: if someone later changes RLS and this suite goes
// red, barrier 1 may still be denying, and if someone removes barrier 1 this
// suite will still pass. Neither file alone is the denial.
//
// THE DENIAL IS STRUCTURAL, NOT AN ALLOWLIST. A receptionist is a
// studio_receptionists row and NOT a practitioners row, and every policy and
// command resolves its actor through practitioners. Nothing here is
// receptionist-specific; that is the point.
//
// Synthetic studios only, created and dropped here. No production read, no
// hosted write, no provider contact.

let S: SynthStudio;
let receptionistUserId = "";
let imageId = "";
let sessionId = "";

const owner = () => S.practitioners.find((p) => p.role === "owner")!;
const P1 = () => S.practitioners[1];

const NOTE = `select public.set_treatment_image_note($1,$2,$3)`;
const ARCHIVE = `select public.archive_treatment_image($1,$2)`;
const CREATE = `select public.create_treatment_image_metadata($1,$2,$3,$4,$5,$6,$7,$8,$9)`;

const errCode = (e: unknown) => (e as { code?: string }).code;
const pathFor = (studioId: string, clientId: string, id: string) =>
  `${studioId}/${clientId}/${id}.jpg`;

/** Ran as the receptionist's real JWT, not as a role. */
const asReceptionist = <T>(fn: Parameters<typeof asUser<T>>[1]) =>
  asUser<T>(receptionistUserId, fn);
const asOwner = <T>(fn: Parameters<typeof asUser<T>>[1]) => asUser<T>(owner().userId, fn);

beforeAll(async () => {
  S = await seedSynthStudioB();

  // A session to hang the image off, and ONE treatment image. Seeded with the
  // admin client on purpose: the seed is not the property under test.
  const ses = await adminQuery(
    `insert into public.sessions (studio_id, client_id, practitioner_id, modality)
     values ($1, $2, $3, 'electrolysis') returning id`,
    [S.studioId, S.clientId, P1().practitionerId],
  );
  sessionId = ses.rows[0].id as string;

  imageId = randomUUID();
  await adminQuery(
    `insert into public.treatment_images
       (id, studio_id, client_id, session_id, session_block_id,
        storage_bucket, storage_path, original_filename, content_type,
        size_bytes, uploaded_by)
     values ($1, $2, $3, $4, null, 'treatment-images', $5, 'jaw.jpg',
        'image/jpeg', 2048, $6)`,
    [imageId, S.studioId, S.clientId, sessionId, pathFor(S.studioId, S.clientId, imageId), P1().practitionerId],
  );

  // The receptionist: an auth user whose ONLY membership is studio_receptionists.
  receptionistUserId = randomUUID();
  await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [
    receptionistUserId,
    `front-desk-${receptionistUserId.slice(0, 8)}@harness.local`,
  ]);
  await adminQuery(
    `select public.add_studio_receptionist($1, $2, $3, 'Front Desk', 'desk@example.test')`,
    [S.studioId, owner().practitionerId, receptionistUserId],
  );
});

afterAll(async () => {
  if (S) {
    // treatment_images and sessions reference the practitioner with RESTRICT,
    // so they go before the studio cascade.
    // The seeded storage.objects row is NOT deleted, and cannot be: Supabase's
    // own guard raises "Direct deletion from storage tables is not allowed. Use
    // the Storage API instead." That API is excluded from every CI lane
    // (-x ...,storage-api), so there is no permitted cleanup path here, and the
    // insert has to be committed for the receptionist's own session to see it,
    // so a rollback is not available either. The row is inert, confined to this
    // test's synthetic studio folder, and every stack this suite runs on is
    // disposable per run.
    await adminQuery(`delete from public.treatment_images where studio_id = $1`, [S.studioId]);
    await adminQuery(`delete from public.sessions where studio_id = $1`, [S.studioId]);
    await dropSynthStudio(S);
  }
  if (receptionistUserId) {
    await adminQuery(`delete from auth.users where id = $1`, [receptionistUserId]);
  }
  await closePool();
});

describe("#824: the receptionist cannot reach a client photo", () => {
  it("is a receptionist and NOT a practitioner (the mechanism everything else rests on)", async () => {
    const m = await adminQuery(
      `select count(*)::int n from public.studio_receptionists
        where studio_id = $1 and user_id = $2 and deactivated_at is null`,
      [S.studioId, receptionistUserId],
    );
    expect(m.rows[0].n).toBe(1);
    const p = await adminQuery(`select count(*)::int n from public.practitioners where user_id = $1`, [
      receptionistUserId,
    ]);
    expect(p.rows[0].n, "a receptionist must have NO practitioners row").toBe(0);
  });

  it("READS ZERO treatment_images rows — so the signing action can never reach createSignedUrl", async () => {
    // getTreatmentImageSignedUrlAction reads the row, then signs. No row, no
    // signature. This is the denial AT THE MINTING STEP.
    const rows = await asReceptionist((q) =>
      q(`select id from public.treatment_images where client_id = $1`, [S.clientId]),
    );
    expect(rows.rows, "a receptionist must see no treatment image rows").toEqual([]);
  });

  it("cannot read the storage_path even when it already knows the image id", async () => {
    // A receptionist who learned an id elsewhere still gets nothing to sign.
    const rows = await asReceptionist((q) =>
      q(`select storage_path, storage_bucket from public.treatment_images where id = $1`, [imageId]),
    );
    expect(rows.rows).toEqual([]);
  });

  it("cannot CREATE image metadata", async () => {
    let code: string | undefined;
    try {
      await asReceptionist((q) =>
        q(CREATE, [
          randomUUID(), S.clientId, sessionId, null,
          "treatment-images", pathFor(S.studioId, S.clientId, randomUUID()),
          "x.jpg", "image/jpeg", 1024,
        ]),
      );
    } catch (e) {
      code = errCode(e);
    }
    expect(code, "create_treatment_image_metadata must refuse a receptionist").toBeDefined();
  });

  // MEASURED, and it corrected my own assumption. I first asserted that these
  // commands RAISE for a receptionist. They do not: they return NULL and write
  // nothing, because the UPDATE is RLS-scoped and matches zero rows, so
  // `returning id into v_id` yields NULL. create_treatment_image_metadata DOES
  // raise (above), so the three commands REFUSE IN TWO DIFFERENT SHAPES and a
  // caller has to handle both.
  //
  // BOTH HALVES ARE ASSERTED DELIBERATELY. A null return alone would be
  // satisfied by a command that wrote the row and merely failed to report an
  // id; an untouched row alone would be satisfied by a command that reported
  // success. Neither is a denial on its own.
  it("SET A NOTE is a silent no-op: returns NULL and writes nothing", async () => {
    const r = await asReceptionist((q) => q(NOTE, [imageId, S.clientId, "front desk note"]));
    expect(r.rows[0].set_treatment_image_note, "must not return an id").toBeNull();
    const row = await adminQuery(
      `select practitioner_note from public.treatment_images where id = $1`,
      [imageId],
    );
    expect(row.rows[0].practitioner_note, "the note must be untouched").toBeNull();
  });

  it("ARCHIVE is a silent no-op: returns NULL and the image stays live", async () => {
    const r = await asReceptionist((q) => q(ARCHIVE, [imageId, S.clientId]));
    expect(r.rows[0].archive_treatment_image, "must not return an id").toBeNull();
    const still = await adminQuery(
      `select deleted_at from public.treatment_images where id = $1`,
      [imageId],
    );
    expect(still.rows[0].deleted_at, "the image must still be live").toBeNull();
  });

  // =========================================================================
  // NON-VACUITY. Without this block, every assertion above is satisfied by a
  // studio that simply has no photos, or by a harness whose JWT reaches
  // nothing at all. The OWNER must see exactly what the receptionist cannot.
  // =========================================================================
  it("THE DENIAL IS NOT VACUOUS: the owner reads the same seeded image", async () => {
    const rows = await asOwner((q) =>
      q(`select id, storage_path from public.treatment_images where client_id = $1`, [S.clientId]),
    );
    expect(rows.rows.length, "the owner must see the seeded image").toBe(1);
    expect(rows.rows[0].id).toBe(imageId);
    expect(rows.rows[0].storage_path, "and the path a signature would be minted from").toContain(
      S.clientId,
    );
  });

  it("THE DENIAL IS NOT VACUOUS: the owner can set a note the receptionist could not", async () => {
    await asOwner((q) => q(NOTE, [imageId, S.clientId, "owner note"]));
    // The column is `practitioner_note` (0168 writes it; 0156 created it), not
    // `note` — selecting the wrong name would fail as a SQL error and read
    // like a denial that had stopped working.
    const row = await adminQuery(
      `select practitioner_note from public.treatment_images where id = $1`,
      [imageId],
    );
    expect(row.rows[0].practitioner_note).toBe("owner note");
  });

  it("storage RLS: a receptionist reads NO treatment-images object", async () => {
    // BEHAVIOUR, NOT A POLICY-ROLE COUNT (Codex P2 4301919095). This assertion
    // used to be "no authenticated policy exists on storage.objects", which was
    // wrong in BOTH directions: a leaking policy declared `TO public` has
    // roles = {public} and would have PASSED it, while 0092's own SAFE policy
    // ("treatment_images_objects: members select" ... to authenticated using
    // bucket_id = 'treatment-images' and is_studio_member(folder[1]),
    // 0092_treatment_images.sql:113-119) would make it FAIL wherever the
    // migration role can install it. It passed on my stack only because that
    // creation was skipped there. Predicates decide access; role names do not.
    const objectName = `${S.studioId}/${S.clientId}/${imageId}.jpg`;
    await adminQuery(
      `insert into storage.objects (bucket_id, name, owner)
       values ('treatment-images', $1, null)
       on conflict do nothing`,
      [objectName],
    );

    const desk = await asReceptionist((q) =>
      q(
        `select name from storage.objects
          where bucket_id = 'treatment-images' and name = $1`,
        [objectName],
      ),
    );
    expect(desk.rows, "a receptionist must read no treatment-images object").toEqual([]);

    // NON-VACUITY, available only where 0092's CONDITIONAL policy installed.
    // The receptionist's denial holds either way — is_studio_member is false
    // for a non-practitioner, and with no authenticated policy nothing is
    // readable at all — but only an installed policy makes the denial
    // DISTINGUISHING. The test states which case it is in rather than claiming
    // a guarantee the stack may not provide.
    const installed = await adminQuery(
      `select count(*)::int n from pg_policies
        where schemaname = 'storage' and tablename = 'objects'
          and policyname = 'treatment_images_objects: members select'`,
    );
    const owner = await asOwner((q) =>
      q(`select name from storage.objects where name = $1`, [objectName]),
    );
    if (installed.rows[0].n === 1) {
      expect(
        owner.rows.length,
        "0092's policy IS installed, so the OWNER must read the object the receptionist could not",
      ).toBe(1);
    } else {
      expect(
        owner.rows,
        "0092's policy is NOT installed on this stack, so no authenticated role reads it — " +
          "the receptionist denial is real but not distinguishing here",
      ).toEqual([]);
    }
  });
});
