import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Desktop PR C-lite: the in-context appointment preview drawer is READ-ONLY and
// formats times with the studio preference, never the device locale.
function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}
const PREVIEW = read("app/(app)/calendar/AppointmentPreviewDrawer.tsx");

describe("preview time formatting", () => {
  it("respects the studio 12h/24h preference + timezone (never device-local)", () => {
    expect(PREVIEW).toMatch(/formatTimeForStudio\([^)]*timeFormat\)/);
    expect(PREVIEW).toMatch(/studioTimezone/);
    expect(PREVIEW).not.toMatch(/toLocaleTimeString|toLocaleString/);
  });
});

describe("preview is READ-ONLY (no mutation / payment / portal / intake)", () => {
  it("has no server actions and no forbidden action surfaces", () => {
    expect(PREVIEW).not.toMatch(/"use server"/);
    expect(PREVIEW).not.toMatch(
      /refund|charge|payment|portal|intake|consent|cancelAppointment|markComplete|noShow|deleteAppointment|updateAppointment/i,
    );
    // no form-submit / mutation buttons — only the read-only deep link + close
    expect(PREVIEW).not.toMatch(/<form|startTransition|\baction=\{/);
  });
});
