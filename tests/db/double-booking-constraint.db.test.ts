import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  closePool,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";
import { randomUUID } from "node:crypto";

// PR #220 suite E: the double-booking exclusion constraint
// (no_overlapping_active_appointments_per_studio, GiST on
// studio_id + tstzrange(starts_at, blocked_ends_at) where
// status = 'confirmed'), proven by actually colliding two inserts.

let s: SeededStudio;

beforeAll(async () => {
  s = await seedStudio("overlap");
  // A BEFORE trigger (snapshot_appointment_buffer) recomputes
  // blocked_ends_at = ends_at + the studio's buffer_minutes on every
  // insert, a behavior this harness discovered the static tests
  // never proved. Pin the buffer to 0 so the range math below is
  // exact; the buffer behavior itself gets its own test.
  await adminQuery(`update public.studios set buffer_minutes = 0 where id = $1`, [
    s.studioId,
  ]);
});

afterAll(async () => {
  await closePool();
});

function insertAppointment(input: {
  studioId: string;
  clientId: string;
  startsAt: string;
  endsAt: string;
  status?: string;
}) {
  return adminQuery(
    `insert into public.appointments
       (id, studio_id, client_id, starts_at, ends_at, duration_minutes,
        buffer_minutes_snapshot, blocked_ends_at, status)
     values ($1, $2, $3, $4, $5, 60, 0, $5, $6)`,
    [
      randomUUID(),
      input.studioId,
      input.clientId,
      input.startsAt,
      input.endsAt,
      input.status ?? "confirmed",
    ],
  );
}

describe("E: overlapping confirmed appointments are structurally impossible", () => {
  // Fixed local-test timestamps; the studio id is unique per run so
  // there is no collision with rows from earlier runs.
  const T10 = "2030-01-15T10:00:00Z";
  const T11 = "2030-01-15T11:00:00Z";
  const T1030 = "2030-01-15T10:30:00Z";
  const T1130 = "2030-01-15T11:30:00Z";

  it("first confirmed insert succeeds; overlapping second fails with exclusion error 23P01", async () => {
    const first = await insertAppointment({
      studioId: s.studioId,
      clientId: s.clientId,
      startsAt: T10,
      endsAt: T11,
    });
    expect(first.rowCount).toBe(1);

    await expect(
      insertAppointment({
        studioId: s.studioId,
        clientId: s.clientId,
        startsAt: T1030,
        endsAt: T1130,
      }),
    ).rejects.toMatchObject({ code: "23P01" });
  });

  it("a back-to-back appointment (touching, not overlapping) is allowed", async () => {
    // [10:00,11:00) and [11:00,12:00) do not overlap under '[)'.
    const second = await insertAppointment({
      studioId: s.studioId,
      clientId: s.clientId,
      startsAt: T11,
      endsAt: "2030-01-15T12:00:00Z",
    });
    expect(second.rowCount).toBe(1);
  });

  it("the studio buffer extends the blocked range (trigger-snapshotted)", async () => {
    const buffered = await seedStudio("overlap-buffered");
    await adminQuery(
      `update public.studios set buffer_minutes = 15 where id = $1`,
      [buffered.studioId],
    );
    const first = await insertAppointment({
      studioId: buffered.studioId,
      clientId: buffered.clientId,
      startsAt: T10,
      endsAt: T11,
    });
    expect(first.rowCount).toBe(1);
    // Actual overlap is the only HARD constraint now; the 15-min buffer is a
    // SOFT proximity rule enforced for normal writers by the enforce_appointment_buffer
    // trigger. A back-to-back 11:00 booking does NOT actually overlap [10:00,11:00)
    // but sits inside the 15-min buffer, so this direct (non-override) insert is
    // rejected by the trigger with HB001 — not the hard 23P01 exclusion.
    await expect(
      insertAppointment({
        studioId: buffered.studioId,
        clientId: buffered.clientId,
        startsAt: T11,
        endsAt: "2030-01-15T12:00:00Z",
      }),
    ).rejects.toMatchObject({ code: "HB001" });
  });

  it("a cancelled appointment does not block the slot", async () => {
    const other = await seedStudio("overlap-cancelled");
    const cancelled = await insertAppointment({
      studioId: other.studioId,
      clientId: other.clientId,
      startsAt: T10,
      endsAt: T11,
      status: "cancelled",
    });
    expect(cancelled.rowCount).toBe(1);
    const confirmed = await insertAppointment({
      studioId: other.studioId,
      clientId: other.clientId,
      startsAt: T10,
      endsAt: T11,
    });
    expect(confirmed.rowCount).toBe(1);
  });
});
