import { describe, expect, it } from "vitest";
import {
  localDateString,
  localTimeString,
  utcInstantFromLocal,
} from "@/lib/booking/tz";

// PR #184. utcInstantFromLocal previously corrected the naive instant
// with a single offset sample taken at the naive instant. When the
// naive and corrected instants straddle a DST transition that sample
// is the pre-transition offset, so local times in the hours after a
// spring-forward jump were stored one hour late (Toronto 2026-03-08
// 03:30 became 08:30Z, which renders back as 04:30). The fix
// re-samples the offset at the corrected instant and re-applies when
// it differs. These tests pin the round-trip property: local wall
// time -> UTC -> local wall time must be the identity for every real
// wall-clock time, on DST days and normal days alike.

const TZ = "America/Toronto";

function roundTrip(date: string, time: string, tz: string) {
  const utc = utcInstantFromLocal(date, time, tz);
  return {
    utcIso: utc.toISOString(),
    localDate: localDateString(utc, tz),
    localTime: localTimeString(utc, tz),
  };
}

describe("utcInstantFromLocal: Toronto spring-forward day 2026-03-08", () => {
  it("03:30 local round-trips as 03:30 (was 04:30 before the two-pass fix)", () => {
    const r = roundTrip("2026-03-08", "03:30", TZ);
    expect(r.utcIso).toBe("2026-03-08T07:30:00.000Z");
    expect(r.localDate).toBe("2026-03-08");
    expect(r.localTime).toBe("03:30");
  });

  it("05:30 local round-trips as 05:30 (was 06:30 before the two-pass fix)", () => {
    const r = roundTrip("2026-03-08", "05:30", TZ);
    expect(r.utcIso).toBe("2026-03-08T09:30:00.000Z");
    expect(r.localDate).toBe("2026-03-08");
    expect(r.localTime).toBe("05:30");
  });

  it("09:00 local still round-trips as 09:00 (already correct pre-fix)", () => {
    const r = roundTrip("2026-03-08", "09:00", TZ);
    expect(r.utcIso).toBe("2026-03-08T13:00:00.000Z");
    expect(r.localDate).toBe("2026-03-08");
    expect(r.localTime).toBe("09:00");
  });

  it("00:00 local still round-trips as 00:00 (midnight blockout anchor)", () => {
    const r = roundTrip("2026-03-08", "00:00", TZ);
    expect(r.utcIso).toBe("2026-03-08T05:00:00.000Z");
    expect(r.localDate).toBe("2026-03-08");
    expect(r.localTime).toBe("00:00");
  });

  it("a full-day [00:00, next-day 00:00) blockout window spans 23 hours, not 24", () => {
    // The day-long projection used by blockouts and the calendar grid
    // anchors both endpoints through utcInstantFromLocal. On the
    // spring-forward day the local day really is 23 hours long.
    const start = utcInstantFromLocal("2026-03-08", "00:00", TZ);
    const end = utcInstantFromLocal("2026-03-09", "00:00", TZ);
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(23);
  });
});

describe("utcInstantFromLocal: normal days unchanged", () => {
  it("summer (EDT) afternoon round-trips and stores at -4", () => {
    const r = roundTrip("2026-06-10", "14:00", TZ);
    expect(r.utcIso).toBe("2026-06-10T18:00:00.000Z");
    expect(r.localTime).toBe("14:00");
  });

  it("winter (EST) morning round-trips and stores at -5", () => {
    const r = roundTrip("2026-01-15", "09:00", TZ);
    expect(r.utcIso).toBe("2026-01-15T14:00:00.000Z");
    expect(r.localTime).toBe("09:00");
  });

  it("a normal full local day spans exactly 24 hours", () => {
    const start = utcInstantFromLocal("2026-06-10", "00:00", TZ);
    const end = utcInstantFromLocal("2026-06-11", "00:00", TZ);
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(24);
  });

  it("UTC zone is a no-op passthrough", () => {
    const r = roundTrip("2026-06-10", "07:45", "UTC");
    expect(r.utcIso).toBe("2026-06-10T07:45:00.000Z");
    expect(r.localTime).toBe("07:45");
  });
});

describe("utcInstantFromLocal: Toronto fall-back day 2026-11-01 (documented conventions)", () => {
  it("ambiguous 01:30 resolves to the FIRST (pre-transition, EDT) occurrence, unchanged from pre-fix behavior", () => {
    const r = roundTrip("2026-11-01", "01:30", TZ);
    expect(r.utcIso).toBe("2026-11-01T05:30:00.000Z");
    expect(r.localDate).toBe("2026-11-01");
    expect(r.localTime).toBe("01:30");
  });

  it("00:30 before the transition is unambiguous and round-trips", () => {
    const r = roundTrip("2026-11-01", "00:30", TZ);
    expect(r.utcIso).toBe("2026-11-01T04:30:00.000Z");
    expect(r.localTime).toBe("00:30");
  });

  it("03:00 after the transition is unambiguous and round-trips", () => {
    const r = roundTrip("2026-11-01", "03:00", TZ);
    expect(r.utcIso).toBe("2026-11-01T08:00:00.000Z");
    expect(r.localTime).toBe("03:00");
  });

  it("the fall-back full local day spans 25 hours", () => {
    const start = utcInstantFromLocal("2026-11-01", "00:00", TZ);
    const end = utcInstantFromLocal("2026-11-02", "00:00", TZ);
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(25);
  });
});

describe("utcInstantFromLocal: spring-forward nonexistent gap (documented convention)", () => {
  it("02:30 does not exist locally on 2026-03-08; it maps one hour before the wall-clock string", () => {
    // No convention can round-trip a wall time that never occurs. The
    // two-pass algorithm settles on the pre-transition offset sampled
    // at the corrected instant, which lands the instant at local
    // 01:30 EST (06:30Z). The pre-fix single-pass mapped it forward
    // to 03:30 EDT (07:30Z); neither renders back as 02:30. Pinned so
    // a future change to gap handling is a conscious decision.
    const r = roundTrip("2026-03-08", "02:30", TZ);
    expect(r.utcIso).toBe("2026-03-08T06:30:00.000Z");
    expect(r.localTime).toBe("01:30");
  });
});

describe("PR #184 boundaries", () => {
  it("tz.ts stays zero-dependency (no date library imports)", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const src = readFileSync(
      path.resolve(__dirname, "../../../lib/booking/tz.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/from "(date-fns|dayjs|luxon|moment|@js-joda)/);
    expect(src).not.toMatch(/require\(/);
  });
});
