// CLIENT IDENTIFICATION PHOTO STORE — 0275 (FETT photos, HON-43, P2). HELD.
//
// Proved against a real database with synthetic rows only:
//   * OFF by default IN THE DATABASE: no command writes while the switch is off;
//   * consent is explicit, in person, by the client, recorded with provider,
//     recorder, time, wording version AND hash, and is append-only;
//   * the photo is readable (RLS) only by an active owner/practitioner of the
//     SAME studio, with the switch ON and a current consent;
//   * withdrawal, removal and client archive delete the row at once, queue the
//     object, and write an image-free audit event; treatment_images is untouched;
//   * every wrong actor is refused non-disclosingly;
//   * the 0231 bypass is closed: set_client_portrait is uncallable and the
//     pointer cannot be set by a direct column update.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  adminQuery,
  asRole,
  closePool,
  seedMember,
  seedStudio,
  userQuery,
  type SeededStudio,
} from "./helpers/harness";

const CHECK_VIOLATION = "23514";
const INSUFFICIENT_PRIVILEGE = "42501";
const P0275 = "P0275";

let A: SeededStudio;
let B: SeededStudio;
let memberA: { userId: string; practitionerId: string };
let WORDING: { version: string; sha: string };

async function refusal(p: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; message: string };
    return { code: err.code, message: err.message };
  }
  throw new Error("expected a refusal, but the call succeeded");
}

const enable = (studioId: string, on: boolean) =>
  adminQuery(`select public.set_client_id_photo_enabled($1,$2,'synthetic test')`, [studioId, on]);

const consent = (userId: string, clientId: string, over: Partial<{ channel: string; by: string; sha: string }> = {}) =>
  userQuery(userId, `select public.record_client_id_photo_consent($1,$2,$3,$4,$5) id`, [
    clientId,
    WORDING.version,
    over.sha ?? WORDING.sha,
    over.channel ?? "in_person",
    over.by ?? "client",
  ]);

const pathFor = (s: SeededStudio, clientId: string) => `${s.studioId}/${clientId}/${randomUUID()}.webp`;

const setPhoto = (userId: string, clientId: string, path: string) =>
  userQuery(userId, `select public.set_client_id_photo($1,$2,$3,$4,$5) id`, [clientId, path, 20000, 512, 512]);

const readable = async (userId: string, clientId: string) =>
  (await userQuery(userId, `select client_id from public.client_id_photos where client_id = $1`, [clientId])).rows.length;

const rowCount = async (sql: string, args: unknown[]) =>
  Number((await adminQuery(sql, args)).rows[0].n);

async function newClient(s: SeededStudio): Promise<string> {
  const id = randomUUID();
  await adminQuery(`insert into public.clients (id, studio_id, name) values ($1,$2,'Client extra')`, [id, s.studioId]);
  return id;
}

beforeAll(async () => {
  A = await seedStudio("idphoto-a");
  B = await seedStudio("idphoto-b");
  memberA = await seedMember(A, "idphoto-member");
  const w = await adminQuery(`select version, wording_sha256 from public.client_id_photo_wording_versions where version = 'v1.1'`);
  WORDING = { version: w.rows[0].version, sha: w.rows[0].wording_sha256 };
  // The seeded wording is UNAPPROVED; an operator approves it for these tests only.
  await adminQuery(`select public.approve_client_id_photo_wording('v1.1')`);
});
afterAll(async () => {
  await closePool();
});

describe("0275: OFF by default, enforced in the database", () => {
  it("a studio with no settings row is OFF and every write command refuses", async () => {
    const c = A.clientId;
    expect((await userQuery(A.userId, `select public.client_id_photo_enabled($1) e`, [A.studioId])).rows[0].e).toBe(false);
    expect((await refusal(consent(A.userId, c))).code).toBe(CHECK_VIOLATION);
    expect((await refusal(setPhoto(A.userId, c, pathFor(A, c)))).code).toBe(CHECK_VIOLATION);
  });

  it("the switch and the wording approval are operator-only: no API role can call them", async () => {
    for (const role of ["anon", "authenticated", "service_role"] as const) {
      const r = await refusal(
        asRole(role, (q) => q(`select public.set_client_id_photo_enabled($1,true,'x')`, [A.studioId])),
      );
      expect(r.code).toBe(INSUFFICIENT_PRIVILEGE);
      const w = await refusal(asRole(role, (q) => q(`select public.approve_client_id_photo_wording('v1.1')`)));
      expect(w.code).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  it("every switch change is logged append-only", async () => {
    await enable(A.studioId, true);
    await enable(A.studioId, false);
    const n = await rowCount(`select count(*) n from public.studio_client_id_photo_switch_log where studio_id = $1`, [A.studioId]);
    expect(n).toBe(2);
    const r = await refusal(adminQuery(`update public.studio_client_id_photo_switch_log set reason = 'x' where studio_id = $1`, [A.studioId]));
    expect(r.code).toBe(INSUFFICIENT_PRIVILEGE);
  });
});

describe("0275: consent", () => {
  beforeAll(async () => {
    await enable(A.studioId, true);
  });

  it("records who PROVIDED, who RECORDED, channel, time, wording version and hash", async () => {
    const c = await newClient(A);
    await consent(memberA.userId, c);
    const r = await adminQuery(
      `select event, provided_by, channel, recorded_by_practitioner_id, wording_version, wording_sha256, recorded_at
         from public.client_id_photo_consents where client_id = $1`,
      [c],
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({
      event: "granted",
      provided_by: "client",
      channel: "in_person",
      recorded_by_practitioner_id: memberA.practitionerId,
      wording_version: WORDING.version,
      wording_sha256: WORDING.sha,
    });
    expect(r.rows[0].recorded_at).toBeTruthy();
  });

  it("refuses a representative, the client-form channel (not built), a wrong hash and an unapproved version", async () => {
    const c = await newClient(A);
    expect((await refusal(consent(A.userId, c, { by: "representative" }))).code).toBe(P0275);
    expect((await refusal(consent(A.userId, c, { channel: "client_form" }))).code).toBe(P0275);
    expect((await refusal(consent(A.userId, c, { sha: "0".repeat(64) }))).code).toBe(P0275);
    await adminQuery(
      `insert into public.client_id_photo_wording_versions (version, wording, wording_sha256)
       select 'v9.9', w, encode(sha256(convert_to(w,'UTF8')),'hex') from (select repeat('an unapproved wording. ', 5) w) s
       on conflict do nothing`,
    );
    const unapproved = await adminQuery(`select wording_sha256 from public.client_id_photo_wording_versions where version='v9.9'`);
    const r = await refusal(
      userQuery(A.userId, `select public.record_client_id_photo_consent($1,'v9.9',$2,'in_person','client')`, [c, unapproved.rows[0].wording_sha256]),
    );
    expect(r.code).toBe(P0275);
    expect(await rowCount(`select count(*) n from public.client_id_photo_consents where client_id = $1`, [c])).toBe(0);
  });

  it("the wording hash is checked by the table and a version cannot be edited", async () => {
    const bad = await refusal(
      adminQuery(`insert into public.client_id_photo_wording_versions (version, wording, wording_sha256) values ('v8.8', repeat('x',60), 'deadbeef')`),
    );
    expect(bad.code).toBe(CHECK_VIOLATION);
    const edit = await refusal(adminQuery(`update public.client_id_photo_wording_versions set wording = repeat('y',60) where version = 'v1.1'`));
    expect(edit.code).toBe(INSUFFICIENT_PRIVILEGE);
    const del = await refusal(adminQuery(`delete from public.client_id_photo_wording_versions where version = 'v1.1'`));
    expect(del.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("evidence is append-only for everyone, including the owner role", async () => {
    const c = await newClient(A);
    await consent(A.userId, c);
    expect((await refusal(adminQuery(`update public.client_id_photo_consents set event = 'withdrawn' where client_id = $1`, [c]))).code).toBe(INSUFFICIENT_PRIVILEGE);
    expect((await refusal(adminQuery(`delete from public.client_id_photo_consents where client_id = $1`, [c]))).code).toBe(INSUFFICIENT_PRIVILEGE);
    // TRUNCATE is refused either by the guard trigger or because an FK references the table.
    expect([INSUFFICIENT_PRIVILEGE, "0A000"]).toContain((await refusal(adminQuery(`truncate public.client_id_photo_consents`))).code);
  });
});

describe("0275: store, read, replace, remove", () => {
  it("needs consent first, then stores; readable by owner and practitioner of the studio only", async () => {
    await enable(A.studioId, true);
    const c = await newClient(A);
    expect((await refusal(setPhoto(A.userId, c, pathFor(A, c)))).code).toBe(P0275);
    await consent(A.userId, c);
    await setPhoto(A.userId, c, pathFor(A, c));
    expect(await readable(A.userId, c)).toBe(1);
    expect(await readable(memberA.userId, c)).toBe(1);
    expect(await readable(B.userId, c)).toBe(0);
  });

  it("is not readable while the switch is OFF, and is readable again when ON", async () => {
    await enable(A.studioId, true);
    const c = await newClient(A);
    await consent(A.userId, c);
    await setPhoto(A.userId, c, pathFor(A, c));
    await enable(A.studioId, false);
    expect(await readable(A.userId, c)).toBe(0);
    await enable(A.studioId, true);
    expect(await readable(A.userId, c)).toBe(1);
  });

  it("refuses wrong actors and wrong paths non-disclosingly", async () => {
    await enable(A.studioId, true);
    const c = await newClient(A);
    await consent(A.userId, c);
    // another studio's practitioner
    expect((await refusal(setPhoto(B.userId, c, pathFor(A, c)))).code).toBe(CHECK_VIOLATION);
    // an unknown client
    expect((await refusal(setPhoto(A.userId, randomUUID(), pathFor(A, c)))).code).toBe(CHECK_VIOLATION);
    // a path in another studio or another client's folder, or the wrong extension
    for (const bad of [pathFor(B, c), `${A.studioId}/${randomUUID()}/${randomUUID()}.webp`, `${A.studioId}/${c}/${randomUUID()}.jpg`]) {
      expect((await refusal(setPhoto(A.userId, c, bad))).code).toBe(CHECK_VIOLATION);
    }
    // a deactivated practitioner
    await adminQuery(`update public.practitioners set active = false where id = $1`, [memberA.practitionerId]);
    expect((await refusal(setPhoto(memberA.userId, c, pathFor(A, c)))).code).toBe(CHECK_VIOLATION);
    await adminQuery(`update public.practitioners set active = true where id = $1`, [memberA.practitionerId]);
    // anon
    const anon = await refusal(asRole("anon", (q) => q(`select public.set_client_id_photo($1,$2,1000,512,512)`, [c, pathFor(A, c)])));
    expect(anon.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("the table accepts no direct write from any API role", async () => {
    for (const role of ["anon", "authenticated", "service_role"] as const) {
      const r = await refusal(
        asRole(role, (q) => q(`insert into public.client_id_photos (client_id, studio_id, storage_path, byte_size, width, height, consent_id, created_by) values ($1,$2,'x',1,64,64,$3,$4)`, [A.clientId, A.studioId, randomUUID(), A.practitionerId])),
      );
      expect(r.code).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  it("replacement queues the OLD object; removal deletes the row at once, queues the object and audits image-free", async () => {
    await enable(A.studioId, true);
    const c = await newClient(A);
    await consent(A.userId, c);
    const first = pathFor(A, c);
    const second = pathFor(A, c);
    await setPhoto(A.userId, c, first);
    await setPhoto(A.userId, c, second);
    const q1 = await adminQuery(`select storage_path from public.client_id_photo_pending_object_deletions where studio_id = $1`, [A.studioId]);
    expect(q1.rows.map((r) => r.storage_path)).toContain(first);
    expect(q1.rows.map((r) => r.storage_path)).not.toContain(second);

    const removed = await userQuery(A.userId, `select public.remove_client_id_photo($1) r`, [c]);
    expect(removed.rows[0].r).toBe(true);
    expect(await readable(A.userId, c)).toBe(0);
    const q2 = await adminQuery(`select storage_path from public.client_id_photo_pending_object_deletions where studio_id = $1`, [A.studioId]);
    expect(q2.rows.map((r) => r.storage_path)).toContain(second);

    const audit = await adminQuery(`select * from public.client_id_photo_audit where client_id = $1 order by seq`, [c]);
    expect(audit.rows.map((r) => r.event)).toEqual(["consent_granted", "photo_set", "photo_replaced", "photo_removed"]);
    // image-free: the audit table has no path, url, filename or text column
    expect(Object.keys(audit.rows[0]).sort()).toEqual(["actor_practitioner_id", "at", "client_id", "event", "seq", "studio_id"]);

    // the queue is drained through the acknowledging command, by an actor of the studio
    const ack = await userQuery(A.userId, `select public.ack_client_id_photo_object_deletion($1) a`, [second]);
    expect(ack.rows[0].a).toBe(true);
    const foreign = await userQuery(B.userId, `select public.ack_client_id_photo_object_deletion($1) a`, [first]);
    expect(foreign.rows[0].a).toBe(false);
    const pendingB = await userQuery(B.userId, `select * from public.pending_client_id_photo_object_deletions(50)`);
    expect(pendingB.rows).toHaveLength(0);
  });

  it("removal still works while the switch is OFF (never trapped)", async () => {
    await enable(A.studioId, true);
    const c = await newClient(A);
    await consent(A.userId, c);
    await setPhoto(A.userId, c, pathFor(A, c));
    await enable(A.studioId, false);
    const removed = await userQuery(A.userId, `select public.remove_client_id_photo($1) r`, [c]);
    expect(removed.rows[0].r).toBe(true);
    expect(await rowCount(`select count(*) n from public.client_id_photos where client_id = $1`, [c])).toBe(0);
  });
});

describe("0275: withdrawal and archive", () => {
  it("withdrawal appends the evidence, deletes the photo, queues the object, audits; a new photo then needs fresh consent", async () => {
    await enable(A.studioId, true);
    const c = await newClient(A);
    await consent(A.userId, c);
    const p = pathFor(A, c);
    await setPhoto(A.userId, c, p);
    const w = await userQuery(A.userId, `select public.withdraw_client_id_photo_consent($1) w`, [c]);
    expect(w.rows[0].w).toBe(true);
    expect(await readable(A.userId, c)).toBe(0);
    const ev = await adminQuery(`select event from public.client_id_photo_consents where client_id = $1 order by seq`, [c]);
    expect(ev.rows.map((r) => r.event)).toEqual(["granted", "withdrawn"]);
    const q = await adminQuery(`select 1 from public.client_id_photo_pending_object_deletions where storage_path = $1`, [p]);
    expect(q.rows).toHaveLength(1);
    expect((await refusal(setPhoto(A.userId, c, pathFor(A, c)))).code).toBe(P0275);
    await consent(A.userId, c);
    await setPhoto(A.userId, c, pathFor(A, c));
    expect(await readable(A.userId, c)).toBe(1);
  });

  it("archiving the client removes the photo, appends a system withdrawal, queues the object and never touches treatment photos", async () => {
    await enable(A.studioId, true);
    const c = await newClient(A);
    await consent(A.userId, c);
    const p = pathFor(A, c);
    await setPhoto(A.userId, c, p);
    const before = await rowCount(`select count(*) n from public.treatment_images where studio_id = $1`, [A.studioId]);
    await adminQuery(`update public.clients set archived_at = now() where id = $1`, [c]);
    expect(await rowCount(`select count(*) n from public.client_id_photos where client_id = $1`, [c])).toBe(0);
    const ev = await adminQuery(`select event, provided_by, channel from public.client_id_photo_consents where client_id = $1 order by seq`, [c]);
    expect(ev.rows.map((r) => r.event)).toEqual(["granted", "withdrawn"]);
    expect(ev.rows[1]).toMatchObject({ provided_by: "system", channel: "system" });
    expect((await adminQuery(`select 1 from public.client_id_photo_pending_object_deletions where storage_path = $1`, [p])).rows).toHaveLength(1);
    const audit = await adminQuery(`select event from public.client_id_photo_audit where client_id = $1 order by seq`, [c]);
    expect(audit.rows.map((r) => r.event)).toEqual(["consent_granted", "photo_set", "consent_withdrawn_client_archived", "photo_removed_client_archived"]);
    expect(await rowCount(`select count(*) n from public.treatment_images where studio_id = $1`, [A.studioId])).toBe(before);
    // an archived client cannot be given a photo
    expect((await refusal(setPhoto(A.userId, c, pathFor(A, c)))).code).toBe(CHECK_VIOLATION);
  });
});

describe("0275: closing the 0231 bypass (decision 10)", () => {
  it("set_client_portrait is uncallable by every API role", async () => {
    for (const role of ["anon", "authenticated", "service_role"] as const) {
      const r = await refusal(
        asRole(role, (q) => q(`select public.set_client_portrait($1,$2,$3)`, [A.clientId, randomUUID(), randomUUID()])),
      );
      expect(r.code).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  it("the pointer cannot be set by a direct column update or insert, for any role including the owner role", async () => {
    // A REAL, valid client-scoped treatment photo: 0231's own integrity rule accepts it,
    // so a refusal here can only be 0275's pointer freeze.
    const img = randomUUID();
    await userQuery(A.userId, `select public.create_treatment_image_metadata($1,$2,null,null,$3,$4,$5,$6,$7)`, [
      img, A.clientId, "treatment-images", `${A.studioId}/${A.clientId}/${img}.jpg`, "synthetic.jpg", "image/jpeg", 1024,
    ]);
    const upd = await refusal(
      userQuery(A.userId, `update public.clients set portrait_image_id = $2 where id = $1`, [A.clientId, img]),
    );
    // authenticated has no column privilege to write the pointer; the trigger is the backstop.
    expect([P0275, INSUFFICIENT_PRIVILEGE]).toContain(upd.code);
    const adm = await refusal(adminQuery(`update public.clients set portrait_image_id = $2 where id = $1`, [A.clientId, img]));
    expect(adm.code).toBe(P0275);
    expect(await rowCount(`select count(*) n from public.clients where id = $1 and portrait_image_id is not null`, [A.clientId])).toBe(0);
  });

  it("clearing the pointer to null stays possible", async () => {
    const r = await adminQuery(`update public.clients set portrait_image_id = null where id = $1`, [A.clientId]);
    expect(r.rowCount).toBe(1);
  });
});
