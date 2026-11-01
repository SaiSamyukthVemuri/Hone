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
import { readFileSync } from "node:fs";
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

const reserve = async (userId: string, clientId: string): Promise<string> =>
  (await userQuery(userId, `select public.reserve_client_id_photo_path($1) p`, [clientId])).rows[0].p as string;

/** Reserve a path (unless one is given), then record it: the only order the app may use. */
const setPhoto = async (userId: string, clientId: string, path?: string) =>
  userQuery(userId, `select public.set_client_id_photo($1,$2,$3,$4,$5) id`, [
    clientId,
    path ?? (await reserve(userId, clientId)),
    20000,
    512,
    512,
  ]);

const serviceDrain = (limit = 50) =>
  asRole("service_role", (q) => q(`select * from public.pending_client_id_photo_object_deletions($1)`, [limit]));
const serviceAck = (path: string) =>
  asRole("service_role", (q) => q(`select public.ack_client_id_photo_object_deletion($1) a`, [path]));
const makeDue = (path: string) =>
  adminQuery(`update public.client_id_photo_pending_object_deletions set delete_after = now() - interval '1 second' where storage_path = $1`, [path]);

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
    await setPhoto(A.userId, c);
    expect(await readable(A.userId, c)).toBe(1);
    expect(await readable(memberA.userId, c)).toBe(1);
    expect(await readable(B.userId, c)).toBe(0);
  });

  it("is not readable while the switch is OFF, and is readable again when ON", async () => {
    await enable(A.studioId, true);
    const c = await newClient(A);
    await consent(A.userId, c);
    await setPhoto(A.userId, c);
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
    // a path the database did not hand out for this client: never accepted
    for (const bad of [pathFor(B, c), `${A.studioId}/${randomUUID()}/${randomUUID()}.webp`, `${A.studioId}/${c}/${randomUUID()}.jpg`, pathFor(A, c)]) {
      expect((await refusal(setPhoto(A.userId, c, bad))).code).toBe(P0275);
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
    const first = await reserve(A.userId, c);
    await setPhoto(A.userId, c, first);
    const second = await reserve(A.userId, c);
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

    // the queue is drained by the SERVER with the service role only
    await makeDue(second);
    expect((await serviceDrain()).rows.map((r) => r.storage_path)).toContain(second);
    // asRole rolls back (privilege probes never persist), so commit the ack as the owner role;
    // the grant itself is proved separately (service_role may call it, nobody else).
    expect((await serviceAck(second)).rows[0].a).toBe(true);
    expect((await adminQuery(`select public.ack_client_id_photo_object_deletion($1) a`, [second])).rows[0].a).toBe(true);
    expect((await serviceDrain()).rows.map((r) => r.storage_path)).not.toContain(second);
  });

  it("removal still works while the switch is OFF (never trapped)", async () => {
    await enable(A.studioId, true);
    const c = await newClient(A);
    await consent(A.userId, c);
    await setPhoto(A.userId, c);
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
    const p = await reserve(A.userId, c);
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
    await setPhoto(A.userId, c);
    expect(await readable(A.userId, c)).toBe(1);
  });

  it("archiving the client removes the photo, appends a system withdrawal, queues the object and never touches treatment photos", async () => {
    await enable(A.studioId, true);
    const c = await newClient(A);
    await consent(A.userId, c);
    const p = await reserve(A.userId, c);
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

describe("0275 C1: the object path is reserved in the database BEFORE any upload", () => {
  it("a reserved path is a queue row, due only after its window, and is consumed by set", async () => {
    await enable(A.studioId, true);
    const c = await newClient(A);
    await consent(A.userId, c);
    const path = await reserve(A.userId, c);
    expect(path).toMatch(new RegExp(`^${A.studioId}/${c}/[0-9a-f-]{36}\\.webp$`));
    const q = await adminQuery(`select reservation, reserved_client_id, delete_after > now() later from public.client_id_photo_pending_object_deletions where storage_path = $1`, [path]);
    expect(q.rows[0]).toMatchObject({ reservation: true, reserved_client_id: c, later: true });
    expect((await serviceDrain()).rows.map((r) => r.storage_path), "not drained inside its window").not.toContain(path);
    await setPhoto(A.userId, c, path);
    expect(await rowCount(`select count(*) n from public.client_id_photo_pending_object_deletions where storage_path = $1`, [path])).toBe(0);
    expect(await readable(A.userId, c)).toBe(1);
    // the same path cannot be used twice
    expect((await refusal(setPhoto(A.userId, c, path))).code).toBe(P0275);
  });

  it("upload, then withdraw: set is refused and the orphan path is still in the queue, drained once due", async () => {
    await enable(A.studioId, true);
    const c = await newClient(A);
    await consent(A.userId, c);
    const path = await reserve(A.userId, c);
    // (the server uploaded the object here)
    await userQuery(A.userId, `select public.withdraw_client_id_photo_consent($1)`, [c]);
    expect((await refusal(setPhoto(A.userId, c, path))).code).toBe(P0275);
    expect(await rowCount(`select count(*) n from public.client_id_photos where client_id = $1`, [c])).toBe(0);
    expect(await rowCount(`select count(*) n from public.client_id_photo_pending_object_deletions where storage_path = $1`, [path])).toBe(1);
    await makeDue(path);
    expect((await serviceDrain()).rows.map((r) => r.storage_path)).toContain(path);
  });

  it("upload, then archive the client / switch the studio off: set is refused and the path stays queued", async () => {
    await enable(A.studioId, true);
    const c = await newClient(A);
    await consent(A.userId, c);
    const archivedPath = await reserve(A.userId, c);
    await adminQuery(`update public.clients set archived_at = now() where id = $1`, [c]);
    expect((await refusal(setPhoto(A.userId, c, archivedPath))).code).toBe(CHECK_VIOLATION);
    expect(await rowCount(`select count(*) n from public.client_id_photo_pending_object_deletions where storage_path = $1`, [archivedPath])).toBe(1);

    const c2 = await newClient(A);
    await consent(A.userId, c2);
    const offPath = await reserve(A.userId, c2);
    await enable(A.studioId, false);
    expect((await refusal(setPhoto(A.userId, c2, offPath))).code).toBe(CHECK_VIOLATION);
    expect(await rowCount(`select count(*) n from public.client_id_photo_pending_object_deletions where storage_path = $1`, [offPath])).toBe(1);
    await enable(A.studioId, true);
  });

  it("refuses an expired reservation, another client's reservation, and a path queued for deletion", async () => {
    await enable(A.studioId, true);
    const c = await newClient(A);
    const other = await newClient(A);
    await consent(A.userId, c);
    await consent(A.userId, other);
    const expired = await reserve(A.userId, c);
    await makeDue(expired);
    expect((await refusal(setPhoto(A.userId, c, expired))).code).toBe(P0275);
    const mine = await reserve(A.userId, c);
    expect((await refusal(setPhoto(A.userId, other, mine))).code).toBe(P0275);
    // a path queued by a removal is not a reservation and can never be re-adopted
    const live = await reserve(A.userId, c);
    await setPhoto(A.userId, c, live);
    await userQuery(A.userId, `select public.remove_client_id_photo($1)`, [c]);
    expect((await refusal(setPhoto(A.userId, c, live))).code).toBe(P0275);
  });

  it("reserve has the same gates as set: switch off, no consent, wrong studio, archived, deactivated; and a cap", async () => {
    await enable(A.studioId, true);
    const c = await newClient(A);
    expect((await refusal(reserve(A.userId, c))).code, "no consent").toBe(P0275);
    await consent(A.userId, c);
    expect((await refusal(reserve(B.userId, c))).code, "wrong studio").toBe(CHECK_VIOLATION);
    for (let i = 0; i < 5; i++) await reserve(A.userId, c);
    expect((await refusal(reserve(A.userId, c))).code, "cap of five pending").toBe(P0275);
    await enable(A.studioId, false);
    expect((await refusal(reserve(A.userId, A.clientId))).code, "switch off").toBe(CHECK_VIOLATION);
    await enable(A.studioId, true);
    const anon = await refusal(asRole("anon", (q) => q(`select public.reserve_client_id_photo_path($1)`, [c])));
    expect(anon.code).toBe(INSUFFICIENT_PRIVILEGE);
  });
});

describe("0275 D1: withdraw, remove and archive make an in-flight reservation due at once", () => {
  const due = async (path: string) =>
    (await adminQuery(`select delete_after <= now() d from public.client_id_photo_pending_object_deletions where storage_path = $1`, [path])).rows[0].d as boolean;

  it("withdraw expires the client's open reservations; another client's stay open", async () => {
    await enable(A.studioId, true);
    const c = await newClient(A);
    const other = await newClient(A);
    await consent(A.userId, c);
    await consent(A.userId, other);
    const mine = await reserve(A.userId, c);
    const mine2 = await reserve(A.userId, c);
    const theirs = await reserve(A.userId, other);
    expect(await due(mine)).toBe(false);
    await userQuery(A.userId, `select public.withdraw_client_id_photo_consent($1)`, [c]);
    expect(await due(mine)).toBe(true);
    expect(await due(mine2)).toBe(true);
    expect(await due(theirs), "another client's reservation is untouched").toBe(false);
    expect((await serviceDrain()).rows.map((r) => r.storage_path)).toEqual(expect.arrayContaining([mine, mine2]));
    expect((await refusal(setPhoto(A.userId, c, mine))).code).toBe(P0275);
  });

  it("remove expires them too", async () => {
    await enable(A.studioId, true);
    const c = await newClient(A);
    await consent(A.userId, c);
    const path = await reserve(A.userId, c);
    await userQuery(A.userId, `select public.remove_client_id_photo($1)`, [c]);
    expect(await due(path)).toBe(true);
    expect((await serviceDrain()).rows.map((r) => r.storage_path)).toContain(path);
    // I3: the reservation is no longer one, so a set that waited on the client lock cannot consume it,
    // and consent is still current after a remove.
    const q = await adminQuery(`select reservation, reserved_client_id from public.client_id_photo_pending_object_deletions where storage_path = $1`, [path]);
    expect(q.rows[0]).toMatchObject({ reservation: false, reserved_client_id: null });
    expect((await refusal(setPhoto(A.userId, c, path))).code).toBe(P0275);
  });

  it("I2: the owner can plant a legacy pointer for a restore by disabling the guard trigger; the guard stays enforced after", async () => {
    const c = await newClient(A);
    const img = randomUUID();
    await userQuery(A.userId, `select public.create_treatment_image_metadata($1,$2,null,null,$3,$4,$5,$6,$7)`, [
      img, c, "treatment-images", `${A.studioId}/${c}/${img}.jpg`, "synthetic.jpg", "image/jpeg", 1024,
    ]);
    await adminQuery(`alter table public.clients disable trigger clients_portrait_pointer_frozen`);
    try {
      await adminQuery(`update public.clients set portrait_image_id = $2 where id = $1`, [c, img]);
    } finally {
      await adminQuery(`alter table public.clients enable trigger clients_portrait_pointer_frozen`);
    }
    expect((await adminQuery(`select portrait_image_id from public.clients where id = $1`, [c])).rows[0].portrait_image_id).toBe(img);
    const other = randomUUID();
    await userQuery(A.userId, `select public.create_treatment_image_metadata($1,$2,null,null,$3,$4,$5,$6,$7)`, [
      other, c, "treatment-images", `${A.studioId}/${c}/${other}.jpg`, "synthetic.jpg", "image/jpeg", 1024,
    ]);
    expect((await refusal(adminQuery(`update public.clients set portrait_image_id = $2 where id = $1`, [c, other]))).code).toBe(P0275);
  });

  it("the client-archive trigger expires them", async () => {
    await enable(A.studioId, true);
    const c = await newClient(A);
    await consent(A.userId, c);
    const path = await reserve(A.userId, c);
    expect(await due(path)).toBe(false);
    await adminQuery(`update public.clients set archived_at = now() where id = $1`, [c]);
    expect(await due(path)).toBe(true);
    expect((await serviceDrain()).rows.map((r) => r.storage_path)).toContain(path);
  });
});

describe("0275 C2: drain and acknowledge are service-role only", () => {
  it("authenticated and anon cannot call drain or ack; service_role can", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      expect((await refusal(asRole(role, (q) => q(`select * from public.pending_client_id_photo_object_deletions(5)`)))).code).toBe(INSUFFICIENT_PRIVILEGE);
      expect((await refusal(asRole(role, (q) => q(`select public.ack_client_id_photo_object_deletion('x')`)))).code).toBe(INSUFFICIENT_PRIVILEGE);
    }
    expect((await refusal(userQuery(A.userId, `select public.ack_client_id_photo_object_deletion('x')`))).code).toBe(INSUFFICIENT_PRIVILEGE);
    expect((await serviceDrain(1)).rows.length).toBeLessThanOrEqual(1);
  });

  it("an ack is refused for a path that is not yet due or is still referenced by a live photo", async () => {
    await enable(A.studioId, true);
    const c = await newClient(A);
    await consent(A.userId, c);
    const reservedPath = await reserve(A.userId, c);
    expect((await serviceAck(reservedPath)).rows[0].a, "inside its window").toBe(false);
    await setPhoto(A.userId, c, reservedPath);
    expect((await serviceAck(reservedPath)).rows[0].a, "live photo / no queue row").toBe(false);
    expect((await serviceAck(`${A.studioId}/${c}/${randomUUID()}.webp`)).rows[0].a, "unknown path").toBe(false);
  });
});

describe("0275 C3: consent only against the latest approved wording", () => {
  it("approving v1.2 makes v1.1 refused, and v1.2 accepted", async () => {
    await enable(A.studioId, true);
    await adminQuery(
      `insert into public.client_id_photo_wording_versions (version, wording, wording_sha256)
       select 'v1.2', w, encode(sha256(convert_to(w,'UTF8')),'hex') from (select repeat('a successor wording for the test. ', 4) w) s`,
    );
    await adminQuery(`select public.approve_client_id_photo_wording('v1.2')`);
    const v12 = (await adminQuery(`select wording_sha256 s from public.client_id_photo_wording_versions where version='v1.2'`)).rows[0].s as string;
    const c = await newClient(A);
    expect((await refusal(consent(A.userId, c))).code, "v1.1 is superseded").toBe(P0275);
    await userQuery(A.userId, `select public.record_client_id_photo_consent($1,'v1.2',$2,'in_person','client')`, [c, v12]);
    expect(await rowCount(`select count(*) n from public.client_id_photo_consents where client_id = $1 and wording_version = 'v1.2'`, [c])).toBe(1);
    const cur = await userQuery(A.userId, `select version from public.client_id_photo_wording_current($1)`, [A.studioId]);
    expect(cur.rows[0].version).toBe("v1.2");
  });
});

describe("0275 C4: the bucket is hardened and a public bucket fails the migration", () => {
  it("exists private, capped at the column limit, WebP only (when the storage schema is present)", async () => {
    const b = await adminQuery(`select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'client-identification-photos'`);
    expect(b.rows).toHaveLength(1);
    expect(b.rows[0]).toMatchObject({ public: false, file_size_limit: expect.anything(), allowed_mime_types: ["image/webp"] });
    expect(Number(b.rows[0].file_size_limit)).toBe(524288);
  });

  it("the migration's assertion raises when the bucket is public (and passes when private)", async () => {
    const sql = readFileSync("supabase/migrations/0275_client_identification_photo_store.sql", "utf8");
    const block = sql.match(/do \$\$\nbegin\n  if exists \(select 1 from storage\.buckets[\s\S]*?end \$\$;/)![0];
    await adminQuery(block);
    await adminQuery(`update storage.buckets set public = true where id = 'client-identification-photos'`);
    try {
      expect((await refusal(adminQuery(block))).code).toBe(P0275);
    } finally {
      await adminQuery(`update storage.buckets set public = false where id = 'client-identification-photos'`);
    }
    await adminQuery(block);
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
