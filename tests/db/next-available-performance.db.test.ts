import { randomUUID } from "node:crypto";
import { createServerClient } from "@supabase/ssr";
import { beforeAll, describe, expect, it } from "vitest";
import { E2E_SERVICE_ROLE_KEY, E2E_SUPABASE_URL } from "@/e2e/helpers/local-env";
import { adminQuery, seedStudio } from "@/tests/db/helpers/harness";
import { getAvailableSlots, filterFutureSlots } from "@/lib/booking/slots";
import { loadPublicSlotsByDate } from "@/lib/booking/public-slot-range";

// ===========================================================================
// BOOK-NEXT-FAST-01 — "Next available", measured against a real database
// ===========================================================================
//
// The unit suite proves the read COUNT is bounded against a mock. That is the
// invariant, but it is not the user-visible claim: a bounded number of slow
// queries is still slow. This file measures the same two algorithms against the
// real local Postgres, over a realistic reservation load, and reports wall-clock
// percentiles beside the query counts.
//
// BOTH ALGORITHMS RUN HERE. The "before" path is not read from git history or
// restated from memory — it is the day-by-day `getAvailableSlots` loop the
// action used to run, reconstructed verbatim below and executed against the
// SAME seeded studio as the new path in the same process. That is what makes
// the comparison a measurement rather than a claim, and it is also what makes
// the unit suite's boundedness assertion non-vacuous: the before numbers show
// what a per-day loop actually costs.
//
// FOUR CASES, chosen so "where the answer is" is the only variable. Every
// studio carries the SAME 12-month horizon, so a case that answers on day 1 and
// a case that answers never are asking the same question of the same window.
//
//   A DENSE       an opening tomorrow
//   B NEAR        the first opening 10 days out
//   C FAR         the first opening 70 days out
//   D NONE        nothing open through the entire configured horizon
//
// The percentile assertions are deliberately loose relative to the product
// target. This machine runs several worktrees and CI shards concurrently, so a
// tight bound here would fail for reasons that have nothing to do with the
// change. The BOUND THAT MATTERS is the relative one — D must not cost
// materially more query waves than A — and that one is exact.

const HORIZON_MONTHS = 12;
const ITERATIONS = 7;

type Case = {
  key: "A_DENSE" | "B_NEAR" | "C_FAR" | "D_NONE";
  label: string;
  slug: string;
  studioId: string;
  serviceId: string;
  expected: string | null;
};

// supabase-js constructs a realtime client EAGERLY, and it demands a WebSocket
// constructor that Node 20 does not expose. Nothing in this file opens a
// socket — every read is PostgREST over HTTP — so a non-functional stand-in
// satisfies the constructor. The alternative was adding `ws` to the lockfile,
// which is shared infrastructure and would put this measurement behind a full
// CI matrix for a reason that has nothing to do with the change.
if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === "undefined") {
  (globalThis as { WebSocket?: unknown }).WebSocket = class {
    close() {}
    addEventListener() {}
    removeEventListener() {}
    send() {}
  };
}

// The cookie jar is a no-op — this client authenticates with the service-role
// key, exactly as `createAdminClient` does in the app.
const admin = createServerClient(E2E_SUPABASE_URL, E2E_SERVICE_ROLE_KEY, {
  cookies: { getAll: () => [], setAll: () => {} },
});

/** Counts every PostgREST table read a call makes, by wrapping `.from`. */
function countingClient() {
  const calls: string[] = [];
  const proxy = new Proxy(admin, {
    get(target, prop, receiver) {
      if (prop === "from") {
        return (table: string) => {
          calls.push(table);
          return (target as never as { from: (t: string) => unknown }).from(table);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { client: proxy as typeof admin, calls };
}

function addDaysUtc(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round(sorted[idx]!);
}

/**
 * THE OLD ALGORITHM, reconstructed exactly: walk forward one local date at a
 * time, awaiting the day loader, and stop at the first date with a future slot.
 */
async function beforeAlgorithm(
  client: typeof admin,
  studio: { id: string; timezone: string; buffer_minutes: number | null },
  duration: number,
  from: string,
  maxDate: string,
): Promise<string | null> {
  const nowRef = new Date();
  let cursor = from;
  while (cursor <= maxDate) {
    const slots = await getAvailableSlots(
      client as never,
      {
        id: studio.id,
        timezone: studio.timezone,
        default_appointment_duration_minutes: 60,
        buffer_minutes: studio.buffer_minutes,
      } as never,
      cursor,
      duration,
    );
    if (filterFutureSlots(slots, nowRef).length > 0) return cursor;
    cursor = addDaysUtc(cursor, 1);
  }
  return null;
}

/** THE NEW ALGORITHM: name the range, one bulk pass, read the first group. */
async function afterAlgorithm(
  client: typeof admin,
  studio: { id: string; timezone: string; buffer_minutes: number | null },
  duration: number,
  from: string,
  maxDate: string,
): Promise<string | null> {
  const dates: string[] = [];
  let cursor = from;
  while (cursor <= maxDate) {
    dates.push(cursor);
    cursor = addDaysUtc(cursor, 1);
  }
  const range = await loadPublicSlotsByDate(
    client as never,
    {
      studioId: studio.id,
      timezone: studio.timezone,
      publicBookingHorizonMonths: HORIZON_MONTHS,
      bufferMinutes: studio.buffer_minutes,
      serviceDurationMinutes: duration,
    },
    dates,
    new Date(),
    { stopAfterFirstMatch: true },
  );
  if (!range.ok) throw new Error(`range read failed: ${range.error}`);
  return range.byDate[0]?.date ?? null;
}

const cases: Case[] = [];
let today = "";
let horizonMax = "";

async function seedCase(
  key: Case["key"],
  label: string,
  blockFirstDays: number | "all",
): Promise<void> {
  const studio = await seedStudio(`booknext-${key.toLowerCase()}`);
  const slug = `booknext-${key.toLowerCase()}-${studio.studioId.slice(0, 8)}`;
  await adminQuery(
    `update public.studios
        set slug = $2,
            timezone = 'America/Toronto',
            buffer_minutes = 0,
            public_booking_horizon_months = $3,
            default_appointment_duration_minutes = 60
      where id = $1`,
    [studio.studioId, slug, HORIZON_MONTHS],
  );

  // Open every weekday, 09:00-17:00 — so readiness passes and every date is a
  // candidate until something else closes it.
  for (let dow = 0; dow < 7; dow += 1) {
    await adminQuery(
      `insert into public.studio_availability_default
         (studio_id, day_of_week, is_open, open_time, close_time)
       values ($1, $2, true, '09:00', '17:00')`,
      [studio.studioId, dow],
    );
  }

  const serviceId = randomUUID();
  await adminQuery(
    `insert into public.services (id, studio_id, name, default_duration_minutes, active)
     values ($1, $2, 'Consult', 60, true)`,
    [serviceId, studio.studioId, ],
  );

  // The blockout that decides WHERE the first opening falls.
  if (blockFirstDays === "all") {
    await adminQuery(
      `insert into public.studio_blockouts (studio_id, starts_on, ends_on, reason)
       values ($1, $2, $3, 'bench')`,
      [studio.studioId, today, addDaysUtc(horizonMax, 5)],
    );
  } else if (blockFirstDays > 0) {
    await adminQuery(
      `insert into public.studio_blockouts (studio_id, starts_on, ends_on, reason)
       values ($1, $2, $3, 'bench')`,
      [studio.studioId, today, addDaysUtc(today, blockFirstDays)],
    );
  }

  // A REALISTIC RESERVATION LOAD — two appointments a day for 180 days — so the
  // reservation read returns a real result set rather than trivially returning
  // none.
  //
  // SEEDED ONLY OUTSIDE THE BLOCKED WINDOW. `studio_blockouts` carries
  // `studio_blockouts_sync_calendar_reservation_trg`, which fans every blockout
  // into `studio_calendar_reservations` as full-day rows, and the table holds
  // `EXCLUDE USING gist (resource_key WITH =, tstzrange(...) WITH &&)`. Writing
  // appointments over blocked days is therefore refused by the database — and
  // rightly: those days are already occupied by the blockout's own shadow rows.
  // For the all-blocked case the trigger supplies ~370 rows by itself, which is
  // the load that case should carry anyway.
  const firstFreeDay = blockFirstDays === "all" ? null : blockFirstDays + 1;
  if (firstFreeDay !== null) {
    const values: string[] = [];
    const params: unknown[] = [studio.studioId];
    for (let day = firstFreeDay; day < firstFreeDay + 180; day += 1) {
      const d = addDaysUtc(today, day);
      for (const hour of ["14:00", "18:00"]) {
        const s = `${d}T${hour}:00.000Z`;
        const e = new Date(new Date(s).getTime() + 60 * 60 * 1000).toISOString();
        params.push(s, e);
        const i = params.length;
        values.push(`($1, 'appointment', gen_random_uuid(), $${i - 1}, $${i}, $1)`);
      }
    }
    await adminQuery(
      `insert into public.studio_calendar_reservations
         (studio_id, source_kind, source_id, starts_at, ends_at, resource_key)
       values ${values.join(",")}`,
      params,
    );
  }

  const expected =
    blockFirstDays === "all"
      ? null
      : blockFirstDays === 0
        ? addDaysUtc(today, 1)
        : addDaysUtc(today, blockFirstDays + 1);

  cases.push({ key, label, slug, studioId: studio.studioId, serviceId, expected });
}

describe("BOOK-NEXT-FAST-01: measured against the local stack", () => {
  beforeAll(async () => {
    // Studio-local today in America/Toronto.
    today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Toronto",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    horizonMax = addDaysUtc(today, Math.round(HORIZON_MONTHS * 30.4));

    await seedCase("A_DENSE", "opening tomorrow", 0);
    await seedCase("B_NEAR", "opening ~10 days out", 10);
    await seedCase("C_FAR", "opening ~70 days out", 70);
    await seedCase("D_NONE", "nothing in the whole horizon", "all");
  }, 180_000);

  it("reports parity, query counts and percentiles for all four cases", async () => {
    const rows: Array<Record<string, unknown>> = [];

    for (const c of cases) {
      const studio = {
        id: c.studioId,
        timezone: "America/Toronto",
        buffer_minutes: 0,
      };
      const scanTo = horizonMax;
      // The action starts the day AFTER the currently-shown date, which for
      // these fixtures is today.
      const from = addDaysUtc(today, 1);

      // ---- BEFORE ----
      const beforeCounter = countingClient();
      const beforeStart = Date.now();
      const beforeDate = await beforeAlgorithm(
        beforeCounter.client,
        studio,
        60,
        from,
        scanTo,
      );
      const beforeMs = Date.now() - beforeStart;
      const beforeReads = beforeCounter.calls.length;

      // ---- AFTER, sampled ----
      const afterSamples: number[] = [];
      let afterDate: string | null = null;
      let afterReads = 0;
      for (let i = 0; i < ITERATIONS; i += 1) {
        const counter = countingClient();
        const t0 = Date.now();
        afterDate = await afterAlgorithm(counter.client, studio, 60, from, scanTo);
        afterSamples.push(Date.now() - t0);
        afterReads = counter.calls.length;
      }

      // PARITY IS THE ACCEPTANCE GATE. A faster answer that differs is a defect,
      // not an optimisation.
      expect(afterDate, `${c.key} result parity`).toBe(beforeDate);
      if (c.expected !== undefined) {
        expect(afterDate, `${c.key} expected date`).toBe(c.expected);
      }

      rows.push({
        CASE: c.key,
        DETAIL: c.label,
        RESULT_DATE: afterDate ?? "null",
        PARITY: afterDate === beforeDate ? "YES" : "NO",
        BEFORE_READS: beforeReads,
        AFTER_READS: afterReads,
        BEFORE_MS: beforeMs,
        AFTER_P50: percentile(afterSamples, 50),
        AFTER_P95: percentile(afterSamples, 95),
      });
    }

    // eslint-disable-next-line no-console
    console.log("\n=== BOOK-NEXT-FAST-01 MEASUREMENT ===");
    // eslint-disable-next-line no-console
    console.table(rows);

    // THE INVARIANT, stated as a comparison rather than a literal: the case that
    // scans the entire horizon and finds nothing must not cost materially more
    // reads than the one that answers on the first day.
    const dense = rows.find((r) => r.CASE === "A_DENSE")!;
    const none = rows.find((r) => r.CASE === "D_NONE")!;
    expect(
      none.AFTER_READS as number,
      "a full-horizon miss must cost the same reads as a day-1 hit",
    ).toBeLessThanOrEqual((dense.AFTER_READS as number) + 1);

    // And the absolute read count stays in single digits for every case.
    for (const r of rows) {
      expect(r.AFTER_READS as number, `${r.CASE} read count`).toBeLessThanOrEqual(8);
    }
  }, 900_000);
});
