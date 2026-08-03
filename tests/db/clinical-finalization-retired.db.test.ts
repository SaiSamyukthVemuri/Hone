import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import {
  adminQuery,
  asRole,
  asUser,
  closePool,
  resolveLocalDbUrl,
  seedLegacyRecordStatus,
  seedSession,
  seedStudio,
  userQuery,
  type SeededStudio,
} from "./helpers/harness";

// ===========================================================================
// Migration 0159 — signed/finalized clinical records are PERMANENTLY RETIRED.
//
// This replaces tests/db/clinical-finalization.db.test.ts,
// tests/db/clinical-corrections.db.test.ts and
// tests/db/clinical-amend-named-args.db.test.ts, which proved the behaviour of a
// capability Hone has now decided not to offer. Testing that finalization works
// correctly is no longer meaningful; testing that it CANNOT HAPPEN is.
//
// Three things are proven here, against the real migrated database:
//   A. the capability is unreachable — the flags cannot be turned on, the RPCs
//      cannot be executed, no session can enter the finalized/void lifecycle, and
//      no row can be added to any of the three signed-record ledgers;
//   B. the ONE legacy artifact production still holds stays readable and
//      completely immutable — the 0119/0120 freeze is deliberately KEPT for it;
//   C. ordinary treatment charting is fully editable, which is the whole point of
//      the product decision.
//
// Note on fixtures: because 0159 blocks the transition for every role, the legacy
// state can only be built by disabling the guard as the table OWNER
// (seedLegacyRecordStatus / insertLegacySnapshot below). That is the proof there is
// no bypass in the shipped schema — not a loophole in it.
// ===========================================================================

let a: SeededStudio;
let b: SeededStudio;

beforeAll(async () => {
  a = await seedStudio("retire-a");
  b = await seedStudio("retire-b");
});
afterAll(async () => {
  await closePool();
});

const RETIRED_MSG = /retired/i;

const RETIRED_RPCS = [
  "public.finalize_session(uuid,integer)",
  "public.correct_finalized_session(uuid,integer,text,jsonb)",
  "public.amend_finalized_session(uuid,uuid,text,text,text,jsonb)",
  "public.amend_finalized_session_with_image(uuid,uuid,text,text,text,text,bigint,text,uuid,text)",
  "public.build_session_snapshot(uuid)",
  // The five correction APPLIERS. 0120 revoked them from anon/authenticated/public
  // but never from service_role, so Supabase's default grant left them live — and
  // they are the only leftover of the retired system that still held WRITE
  // authority. Each is tenant-unaware by design (no is_studio_member check),
  // because correct_finalized_session validated authority before calling it.
  "public._apply_session_correction(uuid,jsonb)",
  "public._apply_block_correction(uuid,jsonb)",
  "public._apply_electrolysis_correction(uuid,jsonb)",
  "public._apply_laser_correction(uuid,jsonb)",
  "public._apply_image_correction(uuid,jsonb)",
] as const;

const LEDGERS = [
  "clinical_record_snapshots",
  "clinical_record_amendments",
  "clinical_audit_events",
] as const;

// Insert a legacy snapshot row the only way that is still possible: as the owner,
// with the retirement INSERT guard briefly disabled. Mirrors the one row that
// exists in production from the controlled non-Willow test studio.
async function insertLegacySnapshot(
  studio: SeededStudio,
  sessionId: string,
): Promise<{ id: string; hash: string }> {
  await adminQuery(
    "alter table public.clinical_record_snapshots disable trigger clinical_record_snapshots_retired_no_insert",
  );
  try {
    const r = await adminQuery(
      `insert into public.clinical_record_snapshots
         (studio_id, session_id, version_no, snapshot, content_hash, finalized_by, finalized_at, signed)
       values ($1,$2,1,$3::jsonb,$4,$5, now(), true)
       returning id, content_hash`,
      [
        studio.studioId,
        sessionId,
        JSON.stringify({ schema: "hone.clinical_snapshot.v1", legacy: true }),
        "legacyhash" + sessionId.replace(/-/g, "").slice(0, 24),
        studio.practitionerId,
      ],
    );
    return { id: r.rows[0].id as string, hash: r.rows[0].content_hash as string };
  } finally {
    await adminQuery(
      "alter table public.clinical_record_snapshots enable trigger clinical_record_snapshots_retired_no_insert",
    );
  }
}

// ===========================================================================
// A. The capability is unreachable.
// ===========================================================================
describe("A. retirement — the capability cannot be turned on", () => {
  it("neither clinical flag can be set true, by ANY role including the owner", async () => {
    // A CHECK constraint, so it binds the owner too — the flag is not something an
    // operator can be trusted to leave alone.
    for (const col of [
      "clinical_finalization_enabled",
      "clinical_corrections_enabled",
    ] as const) {
      await expect(
        adminQuery(`update public.studios set ${col} = true where id = $1`, [a.studioId]),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        asRole("service_role", (q) =>
          q(`update public.studios set ${col} = true where id = $1`, [a.studioId]),
        ),
      ).rejects.toMatchObject({ code: "23514" });
      // And through the browser path that actually exists today: `authenticated`
      // holds UPDATE on public.studios under the "owners update" policy.
      await expect(
        asUser(a.userId, (q) =>
          q(`update public.studios set ${col} = true where id = $1`, [a.studioId]),
        ),
      ).rejects.toMatchObject({ code: "23514" });
    }
    const row = await adminQuery(
      "select clinical_finalization_enabled f, clinical_corrections_enabled c from public.studios where id=$1",
      [a.studioId],
    );
    expect(row.rows[0]).toEqual({ f: false, c: false });
  });

  it("a new studio cannot be created with either flag on", async () => {
    await expect(
      adminQuery(
        "insert into public.studios (name, owner_email, clinical_finalization_enabled) values ('X','x@harness.local',true)",
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("no runtime role can EXECUTE any retired RPC", async () => {
    for (const fn of RETIRED_RPCS) {
      for (const role of ["anon", "authenticated", "service_role"] as const) {
        const r = await adminQuery(
          "select has_function_privilege($1,$2,'EXECUTE') as ok",
          [role, fn],
        );
        expect({ fn, role, ok: r.rows[0].ok }).toEqual({ fn, role, ok: false });
      }
    }
    // …and the browser really is refused when it tries.
    const { sessionId } = await seedSession(a);
    await expect(
      userQuery(a.userId, "select * from public.finalize_session($1,$2)", [sessionId, 1]),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

describe("A. retirement — no session can enter the retired lifecycle", () => {
  it("draft -> finalized is refused for every role, owner included", async () => {
    const { sessionId } = await seedSession(a);
    for (const attempt of [
      () => adminQuery("update public.sessions set record_status='finalized' where id=$1", [sessionId]),
      () => asRole("service_role", (q) => q("update public.sessions set record_status='finalized' where id=$1", [sessionId])),
    ]) {
      await expect(attempt()).rejects.toThrow(RETIRED_MSG);
    }
    // The browser role is refused EARLIER after 0169 — it holds no UPDATE on
    // sessions at all, so it cannot even reach the retirement guard. Both
    // refusals are asserted so neither can silently disappear.
    let browserCode: string | undefined;
    try {
      await asUser(a.userId, (q) =>
        q("update public.sessions set record_status='finalized' where id=$1", [sessionId]));
    } catch (e) { browserCode = (e as { code?: string }).code; }
    expect(browserCode).toBe("42501");
    const s = await adminQuery("select record_status from public.sessions where id=$1", [sessionId]);
    expect(s.rows[0].record_status).toBe("draft");
  });

  it("draft -> void is refused too (the same retired lifecycle)", async () => {
    const { sessionId } = await seedSession(a);
    await expect(
      adminQuery("update public.sessions set record_status='void' where id=$1", [sessionId]),
    ).rejects.toThrow(RETIRED_MSG);
  });

  it("a session cannot be INSERTED already finalized", async () => {
    await expect(
      adminQuery(
        `insert into public.sessions (studio_id, client_id, practitioner_id, modality, record_status)
         values ($1,$2,$3,'electrolysis','finalized')`,
        [a.studioId, a.clientId, a.practitionerId],
      ),
    ).rejects.toThrow(RETIRED_MSG);
  });

  it("no row can be added to any signed-record ledger, by ANY role including the owner", async () => {
    const { sessionId } = await seedSession(a);
    await expect(
      adminQuery(
        `insert into public.clinical_record_snapshots
           (studio_id, session_id, version_no, snapshot, content_hash, finalized_at)
         values ($1,$2,1,'{}'::jsonb,'deadbeef', now())`,
        [a.studioId, sessionId],
      ),
    ).rejects.toThrow(RETIRED_MSG);
    for (const t of LEDGERS) {
      const r = await adminQuery(
        `select count(*)::int n from pg_trigger
          where tgrelid = ('public.'||$1)::regclass and tgname = $1||'_retired_no_insert'`,
        [t],
      );
      expect({ t, n: r.rows[0].n }).toEqual({ t, n: 1 });
    }
  });

  it("ordinary session edits are untouched by the retirement guard", async () => {
    const { sessionId } = await seedSession(a);
    // After 0169 an ordinary edit goes through a 0167 command. The invariant is
    // unchanged and is the point of the case: an ordinary session is NOT frozen
    // by the retirement guard, and stays `draft`.
    await userQuery(a.userId, "select public.set_next_session_note($1,$2,$3)", [
      sessionId, a.clientId, "edited freely",
    ]);
    const s = await adminQuery(
      "select next_session_note, record_status from public.sessions where id=$1",
      [sessionId],
    );
    expect(s.rows[0]).toEqual({ next_session_note: "edited freely", record_status: "draft" });
  });
});

// ===========================================================================
// B. The ONE legacy artifact stays readable and immutable.
// ===========================================================================
describe("B. the legacy finalized artifact is preserved, not deleted", () => {
  let sessionId: string;
  let blockId: string;
  let snapshotId: string;
  let snapshotHash: string;

  beforeAll(async () => {
    const seeded = await seedSession(a);
    sessionId = seeded.sessionId;
    blockId = seeded.blockId;
    await adminQuery(
      "insert into public.electrolysis_entries (id, session_id, area, block_id) values ($1,$2,'Chin',$3)",
      [randomUUID(), sessionId, blockId],
    );
    const snap = await insertLegacySnapshot(a, sessionId);
    snapshotId = snap.id;
    snapshotHash = snap.hash;
    await seedLegacyRecordStatus(sessionId, "finalized");
    await adminQuery(
      "update public.sessions set finalized_at = now(), finalized_by = $2, current_snapshot_id = $3 where id = $1",
      [sessionId, a.practitionerId, snapshotId],
    ).catch(() => undefined);
  });

  it("the 0120 correction GUC no longer unlocks it (permit removed by 0159)", async () => {
    // REPRODUCED before the fix: set_config on a custom placeholder is available to
    // ANY role, so once the correction RPCs were EXECUTE-revoked the 0120 permit
    // stopped being a guarded escape and became an open one — plain `authenticated`
    // could rewrite the frozen record. 0159 removes the permit branches.
    const c = new Client({ connectionString: resolveLocalDbUrl() });
    await c.connect();
    try {
      await c.query("begin");
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: a.userId, role: "authenticated" }),
      ]);
      await c.query("select set_config('hone.correction_session_id', $1, true)", [sessionId]);
      // After 0169 `authenticated` cannot even reach the guard — the privilege
      // layer refuses first (42501), which closes the original escape earlier
      // than the trigger did.
      // A failed statement aborts the transaction, so each probe runs inside its
      // own savepoint.
      await c.query("savepoint probe_authenticated");
      await expect(
        c.query("update public.session_blocks set energy_level = 99 where id=$1", [blockId]),
      ).rejects.toMatchObject({ code: "42501" });
      await c.query("rollback to savepoint probe_authenticated");

      // The GUARD itself must still refuse the GUC, independently of the grant —
      // otherwise re-granting the privilege would silently reopen the escape.
      // Proven as service_role, which retains DML.
      await c.query("reset role");
      await c.query("set local role service_role");
      await c.query("select set_config('hone.correction_session_id', $1, true)", [sessionId]);
      await c.query("savepoint probe_service_role");
      await expect(
        c.query("update public.session_blocks set energy_level = 99 where id=$1", [blockId]),
      ).rejects.toMatchObject({ code: "23514" });
      await c.query("rollback to savepoint probe_service_role");
    } finally {
      await c.query("rollback").catch(() => undefined);
      await c.end();
    }
    // …and the permit is gone from the guard body, not merely ineffective here.
    const def = await adminQuery(
      "select pg_get_functiondef('public.guard_finalized_clinical_write'::regproc) as d",
    );
    expect(def.rows[0].d).not.toMatch(/hone\.correction_session_id/);
  });

  it("all three retired ledgers are immutable to TRUNCATE as well", async () => {
    // "Fully immutable legacy evidence" was not true for TRUNCATE: it is
    // statement-level, fires no row trigger and consults no policy.
    for (const t of LEDGERS) {
      for (const role of ["authenticated", "service_role"] as const) {
        await expect(
          asRole(role, (q) => q(`truncate public.${t}`)),
        ).rejects.toMatchObject({ code: "42501" });
      }
    }
  });

  it("a studio member can still READ the legacy snapshot", async () => {
    const rows = await asUser(a.userId, (q) =>
      q("select id, content_hash, version_no from public.clinical_record_snapshots where id=$1", [
        snapshotId,
      ]),
    );
    expect(rows.rows[0]).toMatchObject({ id: snapshotId, content_hash: snapshotHash, version_no: 1 });
  });

  it("a cross-studio member cannot read it (tenant isolation intact)", async () => {
    const rows = await asUser(b.userId, (q) =>
      q("select id from public.clinical_record_snapshots where id=$1", [snapshotId]),
    );
    expect(rows.rowCount).toBe(0);
  });

  it("the snapshot bytes and hash cannot be altered or removed by ANY role", async () => {
    for (const attempt of [
      () => adminQuery("update public.clinical_record_snapshots set content_hash='tampered' where id=$1", [snapshotId]),
      () => adminQuery("delete from public.clinical_record_snapshots where id=$1", [snapshotId]),
      () => asRole("service_role", (q) => q("update public.clinical_record_snapshots set snapshot='{}'::jsonb where id=$1", [snapshotId])),
    ]) {
      await expect(attempt()).rejects.toThrow();
    }
    const after = await adminQuery(
      "select content_hash, snapshot from public.clinical_record_snapshots where id=$1",
      [snapshotId],
    );
    expect(after.rows[0].content_hash).toBe(snapshotHash);
    expect(after.rows[0].snapshot).toMatchObject({ legacy: true });
  });

  it("the legacy record cannot be un-finalized, soft-deleted or hard-deleted", async () => {
    await expect(
      adminQuery("update public.sessions set record_status='draft' where id=$1", [sessionId]),
    ).rejects.toThrow();
    await expect(
      adminQuery("update public.sessions set deleted_at = now() where id=$1", [sessionId]),
    ).rejects.toThrow();
    await expect(
      adminQuery("delete from public.sessions where id=$1", [sessionId]),
    ).rejects.toThrow();
    const s = await adminQuery("select record_status, deleted_at from public.sessions where id=$1", [
      sessionId,
    ]);
    expect(s.rows[0].record_status).toBe("finalized");
    expect(s.rows[0].deleted_at).toBeNull();
  });

  it("its child clinical rows stay frozen (0119 guard deliberately kept)", async () => {
    await expect(
      adminQuery("update public.session_blocks set energy_level = 99 where id=$1", [blockId]),
    ).rejects.toThrow();
    await expect(
      adminQuery(
        "insert into public.session_blocks (studio_id, session_id, sort_order) values ($1,$2,9)",
        [a.studioId, sessionId],
      ),
    ).rejects.toThrow();
    await expect(
      adminQuery("delete from public.electrolysis_entries where session_id=$1", [sessionId]),
    ).rejects.toThrow();
  });

  it("operational (non-clinical) fields remain mutable on it, as before", async () => {
    // price_paid_cents was deliberately excluded from the signed document; billing
    // reconciliation must keep working even on an archived record.
    await adminQuery("update public.sessions set price_paid_cents = 12345 where id=$1", [sessionId]);
    const s = await adminQuery("select price_paid_cents from public.sessions where id=$1", [sessionId]);
    expect(s.rows[0].price_paid_cents).toBe(12345);
  });
});

// ===========================================================================
// C. Ordinary charting is fully editable — the point of the decision.
// ===========================================================================
describe("C. ordinary treatment charting stays editable", () => {
  const AREAS = (arr: Array<{ area: string; laterality: string }>) => JSON.stringify(arr);

  it("a normal session can be charted, re-charted and corrected freely", async () => {
    const { sessionId } = await seedSession(a);

    // create a settings block with multiple areas + per-area laterality
    const blockId = (
      await userQuery(
        a.userId,
        "select public.create_session_block_with_areas($1,$2,$3::jsonb,$4::jsonb) as id",
        [
          a.studioId,
          sessionId,
          JSON.stringify({ primary_area: "Cheeks", side: "left", mode: "blend", energy_level: 12 }),
          AREAS([
            { area: "Cheeks", laterality: "left" },
            { area: "Sideburns", laterality: "right" },
          ]),
        ],
      )
    ).rows[0].id as string;

    // fix a charting mistake: replace the whole area set and change the settings
    await userQuery(
      a.userId,
      "select public.update_session_block_with_areas($1,$2,$3,$4::jsonb,$5::jsonb,null)",
      [
        a.studioId,
        sessionId,
        blockId,
        JSON.stringify({ mode: "thermo", energy_level: 8, numbing_status: "used", numbing_notes: "1 sachet" }),
        AREAS([{ area: "Chin", laterality: "bilateral" }]),
      ],
    );
    const areas = await adminQuery(
      "select area, laterality from public.session_block_areas where session_block_id=$1",
      [blockId],
    );
    expect(areas.rows).toEqual([{ area: "Chin", laterality: "bilateral" }]);
    const blk = await adminQuery(
      "select mode, energy_level, numbing_notes from public.session_blocks where id=$1",
      [blockId],
    );
    expect(blk.rows[0]).toMatchObject({ mode: "thermo", numbing_notes: "1 sachet" });

    // add a pass, then edit it, then remove the area entirely — all ordinary work
    const entryId = randomUUID();
    await adminQuery(
      "insert into public.electrolysis_entries (id, session_id, block_id, area, hairs_treated) values ($1,$2,$3,'Chin',10)",
      [entryId, sessionId, blockId],
    );
    // The column is unfrozen — which is this case's point. After 0169 the
    // practitioner reaches it through the 0166 commands, so the direct write is
    // performed as the owner here purely to prove the column is not read-only.
    await adminQuery(
      "update public.electrolysis_entries set hairs_treated = 25 where id=$1 and session_id=$2",
      [entryId, sessionId],
    );
    expect(
      (await adminQuery("select hairs_treated from public.electrolysis_entries where id=$1", [entryId]))
        .rows[0].hairs_treated,
    ).toBe(25);

    await userQuery(a.userId, "select * from public.soft_delete_session_area($1,$2,$3)", [
      sessionId,
      blockId,
      "charted the wrong area, removing it",
    ]);
    expect(
      (
        await adminQuery(
          "select count(*)::int n from public.session_blocks where id=$1 and deleted_at is not null",
          [blockId],
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it("nothing about an ordinary session is read-only: notes, next-visit and aftercare all edit", async () => {
    const { sessionId } = await seedSession(a);
    // Every one of these is reachable by the practitioner AFTER the revocation,
    // through the 0167 commands — which is the strongest form of this case:
    // nothing is read-only even with direct DML gone.
    await userQuery(a.userId, "select public.set_next_session_note($1,$2,$3)", [
      sessionId, a.clientId, "next",
    ]);
    await userQuery(a.userId, "select public.set_session_aftercare_explained($1,$2)", [
      sessionId, true,
    ]);
    await userQuery(a.userId, "select public.set_session_price($1,$2,$3)", [
      sessionId, a.clientId, 4200,
    ]);
    const s = await adminQuery(
      "select next_session_note, price_paid_cents, aftercare_and_risks_explained_at is not null as ac from public.sessions where id=$1",
      [sessionId],
    );
    expect(s.rows[0]).toEqual({ next_session_note: "next", price_paid_cents: 4200, ac: true });
  });

  it("an ordinary session can still be soft-deleted (no finalization freeze)", async () => {
    const { sessionId } = await seedSession(a);
    await userQuery(a.userId, "select public.soft_delete_session($1,$2,$3)", [
      sessionId, a.clientId, "no finalization freeze on an ordinary session",
    ]);
    expect(
      (await adminQuery("select deleted_at is not null as gone from public.sessions where id=$1", [sessionId]))
        .rows[0].gone,
    ).toBe(true);
  });
});
