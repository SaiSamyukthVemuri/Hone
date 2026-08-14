import { describe, expect, it } from "vitest";
import {
  computeEffectiveWeek,
  computeEffectiveOverrides,
  resolveScope,
  type ScopePractitioner,
} from "@/lib/booking/practitioner-availability";

// PR B Part 2: the server-side effective-schedule model (inheritance +
// precedence + scope resolution). Pure functions, no DB.

const day = (
  day_of_week: number,
  is_open: boolean,
  open_time: string | null = null,
  close_time: string | null = null,
  practitioner_id: string | null = null,
) =>
  ({
    id: `d${day_of_week}-${practitioner_id ?? "studio"}`,
    studio_id: "s1",
    day_of_week,
    is_open,
    open_time,
    close_time,
    practitioner_id,
    created_at: "",
    updated_at: "",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

const ov = (
  effective_date: string,
  is_open: boolean,
  open_time: string | null,
  close_time: string | null,
  practitioner_id: string | null = null,
) =>
  ({
    id: `o-${effective_date}-${practitioner_id ?? "studio"}`,
    studio_id: "s1",
    effective_date,
    is_open,
    open_time,
    close_time,
    note: null,
    practitioner_id,
    created_at: "",
    updated_at: "",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

describe("computeEffectiveWeek", () => {
  const studio = [
    day(1, true, "09:00:00", "17:00:00"),
    day(2, true, "09:00:00", "17:00:00"),
  ];

  it("studio scope: every day sources from studio_default, nothing custom", () => {
    const week = computeEffectiveWeek(studio, null);
    expect(week).toHaveLength(7);
    expect(week.every((d) => d.source === "studio_default")).toBe(true);
    expect(week.every((d) => d.hasCustom === false)).toBe(true);
    expect(week[1]).toMatchObject({ is_open: true, open_time: "09:00", close_time: "17:00" });
    expect(week[0]).toMatchObject({ is_open: false }); // no studio row for Sunday
  });

  it("practitioner row wins for its weekday; the rest inherit the studio default", () => {
    const week = computeEffectiveWeek(studio, [day(1, true, "11:00:00", "15:00:00", "P")]);
    expect(week[1]).toMatchObject({
      source: "practitioner",
      hasCustom: true,
      open_time: "11:00",
      close_time: "15:00",
    });
    // Tuesday has no practitioner row -> inherits studio default, not custom.
    expect(week[2]).toMatchObject({ source: "studio_default", hasCustom: false, open_time: "09:00" });
  });

  it("a practitioner CLOSED weekday overrides an open studio day", () => {
    const week = computeEffectiveWeek(studio, [day(1, false, null, null, "P")]);
    expect(week[1]).toMatchObject({ is_open: false, source: "practitioner", hasCustom: true });
  });
});

describe("computeEffectiveOverrides", () => {
  it("a practitioner date override wins over the studio date override for the same date", () => {
    const studioOverrides = [ov("2031-08-12", true, "10:00:00", "15:00:00")];
    const practitionerOverrides = [ov("2031-08-12", false, null, null, "P")];
    const eff = computeEffectiveOverrides(studioOverrides, practitionerOverrides);
    expect(eff).toHaveLength(1);
    expect(eff[0]).toMatchObject({
      effective_date: "2031-08-12",
      source: "practitioner_override",
      hasCustom: true,
      is_open: false,
    });
  });

  it("studio overrides with no practitioner override show as studio source", () => {
    const eff = computeEffectiveOverrides([ov("2031-08-12", true, "10:00:00", "15:00:00")], []);
    expect(eff[0]).toMatchObject({ source: "studio_override", hasCustom: false });
  });
});

describe("resolveScope (never trusts the URL id)", () => {
  const active: ScopePractitioner[] = [
    { id: "P1", display_name: "Maya", color: "rose", role: "practitioner" },
  ];
  it("a valid active practitioner id -> practitioner scope", () => {
    expect(resolveScope("P1", active)).toEqual({ kind: "practitioner", practitionerId: "P1" });
  });
  it("empty / unknown / cross-studio id -> studio scope (fails safe, no leak)", () => {
    expect(resolveScope(null, active)).toEqual({ kind: "studio", practitionerId: null });
    expect(resolveScope("not-a-real-id", active)).toEqual({ kind: "studio", practitionerId: null });
    expect(resolveScope("'; drop table", active)).toEqual({ kind: "studio", practitionerId: null });
  });
});
