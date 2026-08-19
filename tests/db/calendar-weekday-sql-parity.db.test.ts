import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, closePool } from "./helpers/harness";
import { calendarDayOfWeek } from "@/lib/booking/tz";

// ===========================================================================
// TS <-> SQL PARITY: calendar-date weekday derivation
// ===========================================================================
//
// The weekly availability row for a studio-local calendar date is selected by
// its weekday. Postgres derives that weekday from the calendar date itself —
// `extract(dow from p_local_date)` in public_booking_slot_candidates (0170:283)
// and public_reschedule_slot_candidates (0171:360, 0171:370), and
// `extract(dow from v_local_start)` in both public validators (0170:493,
// 0171:641).
//
// TypeScript did NOT. `lib/booking/slots.ts` fabricated an instant — noon UTC
// on the requested date — and asked which local day it fell on in the studio's
// timezone. For a studio at UTC offset >= +12 that instant has already crossed
// into the next local day, so a Monday resolved to Tuesday's row.
//
// The conclusion this suite establishes MECHANICALLY, rather than by assertion:
//
//   * SQL was right;
//   * TypeScript was wrong, and wrong ONLY for studios at offset >= +12;
//   * the repaired TypeScript agrees with SQL everywhere;
//   * no SQL changed, and none needed to.
//
// The historical derivation is reproduced below verbatim so the "before" half
// stays falsifiable: if someone later claims the old code was fine, this suite
// contradicts them with a live Postgres in the loop.

// The pre-repair derivation from lib/booking/slots.ts, kept EXACTLY as it was:
//   const dow = localDayOfWeek(new Date(`${dateStr}T12:00:00Z`), tz);
// with localDayOfWeek (lib/booking/tz.ts) inlined. This is a historical record,
// not a utility — nothing in production calls it.
function historicalDerivation(dateStr: string, tz: string): number {
  const localDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(`${dateStr}T12:00:00Z`));
  return new Date(`${localDate}T12:00:00Z`).getUTCDay();
}

const ZONES_AT_OR_ABOVE_PLUS_12 = [
  "Pacific/Kiritimati", // +14
  "Pacific/Apia", // +13
  "Pacific/Auckland", // +12 / +13
  "Pacific/Fiji", // +12 / +13
  "Pacific/Chatham", // +12:45 / +13:45
  "Asia/Kamchatka", // +12
];

const CONTROL_ZONES = [
  "Australia/Sydney", // +10 / +11
  "Asia/Tokyo", // +9
  "Europe/London", // 0 / +1
  "UTC", // 0
  "America/Toronto", // -5 / -4
  "Pacific/Honolulu", // -10
  "Pacific/Midway", // -11
  "Etc/GMT+12", // -12
];

const ALL_ZONES = [...ZONES_AT_OR_ABOVE_PLUS_12, ...CONTROL_ZONES];

const DATES = [
  "2026-01-05", // Monday
  "2026-02-28", // Saturday, month boundary
  "2026-03-08", // Sunday, US spring-forward
  "2026-04-05", // Sunday, AU/NZ fall-back
  "2026-06-21", // Sunday
  "2026-08-17", // Monday
  "2026-09-27", // Sunday, NZ spring-forward
  "2026-11-01", // Sunday, US fall-back
  "2026-12-31", // Thursday
  "2027-01-01", // Friday, year boundary
];

/** Postgres's own answer, read once per date — a `date` carries no timezone. */
async function sqlWeekdays(): Promise<Map<string, number>> {
  const r = await adminQuery(
    `select d::text as iso, extract(dow from d)::int as dow
       from unnest($1::date[]) d`,
    [DATES],
  );
  return new Map(r.rows.map((row) => [row.iso as string, row.dow as number]));
}

afterAll(async () => {
  await closePool();
});

describe("calendar weekday — TypeScript agrees with the SQL authority", () => {
  it("matches extract(dow from date) for every date, in every studio timezone", async () => {
    const sql = await sqlWeekdays();
    const disagreements: string[] = [];

    for (const date of DATES) {
      const expected = sql.get(date);
      expect(expected, `Postgres must answer for ${date}`).toBeTypeOf("number");
      for (const tz of ALL_ZONES) {
        // The repaired derivation takes no timezone at all; the zone is carried
        // through the loop to prove the answer cannot vary with it.
        const actual = calendarDayOfWeek(date);
        if (actual !== expected) {
          disagreements.push(`${tz} ${date}: TS ${actual} != SQL ${expected}`);
        }
      }
    }

    expect(disagreements).toEqual([]);
  });

  it("Postgres itself treats a date's weekday as timezone-free", async () => {
    // Guards the premise rather than assuming it: if `extract(dow from date)`
    // were somehow session-timezone sensitive, the parity claim would be empty.
    for (const tz of ["UTC", "Pacific/Kiritimati", "America/Toronto"]) {
      const r = await adminQuery(
        `select set_config('TimeZone', $1, false),
                extract(dow from '2026-08-17'::date)::int as dow`,
        [tz],
      );
      expect(r.rows[0].dow, `session TimeZone ${tz}`).toBe(1); // Monday
    }
    await adminQuery(`select set_config('TimeZone', 'UTC', false)`);
  });
});

describe("calendar weekday — the historical derivation, measured against SQL", () => {
  it("DISAGREED with SQL on every date, in every studio at offset >= +12", async () => {
    const sql = await sqlWeekdays();
    const agreements: string[] = [];

    for (const tz of ZONES_AT_OR_ABOVE_PLUS_12) {
      for (const date of DATES) {
        if (historicalDerivation(date, tz) === sql.get(date)) {
          agreements.push(`${tz} ${date}`);
        }
      }
    }

    // Every one of these was a real disagreement with the SQL that decides.
    expect(agreements).toEqual([]);
    expect(ZONES_AT_OR_ABOVE_PLUS_12.length * DATES.length).toBe(60);
  });

  it("AGREED with SQL in every control zone — so the repair changes nothing there", async () => {
    const sql = await sqlWeekdays();
    const disagreements: string[] = [];

    for (const tz of CONTROL_ZONES) {
      for (const date of DATES) {
        if (historicalDerivation(date, tz) !== sql.get(date)) {
          disagreements.push(`${tz} ${date}`);
        }
      }
    }

    expect(disagreements).toEqual([]);
  });

  it("the repair is EXACTLY the affected set: 60 of 140 pairs change, 80 do not", async () => {
    const sql = await sqlWeekdays();
    let changed = 0;
    let unchanged = 0;

    for (const tz of ALL_ZONES) {
      for (const date of DATES) {
        const before = historicalDerivation(date, tz);
        const after = calendarDayOfWeek(date);
        expect(after, `${tz} ${date} must match SQL after repair`).toBe(sql.get(date));
        if (before === after) unchanged++;
        else changed++;
      }
    }

    // A falsifiable blast-radius statement: the repair moves exactly the pairs
    // that were wrong, and no others.
    expect(changed).toBe(60);
    expect(unchanged).toBe(80);
    expect(changed + unchanged).toBe(ALL_ZONES.length * DATES.length);
  });
});
