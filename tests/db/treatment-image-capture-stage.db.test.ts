// TREATMENT IMAGE CAPTURE STAGE — 0232 (FETT photos, HON-43).
//
// A practitioner labels a VISIT photo as taken before or after treatment.
// Proved here against a real database, with synthetic rows only:
//   * set 'before', change to 'after', clear with null; area photos too;
//   * the column admits only 'before' / 'after' (CHECK), even on a direct
//     admin UPDATE, and the command refuses anything else;
//   * a CLIENT-scoped photo (no visit) cannot carry a stage;
//   * an archived photo, another client's id pairing, another studio, a
//     DEACTIVATED practitioner and a RECEPTIONIST all get NULL and change
//     nothing; anon cannot call it (EXECUTE revoked);
//   * the new column never blocks the existing create / note / archive path;
//   * a photo on a LEGACY finalized or void session (0159) gets NULL before any
//     write, never the finalized guard's raise.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
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

const CHECK_VIOLATION = "23514";
const INSUFFICIENT_PRIVILEGE = "42501";

const CREATE = `select public.create_treatment_image_metadata($1,$2,$3,$4,$5,$6,$7,$8,$9) id`;
const ARCHIVE = `select public.archive_treatment_image($1,$2) id`;
const NOTE = `select public.set_treatment_image_note($1,$2,$3) id`;
const STAGE = `select public.set_treatment_image_capture_stage($1,$2,$3) id`;

let A: SeededStudio;
let B: SeededStudio;
let otherClientInA: string;
let visitA: { sessionId: string; blockId: string };
let visitB: { sessionId: string; blockId: string };

/** Create an image through the REAL write command, as the studio's owner. */
async function image(
  s: SeededStudio,
  clientId: string,
  scope: { sessionId?: string; blockId?: string } = {},
): Promise<string> {
  const id = randomUUID();
  const res = await userQuery(s.userId, CREATE, [
    id,
    clientId,
    scope.sessionId ?? null,
    scope.blockId ?? null,
    "treatment-images",
    `${s.studioId}/${clientId}/${id}.jpg`,
    "synthetic.jpg",
    "image/jpeg",
    1024,
  ]);
  return res.rows[0].id as string;
}

async function stageOf(imageId: string): Promise<string | null> {
  const r = await adminQuery(`select capture_stage from public.treatment_images where id = $1`, [imageId]);
  return (r.rows[0]?.capture_stage as string | null) ?? null;
}

async function refusal(p: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; message: string };
    return { code: err.code, message: err.message };
  }
  throw new Error("expected a refusal, but the call succeeded");
}

beforeAll(async () => {
  A = await seedStudio("stage-a");
  B = await seedStudio("stage-b");
  otherClientInA = randomUUID();
  await adminQuery(`insert into public.clients (id, studio_id, name) values ($1, $2, 'Client other-a')`, [
    otherClientInA,
    A.studioId,
  ]);
  visitA = await seedSession(A);
  visitB = await seedSession(B);
});
afterAll(async () => {
  await closePool();
});

describe("0232: labelling a visit photo", () => {
  it("existing and new photos start UNLABELLED", async () => {
    const img = await image(A, A.clientId, { sessionId: visitA.sessionId });
    expect(await stageOf(img)).toBeNull();
  });

  it("an active practitioner sets before, changes it to after, and clears it", async () => {
    const img = await image(A, A.clientId, { sessionId: visitA.sessionId });
    expect((await userQuery(A.userId, STAGE, [img, A.clientId, "before"])).rows[0].id).toBe(img);
    expect(await stageOf(img)).toBe("before");
    await userQuery(A.userId, STAGE, [img, A.clientId, "after"]);
    expect(await stageOf(img)).toBe("after");
    await userQuery(A.userId, STAGE, [img, A.clientId, null]);
    expect(await stageOf(img)).toBeNull();
  });

  it("a treatment-AREA photo of the visit can be labelled too", async () => {
    const img = await image(A, A.clientId, { sessionId: visitA.sessionId, blockId: visitA.blockId });
    await userQuery(A.userId, STAGE, [img, A.clientId, "after"]);
    expect(await stageOf(img)).toBe("after");
  });

  it("the existing note and archive commands still work on a labelled photo", async () => {
    const img = await image(A, A.clientId, { sessionId: visitA.sessionId });
    await userQuery(A.userId, STAGE, [img, A.clientId, "before"]);
    expect((await userQuery(A.userId, NOTE, [img, A.clientId, "synthetic note"])).rows[0].id).toBe(img);
    expect((await userQuery(A.userId, ARCHIVE, [img, A.clientId])).rows[0].id).toBe(img);
    expect(await stageOf(img), "archiving does not rewrite the label").toBe("before");
  });
});

describe("0232: only 'before' or 'after', only on a visit photo", () => {
  it("the command refuses any other value and writes nothing", async () => {
    const img = await image(A, A.clientId, { sessionId: visitA.sessionId });
    for (const bad of ["during", "BEFORE", ""]) {
      const r = await refusal(userQuery(A.userId, STAGE, [img, A.clientId, bad]));
      expect(r.code, bad).toBe(CHECK_VIOLATION);
    }
    expect(await stageOf(img)).toBeNull();
  });

  it("the column CHECK refuses it even on a direct admin UPDATE", async () => {
    const img = await image(A, A.clientId, { sessionId: visitA.sessionId });
    const r = await refusal(
      adminQuery(`update public.treatment_images set capture_stage = 'during' where id = $1`, [img]),
    );
    expect(r.code).toBe(CHECK_VIOLATION);
    expect(await stageOf(img)).toBeNull();
  });

  it("a CLIENT-scoped photo (no visit) cannot carry a stage; clearing it is a no-op", async () => {
    const img = await image(A, A.clientId);
    const r = await refusal(userQuery(A.userId, STAGE, [img, A.clientId, "before"]));
    expect(r.code).toBe(CHECK_VIOLATION);
    expect(r.message).toMatch(/Only a photo from a visit can be marked before or after\./);
    expect(await stageOf(img)).toBeNull();
    expect((await userQuery(A.userId, STAGE, [img, A.clientId, null])).rows[0].id).toBe(img);
  });

  it("a signed-in practitioner cannot bypass the command with a direct UPDATE", async () => {
    const img = await image(A, A.clientId, { sessionId: visitA.sessionId });
    const r = await refusal(
      userQuery(A.userId, `update public.treatment_images set capture_stage = 'before' where id = $1`, [img]),
    );
    // Direct clinical DML is revoked from authenticated (0169): never a write.
    expect(r.code).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await stageOf(img)).toBeNull();
  });
});

describe("0232: every wrong target or actor gets NULL and changes nothing", () => {
  it("an archived photo", async () => {
    const img = await image(A, A.clientId, { sessionId: visitA.sessionId });
    await userQuery(A.userId, ARCHIVE, [img, A.clientId]);
    expect((await userQuery(A.userId, STAGE, [img, A.clientId, "before"])).rows[0].id).toBeNull();
    expect(await stageOf(img)).toBeNull();
  });

  it("the right photo paired with ANOTHER client's id", async () => {
    const img = await image(A, A.clientId, { sessionId: visitA.sessionId });
    expect((await userQuery(A.userId, STAGE, [img, otherClientInA, "before"])).rows[0].id).toBeNull();
    expect(await stageOf(img)).toBeNull();
  });

  it("a practitioner of ANOTHER studio, even for a client-scoped photo (no scope disclosed)", async () => {
    const visit = await image(A, A.clientId, { sessionId: visitA.sessionId });
    const clientScoped = await image(A, A.clientId);
    expect((await userQuery(B.userId, STAGE, [visit, A.clientId, "before"])).rows[0].id).toBeNull();
    // Same NULL for a photo the caller would otherwise learn is client-scoped.
    expect((await userQuery(B.userId, STAGE, [clientScoped, A.clientId, "before"])).rows[0].id).toBeNull();
    expect(await stageOf(visit)).toBeNull();
    // B's own visit photo still works: the refusal is about A's row, not B.
    const own = await image(B, B.clientId, { sessionId: visitB.sessionId });
    expect((await userQuery(B.userId, STAGE, [own, B.clientId, "after"])).rows[0].id).toBe(own);
  });

  it("a DEACTIVATED practitioner of the same studio (active positive control first)", async () => {
    const member = await seedMember(A, "stage-deact");
    const img = await image(A, A.clientId, { sessionId: visitA.sessionId });
    expect((await userQuery(member.userId, STAGE, [img, A.clientId, "before"])).rows[0].id).toBe(img);
    await adminQuery(`update public.practitioners set active = false where id = $1`, [member.practitionerId]);
    expect((await userQuery(member.userId, STAGE, [img, A.clientId, "after"])).rows[0].id).toBeNull();
    expect(await stageOf(img)).toBe("before");
  });

  it("a RECEPTIONIST of the same studio (no practitioners row)", async () => {
    const userId = randomUUID();
    await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [
      userId,
      `stage-recept-${userId.slice(0, 8)}@harness.local`,
    ]);
    await adminQuery(
      `insert into public.studio_receptionists (studio_id, user_id, display_name, active)
       values ($1, $2, 'Synthetic Front Desk', true)`,
      [A.studioId, userId],
    );
    const img = await image(A, A.clientId, { sessionId: visitA.sessionId });
    expect((await userQuery(userId, STAGE, [img, A.clientId, "before"])).rows[0].id).toBeNull();
    expect(await stageOf(img)).toBeNull();
  });

  it("anon cannot even call it (EXECUTE revoked)", async () => {
    const r = await refusal(asRole("anon", (q) => q(STAGE, [randomUUID(), randomUUID(), null])));
    expect(r.code).toBe(INSUFFICIENT_PRIVILEGE);
  });
});

describe("0232: a LEGACY finalized or void session refuses cleanly (0159 retired finalization)", () => {
  for (const status of ["finalized", "void"] as const) {
    it(`a photo on a ${status} session gets NULL, unchanged, and never raises`, async () => {
      const visit = await seedSession(A);
      const img = await image(A, A.clientId, { sessionId: visit.sessionId });
      // Positive control: labelable while the session is an ordinary record.
      expect((await userQuery(A.userId, STAGE, [img, A.clientId, "before"])).rows[0].id).toBe(img);
      await seedLegacyRecordStatus(visit.sessionId, status);
      // Now immutable: the command refuses BEFORE the finalized guard can raise.
      expect((await userQuery(A.userId, STAGE, [img, A.clientId, "after"])).rows[0].id).toBeNull();
      expect((await userQuery(A.userId, STAGE, [img, A.clientId, null])).rows[0].id).toBeNull();
      expect(await stageOf(img)).toBe("before");
    });
  }
});

describe("0232: privilege matrix", () => {
  it("authenticated only; anon and service_role cannot execute; definer with empty search_path", async () => {
    const r = await adminQuery(
      `select has_function_privilege('authenticated', p.oid, 'EXECUTE') auth_x,
              has_function_privilege('anon', p.oid, 'EXECUTE') anon_x,
              has_function_privilege('service_role', p.oid, 'EXECUTE') svc_x,
              p.prosecdef, array_to_string(p.proconfig, ',') cfg
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'set_treatment_image_capture_stage'`,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({
      auth_x: true,
      anon_x: false,
      svc_x: false,
      prosecdef: true,
      cfg: 'search_path=""',
    });
  });
});

// Codex 4308037526: hard-deleting a visit runs 0092's ON DELETE SET NULL on
// session_id. The photo becomes client-scoped, so its before/after label must
// go too, and the delete must still SUCCEED (a CHECK would make the cascade
// throw). Negative control: a photo of a visit that is NOT deleted keeps its
// label and its session.
describe("0232: a photo that loses its visit loses its label (and the visit delete succeeds)", () => {
  it("label → hard-delete the session → session_id and capture_stage are both NULL; the other visit's photo is untouched", async () => {
    const doomed = await seedSession(A);
    const kept = await seedSession(A);
    const goes = await image(A, A.clientId, doomed);
    const stays = await image(A, A.clientId, kept);
    expect((await userQuery(A.userId, STAGE, [goes, A.clientId, "before"])).rows[0].id).toBe(goes);
    expect((await userQuery(A.userId, STAGE, [stays, A.clientId, "after"])).rows[0].id).toBe(stays);
    expect(await stageOf(goes)).toBe("before");

    await adminQuery("delete from public.sessions where id = $1", [doomed.sessionId]); // must not throw

    expect((await adminQuery("select count(*)::int n from public.sessions where id = $1", [doomed.sessionId])).rows[0].n).toBe(0);
    const after = (
      await adminQuery(`select session_id, capture_stage, deleted_at from public.treatment_images where id = $1`, [goes])
    ).rows[0];
    expect(after).toEqual({ session_id: null, capture_stage: null, deleted_at: null });
    // NEGATIVE CONTROL: the surviving visit's photo keeps both.
    const control = (
      await adminQuery(`select session_id, capture_stage from public.treatment_images where id = $1`, [stays])
    ).rows[0];
    expect(control).toEqual({ session_id: kept.sessionId, capture_stage: "after" });
  });

  it("an unlabelled photo of a deleted visit is simply client-scoped (nothing to clear, nothing refused)", async () => {
    const doomed = await seedSession(A);
    const plain = await image(A, A.clientId, doomed);
    await adminQuery("delete from public.sessions where id = $1", [doomed.sessionId]);
    const row = (await adminQuery(`select session_id, capture_stage from public.treatment_images where id = $1`, [plain])).rows[0];
    expect(row).toEqual({ session_id: null, capture_stage: null });
  });

  it("the trigger function is not callable by any API role", async () => {
    const r = await adminQuery(
      `select has_function_privilege('authenticated', p.oid, 'EXECUTE') auth_x,
              has_function_privilege('anon', p.oid, 'EXECUTE') anon_x,
              has_function_privilege('service_role', p.oid, 'EXECUTE') svc_x
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'treatment_images_clear_stage_without_session'`,
    );
    expect(r.rows).toEqual([{ auth_x: false, anon_x: false, svc_x: false }]);
  });
});
