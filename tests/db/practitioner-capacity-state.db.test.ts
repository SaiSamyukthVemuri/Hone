import { afterAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { adminQuery, asRole, asUser, closePool, resolveLocalDbUrl } from "./helpers/harness";
import {
  dropSynthStudio,
  seedSynthStudioB,
  type SynthStudio,
} from "./helpers/synth-fleet";
import { randomUUID } from "node:crypto";

// PR B Part 3B-0: the two-flag capacity state model:
//   Legacy (cap=F,book=F) / Configuring (cap=T,book=F) / Live (cap=T,book=T) /
//   Draining (cap=T,book=F). Invalid: cap=F,book=T. Emergency pause = flip
//   booking OFF (instant, keeps parallel appts). Structural deactivation =
//   preflighted retirement RPC.

let B: SynthStudio;
let clientB: string;

beforeEach(async () => {
  B = await seedSynthStudioB();
  await adminQuery(`update public.studios set buffer_minutes = 0 where id = $1`, [B.studioId]);
  clientB = randomUUID();
  await adminQuery(
    `insert into public.clients (id, studio_id, name) values ($1, $2, 'state client')`,
    [clientB, B.studioId],
  );
});
afterEach(async () => {
  if (B) await dropSynthStudio(B);
});
afterAll(async () => {
  await closePool();
});

const setCap = (v: boolean) =>
  adminQuery(`update public.studios set practitioner_capacity_enabled = $2 where id = $1`, [B.studioId, v]);
const setBook = (v: boolean) =>
  adminQuery(`update public.studios set practitioner_capacity_booking_enabled = $2 where id = $1`, [B.studioId, v]);

function insertAppt(
  practitionerId: string,
  startsAt: string,
  endsAt: string,
  status = "confirmed",
) {
  return adminQuery(
    `insert into public.appointments
       (id, studio_id, client_id, practitioner_id, starts_at, ends_at,
        duration_minutes, buffer_minutes_snapshot, blocked_ends_at, status)
     values ($1, $2, $3, $4, $5, $6, 60, 0, $6, $7) returning id`,
    [randomUUID(), B.studioId, clientB, practitionerId, startsAt, endsAt, status],
  );
}

const T10 = "2031-04-10T10:00:00Z";
const T11 = "2031-04-10T11:00:00Z";
const T1030 = "2031-04-10T10:30:00Z";
const T1130 = "2031-04-10T11:30:00Z";

const ownerUser = () => B.practitioners.find((p) => p.role === "owner")!.userId;
const memberUser = () => B.practitioners.find((p) => p.role === "practitioner")!.userId;

describe("Part 3B-0: both flags are operator-controlled", () => {
  it("owner cannot flip the booking flag directly (guard 42501)", async () => {
    await setCap(true); // capacity must be on before booking (CHECK)
    await expect(
      asUser(ownerUser(), (q) =>
        q(`update public.studios set practitioner_capacity_booking_enabled = true where id = $1`, [B.studioId]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("a non-owner practitioner and anon cannot flip the booking flag", async () => {
    await setCap(true);
    // Non-owner is blocked by the studios owner-update RLS (0 rows) BEFORE the
    // guard fires; either way the flag does not change.
    const member = await asUser(memberUser(), (q) =>
      q(`update public.studios set practitioner_capacity_booking_enabled = true where id = $1`, [B.studioId]),
    );
    expect(member.rowCount).toBe(0);
    const anon = await asRole("anon", (q) =>
      q(`update public.studios set practitioner_capacity_booking_enabled = true where id = $1`, [B.studioId]),
    )
      .then((r) => ({ rows: r.rowCount, err: null as string | null }))
      .catch((e) => ({ rows: null, err: e.code as string }));
    expect(anon.rows === 0 || anon.err != null).toBe(true);
    // Confirm the flag never changed.
    const s = await adminQuery(
      `select practitioner_capacity_booking_enabled b from public.studios where id = $1`,
      [B.studioId],
    );
    expect(s.rows[0].b).toBe(false);
  });

  it("service_role can perform the reviewed transition", async () => {
    await setCap(true);
    const r = await asRole("service_role", (q) =>
      q(`update public.studios set practitioner_capacity_booking_enabled = true where id = $1`, [B.studioId]),
    );
    expect(r.rowCount).toBe(1);
  });
});

describe("Part 3B-0: state validity", () => {
  it("booking cannot be enabled while capacity is disabled (CHECK 23514)", async () => {
    await expect(setBook(true)).rejects.toMatchObject({ code: "23514" });
  });

  it("Legacy -> Configuring -> Live is valid", async () => {
    await expect(setCap(true)).resolves.toBeTruthy(); // Configuring
    await expect(setBook(true)).resolves.toBeTruthy(); // Live
    const s = await adminQuery(
      `select practitioner_capacity_enabled c, practitioner_capacity_booking_enabled b from public.studios where id = $1`,
      [B.studioId],
    );
    expect(s.rows[0]).toMatchObject({ c: true, b: true });
  });
});

describe("Part 3B-0: emergency pause vs structural retirement", () => {
  it("emergency pause (Live -> Draining) succeeds even with overlapping practitioner appointments", async () => {
    await setCap(true);
    await setBook(true); // Live
    // Parallel appointments for two practitioners.
    await insertAppt(B.practitioners[0].practitionerId, T10, T11);
    await insertAppt(B.practitioners[1].practitionerId, T1030, T1130);
    // Flip booking OFF: instant, no rematerialization, appts stay valid.
    await expect(setBook(false)).resolves.toBeTruthy();
    const s = await adminQuery(
      `select practitioner_capacity_enabled c, practitioner_capacity_booking_enabled b from public.studios where id = $1`,
      [B.studioId],
    );
    expect(s.rows[0]).toMatchObject({ c: true, b: false }); // Draining, capacity intact
    const appts = await adminQuery(
      `select count(*)::int as n from public.appointments where studio_id = $1 and status = 'confirmed'`,
      [B.studioId],
    );
    expect(appts.rows[0].n).toBe(2); // both parallel appointments remain
  });

  it("structural retirement is blocked by overlaps, then succeeds once resolved", async () => {
    await setCap(true);
    await setBook(true);
    const a1 = (await insertAppt(B.practitioners[0].practitionerId, T10, T11)).rows[0].id;
    await insertAppt(B.practitioners[1].practitionerId, T1030, T1130);
    await setBook(false); // Draining (retire requires booking off)

    // Retire while overlaps exist -> fails closed with a reason code + count.
    await expect(
      adminQuery(`select public.retire_practitioner_capacity($1)`, [B.studioId]),
    ).rejects.toMatchObject({
      code: "23P01",
      message: expect.stringContaining("overlapping_appointments"),
    });
    // Capacity is still ON (retirement rolled back).
    const mid = await adminQuery(
      `select practitioner_capacity_enabled c from public.studios where id = $1`,
      [B.studioId],
    );
    expect(mid.rows[0].c).toBe(true);

    // Resolve the conflict (cancel one), then retire succeeds -> Legacy.
    await adminQuery(`update public.appointments set status = 'cancelled' where id = $1`, [a1]);
    await expect(
      adminQuery(`select public.retire_practitioner_capacity($1)`, [B.studioId]),
    ).resolves.toBeTruthy();
    const done = await adminQuery(
      `select practitioner_capacity_enabled c from public.studios where id = $1`,
      [B.studioId],
    );
    expect(done.rows[0].c).toBe(false);
  });

  it("retirement is blocked while booking is still enabled", async () => {
    await setCap(true);
    await setBook(true); // still Live
    await expect(
      adminQuery(`select public.retire_practitioner_capacity($1)`, [B.studioId]),
    ).rejects.toMatchObject({ message: expect.stringContaining("booking_still_enabled") });
  });

  it("the retirement RPCs are not callable by browser roles (42501)", async () => {
    await expect(
      asRole("authenticated", (q) => q(`select public.retire_practitioner_capacity($1)`, [B.studioId])),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      asRole("anon", (q) => q(`select public.practitioner_capacity_retirement_blockers($1)`, [B.studioId])),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

describe("Part 3B-2: capacity-participation predicate (preflight == rematerialize)", () => {
  it("retirement is NOT blocked by expired (historical) completed parallel appointments", async () => {
    await setCap(true); // Configuring/Draining (booking stays false)
    // Two overlapping COMPLETED appointments in the PAST for different
    // practitioners, historical parallel work that must not participate.
    await insertAppt(B.practitioners[0].practitionerId, "2020-01-01T10:00:00Z", "2020-01-01T11:00:00Z", "completed");
    await insertAppt(B.practitioners[1].practitionerId, "2020-01-01T10:30:00Z", "2020-01-01T11:30:00Z", "completed");

    // Blockers report zero overlaps (predicate excludes expired completed).
    const bl = await adminQuery(
      `select overlapping_appointments o from public.practitioner_capacity_retirement_blockers($1)`,
      [B.studioId],
    );
    expect(bl.rows[0].o).toBe(0);
    // Retirement succeeds: preflight and rematerialization agree (neither counts
    // nor re-keys the expired rows), so no studio-wide 23P01.
    await expect(
      adminQuery(`select public.retire_practitioner_capacity($1)`, [B.studioId]),
    ).resolves.toBeTruthy();
    const s = await adminQuery(
      `select practitioner_capacity_enabled c from public.studios where id = $1`,
      [B.studioId],
    );
    expect(s.rows[0].c).toBe(false);
  });

  it("a FUTURE confirmed parallel pair still blocks (predicate includes confirmed)", async () => {
    await setCap(true);
    await insertAppt(B.practitioners[0].practitionerId, T10, T11);
    await insertAppt(B.practitioners[1].practitionerId, T1030, T1130);
    const bl = await adminQuery(
      `select overlapping_appointments o from public.practitioner_capacity_retirement_blockers($1)`,
      [B.studioId],
    );
    expect(bl.rows[0].o).toBe(1);
  });
});

describe("Part 3B-3: nonexistent-studio preflight is not a safe zero", () => {
  it("blockers reports studio_exists=false for an unknown studio", async () => {
    const r = await adminQuery(
      `select studio_exists e, overlapping_appointments o from public.practitioner_capacity_retirement_blockers($1)`,
      [randomUUID()],
    );
    expect(r.rows[0].e).toBe(false);
  });
  it("retirement of an unknown studio raises studio_not_found (P0002)", async () => {
    await expect(
      adminQuery(`select public.retire_practitioner_capacity($1)`, [randomUUID()]),
    ).rejects.toMatchObject({ message: expect.stringContaining("studio_not_found") });
  });
});

describe("Part 3B-4: retirement serializes per studio via the advisory lock", () => {
  it("a second transaction cannot acquire the studio capacity lock while held", async () => {
    const a = new Client({ connectionString: resolveLocalDbUrl() });
    const b = new Client({ connectionString: resolveLocalDbUrl() });
    await a.connect();
    await b.connect();
    try {
      await a.query("begin");
      await a.query("select public.acquire_studio_capacity_lock($1)", [B.studioId]); // A holds it
      await b.query("begin");
      await b.query("set local statement_timeout = '800ms'");
      // B blocks on the SAME lock -> statement timeout (57014).
      await expect(
        b.query("select public.acquire_studio_capacity_lock($1)", [B.studioId]),
      ).rejects.toMatchObject({ code: "57014" });
      await b.query("rollback").catch(() => undefined);
      // A releases on rollback; B can then acquire.
      await a.query("rollback");
      await b.query("begin");
      await expect(
        b.query("select public.acquire_studio_capacity_lock($1)", [B.studioId]),
      ).resolves.toBeTruthy();
      await b.query("rollback");
    } finally {
      await a.end();
      await b.end();
    }
  });
});
