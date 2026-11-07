import { describe, expect, it } from "vitest";
import {
  parseSelectedDay,
  selectedDayBounds,
  selectSessionsForDay,
  type SelectableSession,
} from "@/lib/records/print/selected-day";

const TZ = "America/Toronto";
const STUDIO = "studio-a";
const CLIENT = "client-1";

function s(id: string, startedAt: string, over: Partial<SelectableSession> = {}): SelectableSession {
  return { id, client_id: CLIENT, studio_id: STUDIO, started_at: startedAt, deleted_at: null, ...over };
}
const scope = (day: string, timezone = TZ) => ({ studioId: STUDIO, clientId: CLIENT, day, timezone });
const ids = (r: ReturnType<typeof selectSessionsForDay>) => (r.kind === "sessions" ? r.sessions.map((x) => x.id) : []);

describe("parseSelectedDay", () => {
  it("accepts a real calendar date", () => {
    expect(parseSelectedDay("2026-02-28")).toEqual({ ok: true, day: "2026-02-28" });
    expect(parseSelectedDay("2028-02-29")).toEqual({ ok: true, day: "2028-02-29" });
  });
  it("rejects missing, malformed and impossible dates", () => {
    expect(parseSelectedDay(undefined)).toEqual({ ok: false, reason: "missing" });
    expect(parseSelectedDay("")).toEqual({ ok: false, reason: "missing" });
    for (const bad of ["2026-2-3", "2026-02-30", "2026-13-01", "2027-02-29", "yesterday", "2026-02-28T00:00"]) {
      expect(parseSelectedDay(bad)).toEqual({ ok: false, reason: "invalid" });
    }
  });
});

describe("selectedDayBounds (studio-local day -> half-open UTC interval)", () => {
  it("an ordinary EDT day is 24h starting at 04:00Z", () => {
    expect(selectedDayBounds("2026-05-10", TZ)).toEqual({
      fromUtc: "2026-05-10T04:00:00.000Z",
      toUtcExclusive: "2026-05-11T04:00:00.000Z",
    });
  });
  it("spring-forward day is 23h (EST start, EDT end)", () => {
    const b = selectedDayBounds("2026-03-08", TZ)!;
    expect(b).toEqual({ fromUtc: "2026-03-08T05:00:00.000Z", toUtcExclusive: "2026-03-09T04:00:00.000Z" });
    expect((Date.parse(b.toUtcExclusive) - Date.parse(b.fromUtc)) / 3_600_000).toBe(23);
  });
  it("fall-back day is 25h (EDT start, EST end)", () => {
    const b = selectedDayBounds("2026-11-01", TZ)!;
    expect(b).toEqual({ fromUtc: "2026-11-01T04:00:00.000Z", toUtcExclusive: "2026-11-02T05:00:00.000Z" });
    expect((Date.parse(b.toUtcExclusive) - Date.parse(b.fromUtc)) / 3_600_000).toBe(25);
  });
  it("the same instant is a different local day in a different studio timezone", () => {
    expect(selectedDayBounds("2026-05-10", "Pacific/Auckland")?.fromUtc).toBe("2026-05-09T12:00:00.000Z");
  });
});

describe("zones that skip midnight (America/Santiago, 2026-09-06: 00:00 -> 01:00)", () => {
  const SCL = "America/Santiago";
  // 00:00 -04 on 6 Sep does not exist; the first real instant is 01:00 -03 = 04:00Z.
  it("the selected day starts at the first real instant, not an hour into the day before", () => {
    expect(selectedDayBounds("2026-09-06", SCL)).toEqual({
      fromUtc: "2026-09-06T04:00:00.000Z",
      toUtcExclusive: "2026-09-07T03:00:00.000Z",
    });
  });
  it("the day before ends at that same instant, so no instant is in both days or in neither", () => {
    expect(selectedDayBounds("2026-09-05", SCL)).toEqual({
      fromUtc: "2026-09-05T04:00:00.000Z",
      toUtcExclusive: "2026-09-06T04:00:00.000Z",
    });
  });
  it("a visit in the hour the old mapping stole belongs to the day before, and only to it", () => {
    const lateFifth = s("late-5th", "2026-09-06T03:30:00.000Z"); // 23:30 -04 on 5 Sep
    const firstSixth = s("first-6th", "2026-09-06T04:00:00.000Z"); // 01:00 -03 on 6 Sep
    const rows = [lateFifth, firstSixth];
    expect(ids(selectSessionsForDay(rows, scope("2026-09-05", SCL)))).toEqual(["late-5th"]);
    expect(ids(selectSessionsForDay(rows, scope("2026-09-06", SCL)))).toEqual(["first-6th"]);
  });
});

describe("unresolvable day or timezone is unavailable, never empty", () => {
  it("returns kind unavailable for an unknown timezone and for an impossible date", () => {
    const rows = [s("x", "2026-05-10T15:00:00.000Z")];
    expect(selectedDayBounds("2026-05-10", "Not/AZone")).toBeNull();
    expect(selectSessionsForDay(rows, scope("2026-05-10", "Not/AZone")).kind).toBe("unavailable");
    expect(selectSessionsForDay(rows, scope("2026-02-30")).kind).toBe("unavailable");
    expect(selectSessionsForDay(rows, scope("2026-05-10", "")).kind).toBe("unavailable");
  });
});

describe("selectSessionsForDay: midnight boundaries", () => {
  const day = "2026-05-10"; // [04:00Z, next 04:00Z) in Toronto
  it("includes the first instant of the local day and excludes the last instant of the previous one", () => {
    expect(ids(selectSessionsForDay([s("prev", "2026-05-10T03:59:59.999Z"), s("first", "2026-05-10T04:00:00.000Z")], scope(day)))).toEqual(["first"]);
  });
  it("includes the last instant of the local day and excludes the first instant of the next one", () => {
    expect(ids(selectSessionsForDay([s("last", "2026-05-11T03:59:59.999Z"), s("next", "2026-05-11T04:00:00.000Z")], scope(day)))).toEqual(["last"]);
  });
  it("a late-evening local visit is on its local date even though its UTC date is the next day", () => {
    const evening = s("evening", "2026-05-11T02:30:00.000Z"); // 22:30 on 10 May in Toronto
    expect(ids(selectSessionsForDay([evening], scope("2026-05-10")))).toEqual(["evening"]);
    expect(selectSessionsForDay([evening], scope("2026-05-11")).kind).toBe("empty");
  });
  it("DST days: 23h and 25h days keep their own sessions and no neighbour's", () => {
    const spring = [s("a", "2026-03-08T05:00:00.000Z"), s("b", "2026-03-09T03:59:59.000Z"), s("pre", "2026-03-08T04:59:59.000Z"), s("post", "2026-03-09T04:00:00.000Z")];
    expect(ids(selectSessionsForDay(spring, scope("2026-03-08")))).toEqual(["a", "b"]);
    const fall = [s("c", "2026-11-01T04:00:00.000Z"), s("d", "2026-11-02T04:59:59.000Z"), s("pre", "2026-11-01T03:59:59.000Z"), s("post", "2026-11-02T05:00:00.000Z")];
    expect(ids(selectSessionsForDay(fall, scope("2026-11-01")))).toEqual(["c", "d"]);
  });
});

describe("selectSessionsForDay: multiple sessions, scoping, empty day", () => {
  const day = "2026-05-10";
  it("returns every session that day, oldest first, with id as the stable tie-break", () => {
    const r = selectSessionsForDay(
      [s("z", "2026-05-10T18:00:00.000Z"), s("b", "2026-05-10T14:00:00.000Z"), s("a", "2026-05-10T14:00:00.000Z"), s("m", "2026-05-10T09:00:00.000Z")],
      scope(day),
    );
    expect(ids(r)).toEqual(["m", "a", "b", "z"]);
  });
  it("excludes other clients, other studios, soft-deleted sessions and adjacent dates", () => {
    const r = selectSessionsForDay(
      [
        s("mine", "2026-05-10T15:00:00.000Z"),
        s("other-client", "2026-05-10T15:00:00.000Z", { client_id: "client-2" }),
        s("other-studio", "2026-05-10T15:00:00.000Z", { studio_id: "studio-b" }),
        s("deleted", "2026-05-10T15:00:00.000Z", { deleted_at: "2026-05-11T00:00:00.000Z" }),
        s("day-before", "2026-05-09T15:00:00.000Z"),
        s("day-after", "2026-05-11T15:00:00.000Z"),
      ],
      scope(day),
    );
    expect(ids(r)).toEqual(["mine"]);
  });
  it("an empty day is an explicit empty value carrying the day and client, never a list", () => {
    const r = selectSessionsForDay([s("elsewhere", "2026-05-09T15:00:00.000Z"), s("other", "2026-05-10T15:00:00.000Z", { client_id: "client-2" })], scope(day));
    expect(r).toEqual({ kind: "empty", day, clientId: CLIENT });
    expect(selectSessionsForDay([], scope(day))).toEqual({ kind: "empty", day, clientId: CLIENT });
  });
  it("ignores an unparseable started_at rather than letting it through", () => {
    expect(selectSessionsForDay([s("bad", "not-a-date")], scope(day)).kind).toBe("empty");
  });
  it("preserves extra columns on the kept rows (selection reads only its own)", () => {
    const row = { ...s("x", "2026-05-10T15:00:00.000Z"), modality: "laser" };
    const r = selectSessionsForDay([row], scope(day));
    expect(r.kind === "sessions" && r.sessions[0].modality).toBe("laser");
  });
});
