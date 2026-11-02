import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { CLOCK_FALLBACK_NOTICE, isUsableTimeZone } from "@/lib/desk/time";
import { ClockFallbackNotice } from "@/app/(desk)/desk/ClockFallbackNotice";

// Privacy D-1: a missing or unusable studio zone must not silently show UTC as the studio's clock.
const src = (p: string) => readFileSync(p, "utf8");

describe("isUsableTimeZone", () => {
  it("accepts real IANA zones and refuses empty, missing and malformed values", () => {
    expect(isUsableTimeZone("America/Toronto")).toBe(true);
    expect(isUsableTimeZone("UTC")).toBe(true);
    for (const bad of ["", null, undefined, "Not/AZone", "  "]) expect(isUsableTimeZone(bad as string)).toBe(false);
  });
});

describe("ClockFallbackNotice", () => {
  it("renders nothing for usable zones and a visible status for any unusable one", () => {
    expect(ClockFallbackNotice({ timezones: ["America/Toronto", "UTC"] })).toBeNull();
    expect(ClockFallbackNotice({ timezones: [] })).toBeNull();
    const el = ClockFallbackNotice({ timezones: ["America/Toronto", "Not/AZone"] }) as unknown as { props: { role: string; children: string } };
    expect(el.props.role).toBe("status");
    expect(el.props.children).toBe(CLOCK_FALLBACK_NOTICE);
    expect(CLOCK_FALLBACK_NOTICE).toMatch(/UTC/);
  });
});

describe("the desk shows the notice and never defaults the zone to UTC silently", () => {
  it("the read does not default a missing zone to \"UTC\"", () => {
    expect(src("lib/desk/read.ts")).not.toMatch(/studio_timezone\)\s*\?\?\s*"UTC"/);
  });
  it("schedule, directory and booking pages render the notice", () => {
    expect(src("app/(desk)/desk/page.tsx")).toMatch(/<ClockFallbackNotice/);
    expect(src("app/(desk)/desk/clients/DeskDirectory.tsx")).toMatch(/<ClockFallbackNotice/);
    expect(src("app/(desk)/desk/book/page.tsx")).toMatch(/<ClockFallbackNotice/);
    expect(src("app/(desk)/desk/page.tsx")).not.toMatch(/studioTimezone \?\? "UTC"/);
  });
});
