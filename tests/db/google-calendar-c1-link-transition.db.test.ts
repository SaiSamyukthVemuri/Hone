import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, purgeAppointmentAudit, asRole, seedStudio, closePool, type SeededStudio } from "./helpers/harness";

// Google Calendar: Phase B2.3-c1 (migration 0132). DB behavioural proof of:
//  * the corrected enqueue placeholder version semantics (last_hone_version=0);
//  * the reschedule rebind reset (pending/0, provider coordinates preserved);
//  * the transactional calendar_event_link_transition RPC (bind_confirmed /
//    update_confirmed / mark_deleted / idempotent rotate_for_recreate) with claim
//    token + status + version-CAS + active-entity fencing, leaving the outbox
//    row in `processing`;
//  * placeholder-aware hard-delete + orphan-repair enqueue.
// Runs against the migrated local Postgres (CI db-integration lane). No Google.

const APP_CREATED = "https://www.googleapis.com/auth/calendar.app.created";

let studio: SeededStudio;
let connId: string;

async function seedConn(): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.calendar_connections
       (id, studio_id, practitioner_id, connection_status, is_studio_calendar_owner, write_calendar_id, granted_scopes, destination_mode)
     values ($1,$2,$3,'connected',true,'cal',$4,'dedicated_app_created')`,
    [id, studio.studioId, studio.practitionerId, [APP_CREATED]],
  );
  await adminQuery(
    `insert into public.calendar_connection_secrets (connection_id, studio_id, encrypted_refresh_token, encryption_key_version)
     values ($1,$2,'v1:1:iv:tag:ct',1)`,
    [id, studio.studioId],
  );
  await adminQuery(`update public.studios set google_calendar_outbound_sync_enabled=true where id=$1`, [studio.studioId]);
  return id;
}

let slotSeq = 0;
async function insertAppt(status = "confirmed", rescheduledFrom: string | null = null): Promise<string> {
  const id = randomUUID();
  // Unique, non-overlapping slots per appointment (the studio has a GiST
  // double-booking exclusion; overlapping fixed slots would collide).
  const base = Date.now() + 86_400_000 + slotSeq++ * 3_600_000;
  const start = new Date(base).toISOString();
  const end = new Date(base + 1_800_000).toISOString();
  await adminQuery(
    `insert into public.appointments
       (id, studio_id, client_id, starts_at, ends_at, duration_minutes, status, rescheduled_from_appointment_id)
     values ($1,$2,$3,$4,$5,30,$6,$7)`,
    [id, studio.studioId, studio.clientId, start, end, status, rescheduledFrom],
  );
  return id;
}

async function links(apptId: string) {
  return (await adminQuery(`select * from public.calendar_event_links where hone_entity_id=$1 order by created_at`, [apptId])).rows;
}
async function outbox(apptId: string) {
  return (await adminQuery(`select * from public.calendar_sync_outbox where hone_entity_id=$1`, [apptId])).rows;
}

// Insert a `processing` outbox row with a known claim token (bypasses the worker
// gate, this suite exercises the RPC fences directly, not the drain adapter).
async function procOutbox(opType: string, entityId: string | null, syncVersion: number, claimToken: string): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.calendar_sync_outbox
       (id, studio_id, connection_id, op_type, hone_entity_type, hone_entity_id, payload, idempotency_key,
        status, claim_token, claimed_at, lease_expires_at, priority, attempts)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'processing',$9, now(), now()+interval '5 minutes',100,1)`,
    [id, studio.studioId, connId, opType, entityId ? "appointment" : null, entityId,
      JSON.stringify({ schema_version: 1, sync_version: syncVersion, op: opType }), `test:${id}`, claimToken],
  );
  return id;
}

type Trans = { status: string; code: string; link_id?: string };
type TransArgs = {
  action: string; outboxId: string; claimToken: string; linkId: string; entityId: string;
  studioId?: string; connectionId?: string;
  expectedSourceVersion?: number | null; googleEventId?: string | null; googleEtag?: string | null; googleIcalUid?: string | null;
};
// Low-level call that allows overriding every fenced arg (studio/connection/version).
async function rpcRaw(args: TransArgs): Promise<Trans> {
  const r = await adminQuery(
    `select public.calendar_event_link_transition($1,$2,$3,$4,$5,$6,'appointment',$7,$8,$9,$10,$11) as r`,
    [args.action, args.outboxId, args.claimToken, args.linkId, args.studioId ?? studio.studioId, args.connectionId ?? connId, args.entityId,
      args.expectedSourceVersion ?? null, args.googleEventId ?? null, args.googleIcalUid ?? null, args.googleEtag ?? null],
  );
  return r.rows[0].r as Trans;
}
// The common well-formed call (studio/connection default to the seeded pair).
const transition = (args: TransArgs) => rpcRaw(args);

beforeAll(async () => {
  studio = await seedStudio("c1-link-transition");
  connId = await seedConn();
});
afterAll(async () => {
  await adminQuery(`delete from public.calendar_sync_outbox where studio_id=$1`, [studio.studioId]).catch(() => {});
  await adminQuery(`delete from public.calendar_event_links where studio_id=$1`, [studio.studioId]).catch(() => {});
  await adminQuery(`delete from public.appointments where studio_id=$1`, [studio.studioId]).catch(() => {});
  await adminQuery(`delete from public.calendar_connection_secrets where studio_id=$1`, [studio.studioId]).catch(() => {});
  await adminQuery(`delete from public.calendar_connections where studio_id=$1`, [studio.studioId]).catch(() => {});
  await purgeAppointmentAudit(studio.studioId).catch(() => {});
  await adminQuery(`delete from public.studios where id = $1`, [studio.studioId]).catch(() => {});
  await closePool();
});
beforeEach(async () => {
  await adminQuery(`delete from public.calendar_sync_outbox where studio_id=$1`, [studio.studioId]);
  await adminQuery(`delete from public.calendar_event_links where studio_id=$1`, [studio.studioId]);
});

describe("corrected enqueue placeholder version semantics (§6)", () => {
  it("a new placeholder link is created with last_hone_version=0, null coordinates, pending", async () => {
    const appt = await insertAppt("confirmed");
    const [link] = await links(appt);
    expect(link.google_event_id).toBeNull();
    expect(link.google_etag).toBeNull();
    expect(link.google_ical_uid).toBeNull();
    expect(link.sync_status).toBe("pending");
    expect(Number(link.last_hone_version)).toBe(0);
  });

  it("reschedule rebind resets to pending/0 but PRESERVES provider coordinates", async () => {
    const predecessor = await insertAppt("confirmed");
    const [link] = await links(predecessor);
    // Simulate the predecessor's link being provider-bound.
    await adminQuery(
      `update public.calendar_event_links set google_event_id='hone1abc', google_etag='e1', sync_status='synced', last_hone_version=1 where id=$1`,
      [link.id],
    );
    const successor = await insertAppt("confirmed", predecessor);
    const rebound = (await adminQuery(`select * from public.calendar_event_links where id=$1`, [link.id])).rows[0];
    expect(rebound.hone_entity_id).toBe(successor); // adopted
    expect(rebound.google_event_id).toBe("hone1abc"); // provider identity preserved
    expect(rebound.sync_status).toBe("pending"); // not yet applied to Google
    expect(Number(rebound.last_hone_version)).toBe(0); // does not claim the successor version
  });
});

describe("calendar_event_link_transition RPC", () => {
  it("bind_confirmed binds a placeholder and leaves the outbox in processing", async () => {
    const appt = await insertAppt("confirmed");
    const [link] = await links(appt);
    const tok = randomUUID();
    const ob = await procOutbox("event.create", appt, 1, tok);
    const r = await transition({ action: "bind_confirmed", outboxId: ob, claimToken: tok, linkId: link.id, entityId: appt, expectedSourceVersion: 1, googleEventId: "hone1evt", googleEtag: "etag1", googleIcalUid: "ical1" });
    expect(r).toMatchObject({ status: "ok", code: "bound" });
    const bound = (await adminQuery(`select * from public.calendar_event_links where id=$1`, [link.id])).rows[0];
    expect(bound.google_event_id).toBe("hone1evt");
    expect(bound.sync_status).toBe("synced");
    expect(Number(bound.last_hone_version)).toBe(1);
    const obRow = (await adminQuery(`select status from public.calendar_sync_outbox where id=$1`, [ob])).rows[0];
    expect(obRow.status).toBe("processing"); // RPC NEVER transitions the outbox
  });

  it("rejects a stale claim token and a non-processing outbox row", async () => {
    const appt = await insertAppt("confirmed");
    const [link] = await links(appt);
    const tok = randomUUID();
    const ob = await procOutbox("event.create", appt, 1, tok);
    expect((await transition({ action: "bind_confirmed", outboxId: ob, claimToken: randomUUID(), linkId: link.id, entityId: appt, expectedSourceVersion: 1, googleEventId: "x" })).code).toBe("stale_token");
    await adminQuery(`update public.calendar_sync_outbox set status='done', claim_token=null, claimed_at=null, lease_expires_at=null where id=$1`, [ob]);
    expect((await transition({ action: "bind_confirmed", outboxId: ob, claimToken: tok, linkId: link.id, entityId: appt, expectedSourceVersion: 1, googleEventId: "x" })).code).toBe("outbox_not_processing");
  });

  it("version CAS rejects a stale bind (link already advanced)", async () => {
    const appt = await insertAppt("confirmed");
    const [link] = await links(appt);
    // Appointment at the job version (2); the LINK advanced past it (5).
    await adminQuery(`update public.appointments set sync_version=2 where id=$1`, [appt]);
    await adminQuery(`update public.calendar_event_links set last_hone_version=5 where id=$1`, [link.id]);
    const tok = randomUUID();
    const ob = await procOutbox("event.create", appt, 2, tok);
    expect((await transition({ action: "bind_confirmed", outboxId: ob, claimToken: tok, linkId: link.id, entityId: appt, expectedSourceVersion: 2, googleEventId: "x" })).code).toBe("stale_version");
  });

  it("maps an active-google-event unique conflict to foreign_event_conflict", async () => {
    const apptA = await insertAppt("confirmed");
    const [linkA] = await links(apptA);
    await adminQuery(`update public.calendar_event_links set google_event_id='dup', sync_status='synced', last_hone_version=1 where id=$1`, [linkA.id]);
    const apptB = await insertAppt("confirmed");
    const [linkB] = await links(apptB);
    const tok = randomUUID();
    const ob = await procOutbox("event.create", apptB, 1, tok);
    const r = await transition({ action: "bind_confirmed", outboxId: ob, claimToken: tok, linkId: linkB.id, entityId: apptB, expectedSourceVersion: 1, googleEventId: "dup", googleEtag: "e" });
    expect(r.code).toBe("foreign_event_conflict");
  });

  it("neither bind nor update can persist synced state without a non-empty provider ETag (§5)", async () => {
    // bind_confirmed with a null/empty etag -> missing_provider_etag, link stays a placeholder.
    const appt = await insertAppt("confirmed");
    const [link] = await links(appt);
    const tok = randomUUID();
    const ob = await procOutbox("event.create", appt, 1, tok);
    for (const etag of [null, ""]) {
      const r = await transition({ action: "bind_confirmed", outboxId: ob, claimToken: tok, linkId: link.id, entityId: appt, expectedSourceVersion: 1, googleEventId: "hone1x", googleEtag: etag });
      expect(r.code).toBe("missing_provider_etag");
    }
    const still = (await adminQuery(`select google_event_id, sync_status from public.calendar_event_links where id=$1`, [link.id])).rows[0];
    expect(still.google_event_id).toBeNull();
    expect(still.sync_status).toBe("pending");

    // update_confirmed with a null/empty etag -> missing_provider_etag, prior etag unchanged.
    const appt2 = await insertAppt("confirmed");
    const [link2] = await links(appt2);
    await adminQuery(`update public.calendar_event_links set google_event_id='hone1e', google_etag='keep', sync_status='synced', last_hone_version=1 where id=$1`, [link2.id]);
    await adminQuery(`update public.appointments set sync_version=2 where id=$1`, [appt2]);
    const tok2 = randomUUID();
    const ob2 = await procOutbox("event.update", appt2, 2, tok2);
    expect((await transition({ action: "update_confirmed", outboxId: ob2, claimToken: tok2, linkId: link2.id, entityId: appt2, expectedSourceVersion: 2, googleEventId: "hone1e", googleEtag: "" })).code).toBe("missing_provider_etag");
    expect((await adminQuery(`select google_etag from public.calendar_event_links where id=$1`, [link2.id])).rows[0].google_etag).toBe("keep");
  });

  it("mark_deleted soft-deletes, retains coordinates, and is idempotent", async () => {
    const appt = await insertAppt("confirmed");
    const [link] = await links(appt);
    await adminQuery(`update public.calendar_event_links set google_event_id='hone1z', google_ical_uid='ic', sync_status='synced' where id=$1`, [link.id]);
    const tok = randomUUID();
    const ob = await procOutbox("event.delete", appt, 2, tok);
    expect((await transition({ action: "mark_deleted", outboxId: ob, claimToken: tok, linkId: link.id, entityId: appt })).code).toBe("deleted");
    const del = (await adminQuery(`select * from public.calendar_event_links where id=$1`, [link.id])).rows[0];
    expect(del.deleted_at).not.toBeNull();
    expect(del.sync_status).toBe("deleted");
    expect(del.google_ical_uid).toBe("ic"); // history retained
    expect((await transition({ action: "mark_deleted", outboxId: ob, claimToken: tok, linkId: link.id, entityId: appt })).code).toBe("already_deleted");
  });

  it("rotate_for_recreate retires the old link and mints ONE fresh placeholder (idempotent)", async () => {
    const appt = await insertAppt("confirmed");
    const [link] = await links(appt);
    await adminQuery(`update public.calendar_event_links set google_event_id='hone1old', sync_status='synced', last_hone_version=3 where id=$1`, [link.id]);
    await adminQuery(`update public.appointments set sync_version=4 where id=$1`, [appt]);
    const tok = randomUUID();
    const ob = await procOutbox("event.update", appt, 4, tok);
    const r = await transition({ action: "rotate_for_recreate", outboxId: ob, claimToken: tok, linkId: link.id, entityId: appt, expectedSourceVersion: 4 });
    expect(r.status).toBe("ok");
    const fresh = r.link_id as string;
    expect(fresh).not.toBe(link.id);
    const active = (await adminQuery(`select * from public.calendar_event_links where hone_entity_id=$1 and deleted_at is null`, [appt])).rows;
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(fresh);
    expect(active[0].google_event_id).toBeNull();
    expect(Number(active[0].last_hone_version)).toBe(0);
    expect(active[0].sync_status).toBe("pending");
    // The old link is retired; the outbox row stays processing.
    const old = (await adminQuery(`select deleted_at from public.calendar_event_links where id=$1`, [link.id])).rows[0];
    expect(old.deleted_at).not.toBeNull();
    expect((await adminQuery(`select status from public.calendar_sync_outbox where id=$1`, [ob])).rows[0].status).toBe("processing");
    // Idempotent resume: a second rotate returns the SAME replacement, never a 2nd active link.
    const r2 = await transition({ action: "rotate_for_recreate", outboxId: ob, claimToken: tok, linkId: link.id, entityId: appt, expectedSourceVersion: 4 });
    expect(r2.link_id).toBe(fresh);
    expect((await adminQuery(`select count(*)::int c from public.calendar_event_links where hone_entity_id=$1 and deleted_at is null`, [appt])).rows[0].c).toBe(1);
  });

  it("binds the transition to the claimed outbox row: rejects mismatched studio / connection / entity / action / entity-less link / version", async () => {
    const appt = await insertAppt("confirmed");
    const [link] = await links(appt);
    const tok = randomUUID();
    const ob = await procOutbox("event.create", appt, 1, tok);
    const base: Omit<TransArgs, "action"> = { outboxId: ob, claimToken: tok, linkId: link.id, entityId: appt, expectedSourceVersion: 1, googleEventId: "x" };
    // studio mismatch (pass a foreign studio id via the raw RPC)
    expect((await rpcRaw({ ...base, action: "bind_confirmed", studioId: randomUUID() })).code).toBe("outbox_studio_mismatch");
    expect((await rpcRaw({ ...base, action: "bind_confirmed", connectionId: randomUUID() })).code).toBe("outbox_connection_mismatch");
    // action incompatible with a create/update outbox
    expect((await transition({ ...base, action: "mark_deleted" })).code).toBe("action_op_mismatch");
    // entity mismatch
    expect((await transition({ ...base, action: "bind_confirmed", entityId: randomUUID() })).code).toBe("outbox_entity_mismatch");
    // version arg missing / mismatched
    expect((await rpcRaw({ ...base, action: "bind_confirmed", expectedSourceVersion: null })).code).toBe("version_arg_missing");
    expect((await transition({ ...base, action: "bind_confirmed", expectedSourceVersion: 9 })).code).toBe("version_arg_mismatch");
  });

  it("entity-less delete row: rejects a payload.hone_link_id that does not equal p_link_id", async () => {
    const appt = await insertAppt("confirmed");
    const [link] = await links(appt);
    // an entity-less orphan delete outbox row keyed by a DIFFERENT link id
    const other = randomUUID();
    const id = randomUUID();
    await adminQuery(
      `insert into public.calendar_sync_outbox (id, studio_id, connection_id, op_type, hone_entity_type, hone_entity_id, payload, idempotency_key, status, claim_token, claimed_at, lease_expires_at, priority, attempts)
       values ($1,$2,$3,'event.delete',null,null,$4,$5,'processing',$6,now(),now()+interval '5 minutes',100,1)`,
      [id, studio.studioId, connId, JSON.stringify({ schema_version: 1, reason: "orphan_link_delete_placeholder", hone_link_id: other }), `test:${id}`, id],
    );
    const r = await transition({ action: "mark_deleted", outboxId: id, claimToken: id, linkId: link.id, entityId: appt });
    expect(r.code).toBe("outbox_link_mismatch");
  });

  it("appointment version fence: a version that advanced after the pre-provider read is superseded", async () => {
    const appt = await insertAppt("confirmed");
    const [link] = await links(appt);
    const tok = randomUUID();
    const ob = await procOutbox("event.create", appt, 1, tok);
    // The appointment advances to v2 AFTER the job (v1) was claimed.
    await adminQuery(`update public.appointments set sync_version=2 where id=$1`, [appt]);
    expect((await transition({ action: "bind_confirmed", outboxId: ob, claimToken: tok, linkId: link.id, entityId: appt, expectedSourceVersion: 1, googleEventId: "x" })).code).toBe("appointment_superseded");
    // And a gone appointment is superseded (gone), not silently bound.
    await adminQuery(`delete from public.appointments where id=$1`, [appt]);
    expect((await transition({ action: "bind_confirmed", outboxId: ob, claimToken: tok, linkId: link.id, entityId: appt, expectedSourceVersion: 1, googleEventId: "x" })).code).toBe("appointment_gone");
  });

  it("bind of a link already bound to a DIFFERENT provider id -> moved_link_conflict (not a success)", async () => {
    const appt = await insertAppt("confirmed");
    const [link] = await links(appt);
    await adminQuery(`update public.calendar_event_links set google_event_id='hone1already', sync_status='synced', last_hone_version=1 where id=$1`, [link.id]);
    const tok = randomUUID();
    const ob = await procOutbox("event.create", appt, 1, tok);
    const r = await transition({ action: "bind_confirmed", outboxId: ob, claimToken: tok, linkId: link.id, entityId: appt, expectedSourceVersion: 1, googleEventId: "hone1different" });
    expect(r.code).toBe("moved_link_conflict");
  });

  it("is EXECUTE-revoked from anon and authenticated (service-role only)", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      await expect(
        asRole(role, (q) => q(`select public.calendar_event_link_transition('mark_deleted',$1,$1,$1,$1,$1,'appointment',$1,null,null,null,null)`, [randomUUID()])),
      ).rejects.toThrow();
    }
  });
});

describe("placeholder-aware cleanup enqueue (§14)", () => {
  it("hard-deleting an appointment with a PLACEHOLDER link enqueues a GET-verified delete carrying the link id", async () => {
    const appt = await insertAppt("confirmed");
    const [link] = await links(appt); // placeholder (google_event_id null)
    await adminQuery(`delete from public.appointments where id=$1`, [appt]);
    const rows = (await adminQuery(`select * from public.calendar_sync_outbox where connection_id=$1 and op_type='event.delete'`, [connId])).rows;
    const del = rows.find((r) => r.payload.reason === "entity_deleted_placeholder");
    expect(del).toBeTruthy();
    expect(del.payload.hone_link_id).toBe(link.id);
    expect(del.payload.google_event_id).toBeUndefined(); // placeholder: no confirmed id
  });

  it("repair_enqueue_orphan_link_delete handles a placeholder link", async () => {
    const appt = await insertAppt("confirmed");
    const [link] = await links(appt);
    const r = await adminQuery(`select public.repair_enqueue_orphan_link_delete($1) as v`, [link.id]);
    expect(r.rows[0].v).not.toBe("no_active_link");
    const del = (await adminQuery(`select * from public.calendar_sync_outbox where op_type='event.delete' and payload->>'reason'='orphan_link_delete_placeholder' and payload->>'hone_link_id'=$1`, [link.id])).rows;
    expect(del).toHaveLength(1);
  });
});
