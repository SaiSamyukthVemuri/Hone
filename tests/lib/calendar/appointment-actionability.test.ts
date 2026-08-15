import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { isAppointmentCancelable } from "@/lib/calendar/appointment-actionability";

// The cancel/move visibility rule, which used to exist twice.
//
// These cases are the CONTRACT the detail page and the calendar preview drawer
// now share. NC3 ("show Cancel unconditionally") turns the terminal-state and
// past-appointment cases below red.

const NOW = Date.parse("2026-08-15T12:00:00.000Z");
const FUTURE = "2026-08-15T13:00:00.000Z";
const PAST = "2026-08-15T11:00:00.000Z";

describe("isAppointmentCancelable — status", () => {
  it("confirmed + future is the ONLY actionable combination", () => {
    expect(
      isAppointmentCancelable({ status: "confirmed", startsAt: FUTURE, nowMs: NOW }),
    ).toBe(true);
  });

  for (const status of ["cancelled", "completed", "no_show"]) {
    it(`${status} is never actionable, even in the future`, () => {
      expect(
        isAppointmentCancelable({ status, startsAt: FUTURE, nowMs: NOW }),
      ).toBe(false);
    });
  }

  it("an unknown status is refused rather than treated as confirmed", () => {
    expect(
      isAppointmentCancelable({ status: "pending_review", startsAt: FUTURE, nowMs: NOW }),
    ).toBe(false);
  });

  it("a null/undefined status is refused (fail closed)", () => {
    expect(
      isAppointmentCancelable({ status: null, startsAt: FUTURE, nowMs: NOW }),
    ).toBe(false);
    expect(
      isAppointmentCancelable({ status: undefined, startsAt: FUTURE, nowMs: NOW }),
    ).toBe(false);
  });
});

describe("isAppointmentCancelable — time", () => {
  it("a started appointment is not cancelable", () => {
    expect(
      isAppointmentCancelable({ status: "confirmed", startsAt: PAST, nowMs: NOW }),
    ).toBe(false);
  });

  it("EXACTLY at starts_at is not cancelable — the boundary is strict", () => {
    // Mirrors the SQL guard `if v_appt.starts_at <= now()`, which refuses the
    // instant itself. A `>=` here would offer a button the command refuses.
    expect(
      isAppointmentCancelable({
        status: "confirmed",
        startsAt: "2026-08-15T12:00:00.000Z",
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  it("one millisecond after now IS cancelable — proves the boundary is not just 'always false'", () => {
    expect(
      isAppointmentCancelable({
        status: "confirmed",
        startsAt: new Date(NOW + 1).toISOString(),
        nowMs: NOW,
      }),
    ).toBe(true);
  });

  it("an unparseable starts_at is refused, not NaN-compared into an accident", () => {
    // This is the case the two former copies disagreed about: the drawer's copy
    // lacked the finiteness guard and reached `false` only because NaN > x is
    // false. Pinned so a future rewrite cannot lose it silently.
    expect(
      isAppointmentCancelable({
        status: "confirmed",
        startsAt: "not-a-date",
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  it("a null/undefined starts_at is refused", () => {
    expect(
      isAppointmentCancelable({ status: "confirmed", startsAt: null, nowMs: NOW }),
    ).toBe(false);
    expect(
      isAppointmentCancelable({
        status: "confirmed",
        startsAt: undefined,
        nowMs: NOW,
      }),
    ).toBe(false);
  });
});

describe("both surfaces route through this one predicate", () => {
  function read(rel: string): string {
    return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
  }
  const DETAIL = read("app/(app)/calendar/[id]/page.tsx");
  const DRAWER = read("app/(app)/calendar/AppointmentPreviewDrawer.tsx");

  it("the detail page calls it and no longer inlines the rule", () => {
    expect(DETAIL).toMatch(/isAppointmentCancelable\(\{/);
    // The old inline expression must be gone, not merely unused.
    expect(DETAIL).not.toMatch(/Number\.isFinite\(startsAtMs\)/);
  });

  it("the drawer calls it and no longer inlines its own `canMove`", () => {
    expect(DRAWER).toMatch(/isAppointmentCancelable\(\{/);
    expect(DRAWER).not.toMatch(/const canMove\s*=/);
    expect(DRAWER).not.toMatch(
      /a\.status === "confirmed"\s*&&\s*new Date\(a\.starts_at\)/,
    );
  });

  it("the drawer gates on the SERVER-READ status, never the week payload's copy", () => {
    // `detail` is the lazily re-read row. Gating on `a.status` would let a
    // stale grid payload offer Cancel on an appointment already cancelled in
    // another tab.
    expect(DRAWER).toMatch(/status:\s*detail\.status/);
    expect(DRAWER).toMatch(/startsAt:\s*detail\.startsAt/);
  });
});
