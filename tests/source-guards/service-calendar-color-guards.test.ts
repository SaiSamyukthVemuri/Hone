import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const code = (rel: string) =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const ACTIONS = "app/(app)/settings/services/actions.ts";
const COLORS = "lib/calendar/service-colors.ts";

describe("service calendar color — settings server contract", () => {
  const src = code(ACTIONS);
  it("validates the color against the allowlist (isServiceColorKey), rejecting invalid/rose/red", () => {
    expect(src).toMatch(/import \{ isServiceColorKey \} from "@\/lib\/calendar\/service-colors"/);
    expect(src).toMatch(/if \(!isServiceColorKey\(v\)\)/);
    expect(src).toMatch(/throw new Error\("Please choose a valid calendar color\."\)/);
  });
  it("persists calendar_color on both create and update (validated), update scoped to the authed studio", () => {
    expect((src.match(/const calendar_color = parseCalendarColor\(formData\.get\("calendar_color"\)\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(src).toMatch(/\.insert\(\{ \.\.\.base, calendar_color \}\)/);
    expect(src).toMatch(/\.update\(\{ \.\.\.update, calendar_color \}\)/);
    expect(src).toMatch(/\.eq\("id", id\)/);
    expect(src).toMatch(/\.eq\("studio_id", studioId\)/);
    expect(src).toMatch(/assertOwner\(\)/); // owner-only
    // migration-order write fallback (retry without calendar_color when absent).
    expect(src).toMatch(/isMissingColumnError\(error, "calendar_color"\)/);
  });
  it("does NOT infer color from name, duration, or client history", () => {
    expect(src).not.toMatch(/\.name.*includes|includes\("consult"\)/i);
    expect(src).not.toMatch(/duration.*color|color.*duration/i);
  });
});

describe("service calendar color — canonical mapping is the authority", () => {
  it("the color module never emits rose/red and hashing is no longer the view authority", () => {
    const m = read(COLORS);
    expect(m).toMatch(/export function appointmentCardClasses/);
    expect(m).not.toMatch(/rose-|red-/);
  });
  it("no view imports serviceCardClasses as its normal path (uses appointmentCardClasses)", () => {
    for (const v of ["DayColumn", "MonthView", "MobileDayTimeline"]) {
      const src = read(`app/(app)/calendar/${v}.tsx`);
      expect(src, `${v} uses appointmentCardClasses`).toMatch(/appointmentCardClasses/);
      expect(src).not.toMatch(/serviceCardClasses/);
    }
  });
});
