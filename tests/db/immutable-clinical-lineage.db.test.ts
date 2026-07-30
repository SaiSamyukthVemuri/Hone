import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  adminQuery,
  asRole,
  asUser,
  closePool,
  seedSession,
  seedStudio,
  userQuery,
  type SeededStudio,
} from "./helpers/harness";

// ===========================================================================
// Migration 0160 — a treatment record belongs to ONE client and ONE encounter.
//
// The defect this closes was REPRODUCED as the `authenticated` browser role with a
// real studio-member JWT: tenant isolation holds (a cross-STUDIO re-tenant is
// refused 42501 by RLS) but WITHIN a studio the member policies are
// `using (is_studio_member(studio_id)) with check (is_studio_member(studio_id))`,
// and that predicate is still satisfied after the parent changes. So a raw
// PostgREST PATCH could move a whole session onto a DIFFERENT CLIENT's chart, or
// move a settings block — with its structured treatment areas — onto another
// client's encounter.
//
// The block case was only reachable while the block had no electrolysis entries
// (with entries the composite FK fails first). That incidental protection is
// exactly why an explicit guard is needed: correctness that depends on a child row
// happening to exist is not correctness.
//
// This is NOT the retired finalization capability. Nothing here freezes a record.
// Sessions stay ordinary and editable — notes, settings, areas, passes, timings,
// practitioner, aftercare, soft-delete all keep working. Only WHOSE record it is
// and WHICH encounter a child belongs to becomes immutable.
// ===========================================================================

let a: SeededStudio;
let clientTwo: string;

beforeAll(async () => {
  a = await seedStudio("lineage");
  clientTwo = randomUUID();
  await adminQuery("insert into public.clients (id, studio_id, name) values ($1,$2,'Second Client')", [
    clientTwo,
    a.studioId,
  ]);
});
afterAll(async () => {
  await closePool();
});

const REPARENT_MSG = /cannot be re-assigned/i;

describe("0160 — a session cannot be moved to another client", () => {
  it("refuses client_id change for the browser role, service_role AND the owner", async () => {
    const { sessionId } = await seedSession(a);
    for (const attempt of [
      () => asUser(a.userId, (q) => q("update public.sessions set client_id=$2 where id=$1", [sessionId, clientTwo])),
      () => asRole("service_role", (q) => q("update public.sessions set client_id=$2 where id=$1", [sessionId, clientTwo])),
      () => adminQuery("update public.sessions set client_id=$2 where id=$1", [sessionId, clientTwo]),
    ]) {
      await expect(attempt()).rejects.toThrow(REPARENT_MSG);
    }
    const s = await adminQuery("select client_id from public.sessions where id=$1", [sessionId]);
    expect(s.rows[0].client_id).toBe(a.clientId);
  });

  it("refuses a studio_id re-tenant as well (trigger, not just the RLS predicate)", async () => {
    const { sessionId } = await seedSession(a);
    // The owner bypasses RLS entirely, so this proves the trigger — not the policy.
    await expect(
      adminQuery("update public.sessions set studio_id=$2 where id=$1", [sessionId, randomUUID()]),
    ).rejects.toThrow(REPARENT_MSG);
  });

  it("a no-op write of the same client_id is still allowed", async () => {
    // The guard fires on CHANGE, not on mention — an UPDATE that includes the
    // column with its existing value must not break.
    const { sessionId } = await seedSession(a);
    await userQuery(
      a.userId,
      "update public.sessions set client_id=$2, session_notes='ok' where id=$1 and studio_id=$3",
      [sessionId, a.clientId, a.studioId],
    );
    const s = await adminQuery("select session_notes from public.sessions where id=$1", [sessionId]);
    expect(s.rows[0].session_notes).toBe("ok");
  });
});

describe("0160 — a settings block cannot be moved to another encounter", () => {
  // Review finding (test-quality lens): session_blocks_immutable_lineage pins TWO
  // columns — session_id AND studio_id — but only session_id was exercised, so
  // dropping 'studio_id' from the trigger's TG_ARGV survived the whole DB lane.
  it("refuses a studio_id change on a settings block", async () => {
    const { blockId } = await seedSession(a);
    // A random target studio on purpose: the BEFORE UPDATE guard must fire before
    // any foreign key is consulted, so this proves the GUARD refuses the re-tenant
    // rather than an FK incidentally catching it.
    const elsewhere = randomUUID();
    await expect(
      asUser(a.userId, (q) =>
        q("update public.session_blocks set studio_id=$2 where id=$1", [blockId, elsewhere]),
      ),
    ).rejects.toThrow(REPARENT_MSG);
    await expect(
      adminQuery("update public.session_blocks set studio_id=$2 where id=$1", [blockId, elsewhere]),
    ).rejects.toThrow(REPARENT_MSG);
    const row = await adminQuery("select studio_id from public.session_blocks where id=$1", [blockId]);
    expect(row.rows[0].studio_id).toBe(a.studioId);
  });

  it("refuses session_id change even when the block has NO entries (the reachable case)", async () => {
    const { blockId } = await seedSession(a);
    const other = await seedSession(a);
    await expect(
      asUser(a.userId, (q) =>
        q("update public.session_blocks set session_id=$2 where id=$1", [blockId, other.sessionId]),
      ),
    ).rejects.toThrow(REPARENT_MSG);
    await expect(
      adminQuery("update public.session_blocks set session_id=$2 where id=$1", [blockId, other.sessionId]),
    ).rejects.toThrow(REPARENT_MSG);
  });

  it("its structured areas therefore cannot follow it onto another client's record", async () => {
    const { sessionId, blockId } = await seedSession(a);
    await userQuery(
      a.userId,
      "select public.update_session_block_with_areas($1,$2,$3,'{}'::jsonb,$4::jsonb,null)",
      [a.studioId, sessionId, blockId, JSON.stringify([{ area: "Chin", laterality: "left" }])],
    );
    // A session belonging to the OTHER client.
    const foreign = randomUUID();
    await adminQuery(
      "insert into public.sessions (id, studio_id, client_id, practitioner_id, modality) values ($1,$2,$3,$4,'electrolysis')",
      [foreign, a.studioId, clientTwo, a.practitionerId],
    );
    await expect(
      adminQuery("update public.session_blocks set session_id=$2 where id=$1", [blockId, foreign]),
    ).rejects.toThrow(REPARENT_MSG);
    const areas = await adminQuery(
      `select s.client_id from public.session_block_areas ba
         join public.session_blocks b on b.id = ba.session_block_id
         join public.sessions s on s.id = b.session_id
        where ba.session_block_id = $1`,
      [blockId],
    );
    expect(areas.rows.every((r) => r.client_id === a.clientId)).toBe(true);
  });

  it("ordinary block edits are untouched", async () => {
    const { sessionId, blockId } = await seedSession(a);
    await userQuery(
      a.userId,
      "select public.update_session_block_with_areas($1,$2,$3,$4::jsonb,$5::jsonb,null)",
      [
        a.studioId,
        sessionId,
        blockId,
        JSON.stringify({ mode: "blend", energy_level: 11, numbing_status: "used" }),
        JSON.stringify([{ area: "Cheeks", laterality: "left" }]),
      ],
    );
    const b = await adminQuery("select mode, energy_level from public.session_blocks where id=$1", [blockId]);
    expect(b.rows[0]).toMatchObject({ mode: "blend" });
  });
});

describe("0160 — recorded passes and photos stay with their encounter", () => {
  it("an electrolysis entry cannot change session or block", async () => {
    const { sessionId, blockId } = await seedSession(a);
    const other = await seedSession(a);
    const entryId = randomUUID();
    await adminQuery(
      "insert into public.electrolysis_entries (id, session_id, block_id, area) values ($1,$2,$3,'Chin')",
      [entryId, sessionId, blockId],
    );
    await expect(
      adminQuery("update public.electrolysis_entries set session_id=$2 where id=$1", [entryId, other.sessionId]),
    ).rejects.toThrow(REPARENT_MSG);
    await expect(
      adminQuery("update public.electrolysis_entries set block_id=$2 where id=$1", [entryId, other.blockId]),
    ).rejects.toThrow(REPARENT_MSG);
    // …but its clinical content edits freely.
    await userQuery(
      a.userId,
      "update public.electrolysis_entries set hairs_treated=42 where id=$1 and session_id=$2",
      [entryId, sessionId],
    );
    expect(
      (await adminQuery("select hairs_treated from public.electrolysis_entries where id=$1", [entryId]))
        .rows[0].hairs_treated,
    ).toBe(42);
  });

  it("a laser entry cannot change session", async () => {
    const { sessionId } = await seedSession(a);
    const other = await seedSession(a);
    const id = randomUUID();
    await adminQuery(
      "insert into public.laser_entries (id, session_id, zone) values ($1,$2,'Chin')",
      [id, sessionId],
    );
    await expect(
      adminQuery("update public.laser_entries set session_id=$2 where id=$1", [id, other.sessionId]),
    ).rejects.toThrow(REPARENT_MSG);
  });

  it("a treatment image cannot be re-attached — already guarded by 0093, verified here", async () => {
    const { sessionId, blockId } = await seedSession(a);
    const other = await seedSession(a);
    const imgId = randomUUID();
    await adminQuery(
      `insert into public.treatment_images
         (id, studio_id, client_id, session_id, session_block_id, storage_bucket, storage_path,
          content_type, size_bytes, uploaded_by)
       values ($1,$2,$3,$4,$5,'treatment-images',$6,'image/jpeg',10,$7)`,
      [
        imgId,
        a.studioId,
        a.clientId,
        sessionId,
        blockId,
        `${a.studioId}/${a.clientId}/${imgId}.jpg`,
        a.practitionerId,
      ],
    );
    // 0093's treatment_images_enforce_integrity already freezes these — 0160
    // deliberately does NOT add a second guard, because 0093's version correctly
    // tolerates the FK ON DELETE SET NULL cascade and a blunt one would wedge it.
    for (const [col, val] of [
      ["client_id", clientTwo],
      ["session_id", other.sessionId],
      ["session_block_id", other.blockId],
    ] as const) {
      await expect(
        adminQuery(`update public.treatment_images set ${col}=$2 where id=$1`, [imgId, val]),
      ).rejects.toThrow(/identity columns are immutable|cannot be re-assigned/i);
    }
    // …while the note and soft-delete paths the app actually uses still work.
    await userQuery(
      a.userId,
      "update public.treatment_images set practitioner_note='fine' where id=$1 and studio_id=$2",
      [imgId, a.studioId],
    );
    await userQuery(
      a.userId,
      "update public.treatment_images set deleted_at=now(), deleted_by=$2 where id=$1",
      [imgId, a.practitionerId],
    );
    const img = await adminQuery(
      "select practitioner_note, deleted_at is not null as gone from public.treatment_images where id=$1",
      [imgId],
    );
    expect(img.rows[0]).toEqual({ practitioner_note: "fine", gone: true });
  });
});

describe("0160 — INSERT still establishes lineage normally", () => {
  it("a new session, block, entry and image can all be created against their parents", async () => {
    // The guard is UPDATE-only. Upload/charting paths set lineage on INSERT after
    // validating it server-side, and must be unaffected.
    const { sessionId } = await seedSession(a);
    const blockId = (
      await userQuery(
        a.userId,
        "select public.create_session_block_with_areas($1,$2,$3::jsonb,$4::jsonb) as id",
        [
          a.studioId,
          sessionId,
          JSON.stringify({ primary_area: "Chin", mode: "thermo" }),
          JSON.stringify([{ area: "Chin", laterality: "left" }]),
        ],
      )
    ).rows[0].id as string;
    expect(blockId).toBeTruthy();
    const entryId = randomUUID();
    await adminQuery(
      "insert into public.electrolysis_entries (id, session_id, block_id, area) values ($1,$2,$3,'Chin')",
      [entryId, sessionId, blockId],
    );
    const n = await adminQuery(
      "select count(*)::int c from public.electrolysis_entries where id=$1 and session_id=$2 and block_id=$3",
      [entryId, sessionId, blockId],
    );
    expect(n.rows[0].c).toBe(1);
  });

  it("the correct fix for a mis-filed session is soft-delete + re-chart, which still works", async () => {
    // This is the workflow the guard pushes people toward, so prove it is open.
    const { sessionId } = await seedSession(a);
    await userQuery(
      a.userId,
      "update public.sessions set deleted_at=now(), deleted_by=$2, delete_reason=$3 where id=$1 and studio_id=$4",
      [sessionId, a.practitionerId, "charted on the wrong client", a.studioId],
    );
    const gone = await adminQuery(
      "select deleted_at is not null as gone, delete_reason from public.sessions where id=$1",
      [sessionId],
    );
    expect(gone.rows[0]).toEqual({ gone: true, delete_reason: "charted on the wrong client" });
    // …and the same treatment can be charted on the right client.
    const redo = randomUUID();
    await adminQuery(
      "insert into public.sessions (id, studio_id, client_id, practitioner_id, modality) values ($1,$2,$3,$4,'electrolysis')",
      [redo, a.studioId, clientTwo, a.practitionerId],
    );
    expect(
      (await adminQuery("select client_id from public.sessions where id=$1", [redo])).rows[0].client_id,
    ).toBe(clientTwo);
  });
});

describe("0160 — the FK ON DELETE SET NULL cascades still work", () => {
  it("hard-deleting a settings block clears block_id on its passes instead of wedging", async () => {
    // electrolysis_entries(session_id, block_id) -> session_blocks is ON DELETE SET
    // NULL (block_id). A blunt immutability guard on block_id would REJECT that
    // cascade and make block deletion impossible — the trap 0093 already navigated
    // for treatment_images. This is why block_id uses the clearable guard.
    const { sessionId, blockId } = await seedSession(a);
    const entryId = randomUUID();
    await adminQuery(
      "insert into public.electrolysis_entries (id, session_id, block_id, area) values ($1,$2,$3,'Chin')",
      [entryId, sessionId, blockId],
    );
    await adminQuery("delete from public.session_blocks where id=$1", [blockId]);
    const e = await adminQuery(
      "select session_id, block_id from public.electrolysis_entries where id=$1",
      [entryId],
    );
    expect(e.rows[0]).toEqual({ session_id: sessionId, block_id: null });
  });

  it("…but a cleared block_id still cannot be re-pointed at another block", async () => {
    const { sessionId, blockId } = await seedSession(a);
    const other = await seedSession(a);
    const entryId = randomUUID();
    await adminQuery(
      "insert into public.electrolysis_entries (id, session_id, block_id, area) values ($1,$2,$3,'Chin')",
      [entryId, sessionId, blockId],
    );
    await adminQuery("delete from public.session_blocks where id=$1", [blockId]);
    await expect(
      adminQuery("update public.electrolysis_entries set block_id=$2 where id=$1", [entryId, other.blockId]),
    ).rejects.toThrow(REPARENT_MSG);
  });

  it("hard-deleting a whole session still cascades cleanly", async () => {
    const { sessionId, blockId } = await seedSession(a);
    await adminQuery(
      "insert into public.electrolysis_entries (id, session_id, block_id, area) values ($1,$2,$3,'Chin')",
      [randomUUID(), sessionId, blockId],
    );
    await adminQuery("delete from public.sessions where id=$1", [sessionId]);
    const n = await adminQuery(
      "select (select count(*)::int from public.sessions where id=$1) s, (select count(*)::int from public.session_blocks where session_id=$1) b, (select count(*)::int from public.electrolysis_entries where session_id=$1) e",
      [sessionId],
    );
    expect(n.rows[0]).toEqual({ s: 0, b: 0, e: 0 });
  });
});

// ---------------------------------------------------------------------------
// Review finding (test-quality lens): the guards' SECURITY INVOKER mode and
// pinned empty search_path were only ever source-grepped in the migrations
// test. Flipping the LIVE function to SECURITY DEFINER with an unpinned
// search_path therefore survived the entire DB lane — a source grep cannot see
// what is actually installed. These read pg_proc/pg_trigger instead.
//
// A SECURITY DEFINER guard with an unpinned search_path is the classic
// privilege-escalation shape: it runs as the owner and resolves unqualified
// names through the caller's search_path.
// ---------------------------------------------------------------------------
describe("0160 — the INSTALLED guards match their declared security posture", () => {
  it("both guard functions are SECURITY INVOKER with search_path pinned to empty", async () => {
    const res = await adminQuery(
      `select p.proname, p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '') as cfg
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('guard_immutable_clinical_lineage','guard_clearable_clinical_lineage')
        order by p.proname`,
    );
    expect(res.rows).toHaveLength(2);
    for (const row of res.rows) {
      expect(
        row.prosecdef,
        `${row.proname} must be SECURITY INVOKER — it inspects only OLD/NEW and needs no elevated ` +
          `rights; SECURITY DEFINER would make a pure guard an escalation surface`,
      ).toBe(false);
      expect(
        row.cfg,
        `${row.proname} must pin an empty search_path so unqualified names cannot be hijacked`,
      ).toContain('search_path=""');
    }
  });

  it("all five lineage triggers are installed exactly once and ENABLED", async () => {
    const res = await adminQuery(
      `select t.tgname, t.tgenabled
         from pg_trigger t
        where not t.tgisinternal
          and (t.tgname like '%immutable_lineage' or t.tgname like '%clearable_lineage')
        order by t.tgname`,
    );
    expect(res.rows.map((r: { tgname: string }) => r.tgname)).toEqual([
      "electrolysis_entries_clearable_lineage",
      "electrolysis_entries_immutable_lineage",
      "laser_entries_immutable_lineage",
      "session_blocks_immutable_lineage",
      "sessions_immutable_lineage",
    ]);
    for (const row of res.rows) {
      expect(row.tgenabled, `${row.tgname} must be enabled ('O', origin)`).toBe("O");
    }
  });
});
