import { describe, expect, it } from "vitest";
import {
  serviceColorClasses,
  appointmentCardClasses,
  isServiceColorKey,
  SERVICE_COLOR_KEYS,
} from "@/lib/calendar/service-colors";

// Calendar color represents the booked SERVICE explicitly (0153 persisted
// calendar_color), never a hash of id/duration/client history.

describe("service colors — explicit persisted color contract", () => {
  it("maps each allowed key to a distinct trusted bundle; rose/red never appears", () => {
    expect([...SERVICE_COLOR_KEYS]).toEqual([
      "amber",
      "emerald",
      "teal",
      "sky",
      "indigo",
      "violet",
    ]);
    const bundles = SERVICE_COLOR_KEYS.map((k) => serviceColorClasses(k));
    expect(new Set(bundles).size).toBe(SERVICE_COLOR_KEYS.length); // all distinct
    for (const b of bundles) expect(b).not.toMatch(/rose|red/);
    expect(serviceColorClasses("violet")).toMatch(/violet/);
    expect(serviceColorClasses("emerald")).toMatch(/emerald/);
  });

  it("rejects invalid keys AND rose/red -> neutral fallback (never a color, never CSS)", () => {
    for (const bad of ["rose", "red", "pink", "purple", "bg-red-500", "", "VIOLET ", "amber "]) {
      const cls = serviceColorClasses(bad);
      expect(cls, `${bad} must be neutral`).toMatch(/neutral/);
      expect(cls).not.toMatch(/rose|red/);
    }
    expect(serviceColorClasses(null)).toMatch(/neutral/);
    expect(serviceColorClasses(undefined)).toMatch(/neutral/);
    expect(isServiceColorKey("rose")).toBe(false);
    expect(isServiceColorKey("red")).toBe(false);
    expect(isServiceColorKey("violet")).toBe(true);
  });

  it("color is the SERVICE's key — equal durations can differ; one service stays stable across durations", () => {
    // 1 & 2: consultation violet, existing-service emerald, both booked at 45 min.
    const consult45 = appointmentCardClasses({ id: "svc-consult", name: "Consultation", calendar_color: "violet" });
    const existing45 = appointmentCardClasses({ id: "svc-existing", name: "Electrolysis follow-up", calendar_color: "emerald" });
    expect(consult45).toMatch(/violet/);
    expect(existing45).toMatch(/emerald/);
    // 3: equal duration (45) -> different colors (not duration-driven).
    expect(consult45).not.toBe(existing45);
    // 4: same service, its color does not change with duration (color depends ONLY
    // on calendar_color; there is no duration input to this function).
    expect(appointmentCardClasses({ id: "svc-consult", name: "Consultation", calendar_color: "violet" })).toBe(consult45);
  });

  it("5: all three calendar views share one canonical mapping (identical bundle for a given service)", () => {
    const svc = { id: "s1", name: "X", calendar_color: "sky" };
    // The single helper every view calls -> deterministic, so week/day, month, and
    // mobile agree for the same service.
    expect(appointmentCardClasses(svc)).toBe(appointmentCardClasses({ ...svc }));
    expect(appointmentCardClasses(svc)).toBe(serviceColorClasses("sky"));
  });

  it("10: missing/deleted service -> neutral; pre-migration (no calendar_color) -> temporary legacy color, not blank", () => {
    expect(appointmentCardClasses(null)).toMatch(/neutral/);
    expect(appointmentCardClasses(undefined)).toMatch(/neutral/);
    // service present but persisted color not yet available (undefined) -> a real
    // (non-neutral) color from the temporary migration-window fallback.
    const legacy = appointmentCardClasses({ id: "svc-x", name: "Legacy" });
    expect(legacy).not.toMatch(/neutral/);
    expect(legacy).toMatch(/amber|emerald|teal|sky|indigo|violet/);
    // present-but-invalid persisted value -> neutral (not the hash).
    expect(appointmentCardClasses({ id: "svc-x", name: "Legacy", calendar_color: "rose" })).toMatch(/neutral/);
  });
});
