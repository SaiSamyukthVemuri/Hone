import { afterEach, beforeEach, afterAll, describe, expect, it } from "vitest";
import { adminQuery, asRole, asUser, closePool } from "./helpers/harness";
import {
  dropSynthStudio,
  seedSynthStudioA,
  seedSynthStudioB,
  type SynthStudio,
} from "./helpers/synth-fleet";
import { randomUUID } from "node:crypto";

// ===========================================================================
// PR A — practitioner-capacity foundation (migration 0134).
// ===========================================================================
//
// Proves the resource_key + fan-out collision model against the REAL migrated
// schema (db-integration lane), on SYNTHETIC studios only (seedSynthStudioB =
// owner + 2 practitioners; localhost-pinned harness; never Willow/production).
//
// The two load-bearing guarantees:
//   * OFF studios behave byte-for-byte like today (studio-wide collision +
//     studio_id-keyed shadow) — Willow safety.
//   * ON studios get per-practitioner parallelism while same-practitioner and
//     studio-wide blocks still collide (fan-out).

let B: SynthStudio;
let clientB: string;

async function seedClient(studioId: string): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.clients (id, studio_id, name) values ($1, $2, $3)`,
    [id, studioId, `SYNTH client ${id.slice(0, 8)}`],
  );
  return id;
}

function insertAppt(input: {
  studioId: string;
  clientId: string;
  practitionerId?: string | null;
  startsAt: string;
  endsAt: string;
  status?: string;
}) {
  return adminQuery(
    `insert into public.appointments
       (id, studio_id, client_id, practitioner_id, starts_at, ends_at,
        duration_minutes, buffer_minutes_snapshot, blocked_ends_at, status)
     values ($1, $2, $3, $4, $5, $6, 60, 0, $6, $7)
     returning id`,
    [
      randomUUID(),
      input.studioId,
      input.clientId,
      input.practitionerId ?? null,
      input.startsAt,
      input.endsAt,
      input.status ?? "confirmed",
    ],
  );
}

function insertTimedBlock(input: {
  studioId: string;
  startsAt: string;
  endsAt: string;
}) {
  const id = randomUUID();
  return adminQuery(
    `insert into public.studio_timed_blocks
       (id, studio_id, starts_at, ends_at, category)
     values ($1, $2, $3, $4, 'break') returning id`,
    [id, input.studioId, input.startsAt, input.endsAt],
  ).then((r) => r.rows[0].id as string);
}

const enable = (studioId: string) =>
  adminQuery(
    `update public.studios set practitioner_capacity_enabled = true where id = $1`,
    [studioId],
  );
const disable = (studioId: string) =>
  adminQuery(
    `update public.studios set practitioner_capacity_enabled = false where id = $1`,
    [studioId],
  );

// Fresh 3-practitioner studio per test — no cross-test state.
beforeEach(async () => {
  B = await seedSynthStudioB();
  await adminQuery(`update public.studios set buffer_minutes = 0 where id = $1`, [
    B.studioId,
  ]);
  clientB = await seedClient(B.studioId);
});
afterEach(async () => {
  if (B) await dropSynthStudio(B);
});
afterAll(async () => {
  await closePool();
});

// Distinct fixed windows keep pairs unambiguous.
const T10 = "2031-03-10T10:00:00Z";
const T11 = "2031-03-10T11:00:00Z";
const T1030 = "2031-03-10T10:30:00Z";
const T1130 = "2031-03-10T11:30:00Z";

describe("PR A: OFF studios keep today's studio-wide behaviour (Willow safety)", () => {
  it("1. OFF: overlapping appointments for DIFFERENT practitioners still collide (studio-wide)", async () => {
    const p1 = B.practitioners[0].practitionerId;
    const p2 = B.practitioners[1].practitionerId;
    const first = await insertAppt({
      studioId: B.studioId,
      clientId: clientB,
      practitionerId: p1,
      startsAt: T10,
      endsAt: T11,
    });
    expect(first.rowCount).toBe(1);
    await expect(
      insertAppt({
        studioId: B.studioId,
        clientId: clientB,
        practitionerId: p2,
        startsAt: T1030,
        endsAt: T1130,
      }),
    ).rejects.toMatchObject({ code: "23P01" });
  });

  it("2. OFF: a timed block collides with an overlapping appointment (cross-kind, studio-wide)", async () => {
    await insertTimedBlock({ studioId: B.studioId, startsAt: T10, endsAt: T11 });
    await expect(
      insertAppt({
        studioId: B.studioId,
        clientId: clientB,
        practitionerId: B.practitioners[0].practitionerId,
        startsAt: T1030,
        endsAt: T1130,
      }),
    ).rejects.toMatchObject({ code: "23P01" });
  });

  it("3. OFF: every shadow row is keyed studio-wide (resource_key = studio_id)", async () => {
    await insertAppt({
      studioId: B.studioId,
      clientId: clientB,
      practitionerId: B.practitioners[0].practitionerId,
      startsAt: T10,
      endsAt: T11,
    });
    await insertTimedBlock({
      studioId: B.studioId,
      startsAt: "2031-03-10T13:00:00Z",
      endsAt: "2031-03-10T14:00:00Z",
    });
    const rows = await adminQuery(
      `select resource_key, studio_id from public.studio_calendar_reservations where studio_id = $1`,
      [B.studioId],
    );
    expect(rows.rows.length).toBe(2);
    for (const r of rows.rows) expect(r.resource_key).toBe(r.studio_id);
  });
});

describe("PR A: ON studios get per-practitioner parallelism", () => {
  it("4. ON: overlapping appointments for DIFFERENT practitioners BOTH succeed", async () => {
    await enable(B.studioId);
    const a = await insertAppt({
      studioId: B.studioId,
      clientId: clientB,
      practitionerId: B.practitioners[0].practitionerId,
      startsAt: T10,
      endsAt: T11,
    });
    const b = await insertAppt({
      studioId: B.studioId,
      clientId: clientB,
      practitionerId: B.practitioners[1].practitionerId,
      startsAt: T1030,
      endsAt: T1130,
    });
    expect(a.rowCount).toBe(1);
    expect(b.rowCount).toBe(1);
  });

  it("5. ON: overlapping appointments for the SAME practitioner collide (23P01)", async () => {
    await enable(B.studioId);
    const p = B.practitioners[0].practitionerId;
    await insertAppt({
      studioId: B.studioId,
      clientId: clientB,
      practitionerId: p,
      startsAt: T10,
      endsAt: T11,
    });
    await expect(
      insertAppt({
        studioId: B.studioId,
        clientId: clientB,
        practitionerId: p,
        startsAt: T1030,
        endsAt: T1130,
      }),
    ).rejects.toMatchObject({ code: "23P01" });
  });

  it("6. ON: an appointment's shadow row is keyed by practitioner_id", async () => {
    await enable(B.studioId);
    const p = B.practitioners[1].practitionerId;
    await insertAppt({
      studioId: B.studioId,
      clientId: clientB,
      practitionerId: p,
      startsAt: T10,
      endsAt: T11,
    });
    const row = await adminQuery(
      `select resource_key, practitioner_id from public.studio_calendar_reservations
         where studio_id = $1 and source_kind = 'appointment'`,
      [B.studioId],
    );
    expect(row.rows.length).toBe(1);
    expect(row.rows[0].resource_key).toBe(p);
    expect(row.rows[0].practitioner_id).toBe(p);
  });
});

describe("PR A: studio-wide blocks fan out to every practitioner when ON", () => {
  it("7. ON: a timed block fans into one shadow row per active practitioner", async () => {
    await enable(B.studioId);
    await insertTimedBlock({ studioId: B.studioId, startsAt: T10, endsAt: T11 });
    const rows = await adminQuery(
      `select resource_key from public.studio_calendar_reservations
         where studio_id = $1 and source_kind = 'timed_block' order by resource_key`,
      [B.studioId],
    );
    const keys = rows.rows.map((r) => r.resource_key).sort();
    const practitioners = B.practitioners.map((p) => p.practitionerId).sort();
    expect(keys).toEqual(practitioners); // exactly one row per active practitioner
  });

  it("8. ON: a timed block blocks EVERY practitioner (overlapping appointment collides)", async () => {
    await enable(B.studioId);
    await insertTimedBlock({ studioId: B.studioId, startsAt: T10, endsAt: T11 });
    // Any practitioner overlapping the block must collide.
    for (const p of B.practitioners) {
      await expect(
        insertAppt({
          studioId: B.studioId,
          clientId: clientB,
          practitionerId: p.practitionerId,
          startsAt: T1030,
          endsAt: T1130,
        }),
      ).rejects.toMatchObject({ code: "23P01" });
    }
  });
});

describe("PR A: service→practitioner eligibility", () => {
  it("9. backfill/default: a new service is eligible for every active practitioner", async () => {
    const svc = randomUUID();
    await adminQuery(
      `insert into public.services (id, studio_id, name) values ($1, $2, 'SYNTH svc')`,
      [svc, B.studioId],
    );
    const rows = await adminQuery(
      `select practitioner_id from public.service_practitioners where service_id = $1 order by practitioner_id`,
      [svc],
    );
    const got = rows.rows.map((r) => r.practitioner_id).sort();
    const active = B.practitioners.map((p) => p.practitionerId).sort();
    expect(got).toEqual(active);
  });

  it("10. same-studio: a cross-studio eligibility row is rejected by the composite FK", async () => {
    const A = await seedSynthStudioA();
    try {
      const svc = randomUUID();
      await adminQuery(
        `insert into public.services (id, studio_id, name) values ($1, $2, 'SYNTH svc B')`,
        [svc, B.studioId],
      );
      // practitioner from studio A, but studio_id = B -> no (id, studio_id) match.
      await expect(
        adminQuery(
          `insert into public.service_practitioners (studio_id, service_id, practitioner_id)
             values ($1, $2, $3)`,
          [B.studioId, svc, A.practitioners[0].practitionerId],
        ),
      ).rejects.toMatchObject({ code: "23503" }); // FK violation
    } finally {
      await dropSynthStudio(A);
    }
  });
});

describe("PR A: integrity + activation lifecycle", () => {
  it("11. ON: an appointment with a NULL practitioner_id is rejected by the CHECK", async () => {
    await enable(B.studioId);
    await expect(
      insertAppt({
        studioId: B.studioId,
        clientId: clientB,
        practitionerId: null,
        startsAt: T10,
        endsAt: T11,
      }),
    ).rejects.toMatchObject({ code: "23514" }); // check_violation
  });

  it("12. flag flip re-materializes the shadow (OFF→ON re-keys + fans; ON→OFF reverts; no orphans)", async () => {
    // Seed OFF: one appointment + one timed block.
    const p = B.practitioners[0].practitionerId;
    await insertAppt({
      studioId: B.studioId,
      clientId: clientB,
      practitionerId: p,
      startsAt: T10,
      endsAt: T11,
    });
    await insertTimedBlock({
      studioId: B.studioId,
      startsAt: "2031-03-10T13:00:00Z",
      endsAt: "2031-03-10T14:00:00Z",
    });

    // OFF: 2 rows, both studio-keyed.
    let rows = await adminQuery(
      `select source_kind, resource_key, studio_id from public.studio_calendar_reservations where studio_id = $1`,
      [B.studioId],
    );
    expect(rows.rows.length).toBe(2);
    for (const r of rows.rows) expect(r.resource_key).toBe(r.studio_id);

    // Flip ON: appointment re-keyed to its practitioner; block fanned to all 3.
    await enable(B.studioId);
    const appt = await adminQuery(
      `select resource_key from public.studio_calendar_reservations
         where studio_id = $1 and source_kind = 'appointment'`,
      [B.studioId],
    );
    expect(appt.rows.length).toBe(1);
    expect(appt.rows[0].resource_key).toBe(p);
    const block = await adminQuery(
      `select count(*)::int as c from public.studio_calendar_reservations
         where studio_id = $1 and source_kind = 'timed_block'`,
      [B.studioId],
    );
    expect(block.rows[0].c).toBe(3);

    // Flip OFF again: everything reverts to studio-keyed, no duplicates/orphans.
    await disable(B.studioId);
    rows = await adminQuery(
      `select resource_key, studio_id from public.studio_calendar_reservations where studio_id = $1`,
      [B.studioId],
    );
    expect(rows.rows.length).toBe(2);
    for (const r of rows.rows) expect(r.resource_key).toBe(r.studio_id);
  });

  it("13. ON: removing a practitioner re-fans studio-wide blocks to the remaining set", async () => {
    await enable(B.studioId);
    await insertTimedBlock({ studioId: B.studioId, startsAt: T10, endsAt: T11 });
    let block = await adminQuery(
      `select count(*)::int as c from public.studio_calendar_reservations
         where studio_id = $1 and source_kind = 'timed_block'`,
      [B.studioId],
    );
    expect(block.rows[0].c).toBe(3);

    // Remove a practitioner (no appointments) -> their fanned row is gone (FK
    // cascade + rebuild) and the block now covers exactly the remaining 2.
    const removed = B.practitioners[2].practitionerId;
    await adminQuery(`delete from public.practitioners where id = $1`, [removed]);
    block = await adminQuery(
      `select count(*)::int as c, bool_or(resource_key = $2) as has_removed
         from public.studio_calendar_reservations
         where studio_id = $1 and source_kind = 'timed_block'`,
      [B.studioId, removed],
    );
    expect(block.rows[0].c).toBe(2);
    expect(block.rows[0].has_removed).toBe(false);
  });

  // ---- Regression locks for the adversarial-review findings ----

  it("14. activation is NOT blocked by a cancelled appointment with a null practitioner_id", async () => {
    // The public path legitimately writes practitioner_id = owner?.id ?? null,
    // and the row can be cancelled. Such a row must not trip the CHECK on flip.
    await insertAppt({
      studioId: B.studioId,
      clientId: clientB,
      practitionerId: null,
      startsAt: T10,
      endsAt: T11,
      status: "cancelled",
    });
    // Flip ON must succeed (no spurious 23514) ...
    await expect(enable(B.studioId)).resolves.toBeTruthy();
    // ... and the cancelled row must hold no shadow reservation.
    const shadow = await adminQuery(
      `select count(*)::int as c from public.studio_calendar_reservations where studio_id = $1`,
      [B.studioId],
    );
    expect(shadow.rows[0].c).toBe(0);
  });

  it("15. ON: a practitioner whose only appointment is cancelled can be removed (FK set-null does not trip the CHECK)", async () => {
    await enable(B.studioId);
    const p = B.practitioners[1].practitionerId;
    // A cancelled appointment for p; deleting p nulls its practitioner_id via
    // the ON DELETE SET NULL FK, which must not fail the capacity CHECK.
    await insertAppt({
      studioId: B.studioId,
      clientId: clientB,
      practitionerId: p,
      startsAt: T10,
      endsAt: T11,
      status: "cancelled",
    });
    await expect(
      adminQuery(`delete from public.practitioners where id = $1`, [p]),
    ).resolves.toBeTruthy();
  });
});

// ===========================================================================
// Final pre-merge gates — access control (Gates 1/2/3).
// ===========================================================================

const ownerUser = (s: SynthStudio) =>
  s.practitioners.find((p) => p.role === "owner")!.userId;
const memberUser = (s: SynthStudio) =>
  s.practitioners.find((p) => p.role === "practitioner")!.userId;

describe("Gate 1: capacity flag is operator-controlled (not tenant-writable)", () => {
  const setFlag = (q: (t: string, p?: unknown[]) => Promise<{ rowCount: number | null }>) =>
    q(`update public.studios set practitioner_capacity_enabled = true where id = $1`, [
      B.studioId,
    ]);

  it("owner's direct flag UPDATE is rejected by the guard (42501)", async () => {
    await expect(
      asUser(ownerUser(B), (q) => setFlag(q)),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("a non-owner practitioner's flag UPDATE matches zero rows (RLS)", async () => {
    const r = await asUser(memberUser(B), (q) => setFlag(q));
    expect(r.rowCount).toBe(0);
  });

  it("anon cannot set the flag (denied or zero rows)", async () => {
    const outcome = await asRole("anon", (q) => setFlag(q))
      .then((r) => ({ rows: r.rowCount, err: null as string | null }))
      .catch((e) => ({ rows: null, err: e.code as string }));
    expect(outcome.rows === 0 || outcome.err != null).toBe(true);
  });

  it("service_role CAN set the flag", async () => {
    const r = await asRole("service_role", (q) => setFlag(q));
    expect(r.rowCount).toBe(1); // rolled back by asRole; proves the write is permitted
  });

  it("no browser attempt leaked through — the flag is still false", async () => {
    // Run the three browser attempts, then confirm the persisted value.
    await asUser(ownerUser(B), (q) => setFlag(q)).catch(() => undefined);
    await asUser(memberUser(B), (q) => setFlag(q)).catch(() => undefined);
    await asRole("anon", (q) => setFlag(q)).catch(() => undefined);
    const v = await adminQuery(
      `select practitioner_capacity_enabled from public.studios where id = $1`,
      [B.studioId],
    );
    expect(v.rows[0].practitioner_capacity_enabled).toBe(false);
  });
});

describe("Gate 2: SECURITY DEFINER helpers are not browser-callable", () => {
  it("authenticated cannot execute rematerialize_studio_reservations (42501)", async () => {
    await expect(
      asRole("authenticated", (q) =>
        q(`select public.rematerialize_studio_reservations($1::uuid)`, [B.studioId]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("anon cannot execute fanout_studio_wide_reservation (42501)", async () => {
    await expect(
      asRole("anon", (q) =>
        q(
          `select public.fanout_studio_wide_reservation($1::uuid, 'timed_block', gen_random_uuid(), now(), now())`,
          [B.studioId],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("authenticated cannot probe studio_capacity_enabled directly (42501)", async () => {
    await expect(
      asRole("authenticated", (q) =>
        q(`select public.studio_capacity_enabled($1::uuid)`, [B.studioId]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

describe("Gate 3: service_practitioners authorization", () => {
  it("owner cannot INSERT eligibility (service-role-only until PR B)", async () => {
    const svc = randomUUID();
    await adminQuery(
      `insert into public.services (id, studio_id, name) values ($1, $2, 'g3 svc')`,
      [svc, B.studioId],
    );
    await expect(
      asUser(ownerUser(B), (q) =>
        q(
          `insert into public.service_practitioners (studio_id, service_id, practitioner_id) values ($1,$2,$3)`,
          // A VALID active practitioner so the row passes the BEFORE active-guard
          // and the composite FKs; RLS (no write policy) is then the failing check.
          [B.studioId, svc, B.practitioners[0].practitionerId],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("a non-owner practitioner cannot INSERT eligibility", async () => {
    const svc = randomUUID();
    await adminQuery(
      `insert into public.services (id, studio_id, name) values ($1, $2, 'g3 svc2')`,
      [svc, B.studioId],
    );
    await expect(
      asUser(memberUser(B), (q) =>
        q(
          `insert into public.service_practitioners (studio_id, service_id, practitioner_id) values ($1,$2,$3)`,
          [B.studioId, svc, B.practitioners[1].practitionerId],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("owner/member may READ their own studio's eligibility; anon cannot", async () => {
    await adminQuery(
      `insert into public.services (id, studio_id, name) values ($1, $2, 'g3 read')`,
      [randomUUID(), B.studioId],
    );
    const ownerRows = await asUser(ownerUser(B), (q) =>
      q(`select count(*)::int as c from public.service_practitioners where studio_id = $1`, [
        B.studioId,
      ]),
    );
    expect(ownerRows.rows[0].c).toBeGreaterThan(0);
    const anonRows = await asRole("anon", (q) =>
      q(`select count(*)::int as c from public.service_practitioners where studio_id = $1`, [
        B.studioId,
      ]),
    );
    expect(anonRows.rows[0].c).toBe(0); // RLS: anon sees nothing
  });

  it("cross-studio: studio A owner cannot read studio B eligibility", async () => {
    const A = await seedSynthStudioA();
    try {
      await adminQuery(
        `insert into public.services (id, studio_id, name) values ($1, $2, 'g3 xstudio')`,
        [randomUUID(), B.studioId],
      );
      const rows = await asUser(ownerUser(A), (q) =>
        q(`select count(*)::int as c from public.service_practitioners where studio_id = $1`, [
          B.studioId,
        ]),
      );
      expect(rows.rows[0].c).toBe(0);
    } finally {
      await dropSynthStudio(A);
    }
  });

  it("an inactive practitioner cannot be newly marked eligible (23514)", async () => {
    const p = B.practitioners[2].practitionerId;
    // Deactivate FIRST, so the default-eligibility trigger skips p entirely and
    // there is no pre-existing (svc, p) row to confound the guard.
    await adminQuery(`update public.practitioners set active = false where id = $1`, [p]);
    const svc = randomUUID();
    await adminQuery(
      `insert into public.services (id, studio_id, name) values ($1, $2, 'g3 inactive')`,
      [svc, B.studioId],
    );
    // The default trigger added the 2 ACTIVE practitioners, not p.
    const seeded = await adminQuery(
      `select count(*)::int as c from public.service_practitioners where service_id = $1`,
      [svc],
    );
    expect(seeded.rows[0].c).toBe(2);
    // Even an operator (service-role/postgres) direct insert of p is fail-closed.
    await expect(
      adminQuery(
        `insert into public.service_practitioners (studio_id, service_id, practitioner_id) values ($1,$2,$3)`,
        [B.studioId, svc, p],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
