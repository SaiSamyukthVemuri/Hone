import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  closePool,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";
import { randomUUID } from "node:crypto";

// WAIT-v4 PR0 — the DB half of the midnight buffer spill parity proof.
//
// THE DIVERGENCE THIS CLOSES. The TS loaders selected the day's reservations on
// the shadow's ACTUAL `ends_at`, while `protectedIntervals` re-applies the studio
// buffer to reach the PROTECTED end. A 23:50 appointment under a 30-minute buffer
// is protected to 00:20, but `ends_at > 00:00` is false — so it was never loaded
// for the following day, 00:00 was OFFERED, and this authority REFUSED the write.
//
// WHY THE PROOF IS SPLIT. The db lane cannot execute the TS reader — there is no
// local REST client, as availability-parity.db.test.ts records. So the reader side
// (00:00 is no longer offered, and 00:20 is) is proven in
// tests/lib/booking/slots-midnight-buffer-window.test.ts against a double that
// honours the `gt` filter, and THIS file proves the authority side: that 00:00 was
// genuinely refusable and 00:20 genuinely acceptable. Together they are the parity
// claim — the engine now offers exactly what this trigger accepts.
//
// It also pins the premise the reader's repair rests on: the refusal is
// `HB001 appointment_buffer_conflict` from 0152's enforce_appointment_buffer, and
// `blocked_ends_at` really is `ends_at + buffer`, not the raw end.

let s: SeededStudio;

// 23:50–00:50 local is deliberately NOT used: the prior appointment ENDS at 23:50
// and only its BUFFER crosses midnight, which is the whole point. In UTC with a
// fixed offset the dates below are a single contiguous evening.
const PREV_START = "2030-06-11T23:00:00Z";
const PREV_END = "2030-06-11T23:50:00Z";
const MIDNIGHT = "2030-06-12T00:00:00Z";
const MIDNIGHT_END = "2030-06-12T01:00:00Z";
const AFTER_BUFFER = "2030-06-12T00:20:00Z";
const AFTER_BUFFER_END = "2030-06-12T01:20:00Z";

const BUFFER = 30;

beforeAll(async () => {
  s = await seedStudio("midnight-buffer");
  await adminQuery(
    `update public.studios set buffer_minutes = $2 where id = $1`,
    [s.studioId, BUFFER],
  );
  // The previous evening's appointment. `blocked_ends_at` is left to the BEFORE
  // trigger so this fixture cannot disagree with the authority about what the
  // protected end is.
  await adminQuery(
    `insert into public.appointments
       (id, studio_id, client_id, starts_at, ends_at, duration_minutes, status)
     values ($1, $2, $3, $4, $5, 50, 'confirmed')`,
    [randomUUID(), s.studioId, s.clientId, PREV_START, PREV_END],
  );
});

afterAll(async () => {
  await closePool();
});

function book(startsAt: string, endsAt: string) {
  return adminQuery(
    `insert into public.appointments
       (id, studio_id, client_id, starts_at, ends_at, duration_minutes, status)
     values ($1, $2, $3, $4, $5, 60, 'confirmed')`,
    [randomUUID(), s.studioId, s.clientId, startsAt, endsAt],
  );
}

describe("WAIT-v4 PR0 · the buffer that crosses local midnight is real", () => {
  it("the prior appointment's protected end reaches PAST midnight", async () => {
    // The premise. Without this the rest would prove nothing: if the trigger did
    // not extend the protected end, there would be no conflict to agree about.
    const res = await adminQuery(
      `select blocked_ends_at, buffer_minutes_snapshot as snap
         from public.appointments
        where studio_id = $1 and starts_at = $2`,
      [s.studioId, PREV_START],
    );
    const rows = res.rows as Array<{ blocked_ends_at: string; snap: number }>;
    expect(rows.length).toBe(1);
    expect(Number(rows[0]!.snap)).toBe(BUFFER);
    expect(
      new Date(rows[0]!.blocked_ends_at).toISOString(),
      "blocked_ends_at must be ends_at + buffer, i.e. 00:20 the NEXT day",
    ).toBe(new Date(AFTER_BUFFER).toISOString());
  });

  it("REFUSES midnight — the start the generator used to offer", async () => {
    await expect(book(MIDNIGHT, MIDNIGHT_END)).rejects.toMatchObject({
      code: "HB001",
    });
  });

  it("ACCEPTS the protected end itself, so the repair withheld nothing extra", async () => {
    // The control that keeps this from being satisfied by a trigger that refuses
    // everything: 00:20 touches the protected end and touching is allowed, which
    // is exactly the start the reader now offers first.
    await expect(book(AFTER_BUFFER, AFTER_BUFFER_END)).resolves.toBeDefined();
  });
});
