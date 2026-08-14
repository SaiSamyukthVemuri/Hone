import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

// Desktop PR C-lite: clicking an appointment opens an in-context READ-ONLY
// preview drawer instead of navigating away. The full detail route is preserved
// and reached via the preview's "Open full details" link. Blocked-time + empty-
// slot interactions and the mobile #380 day view are unchanged.
function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}
const DAYCOL = read("app/(app)/calendar/DayColumn.tsx");
const PREVIEW = read("app/(app)/calendar/AppointmentPreviewDrawer.tsx");
const MOBILE = read("app/(app)/calendar/MobileDayTimeline.tsx");

describe("appointment card opens an in-context preview (not a navigation)", () => {
  it("the desktop card is a button that opens the preview, not a Link", () => {
    expect(DAYCOL).toMatch(/onClick=\{\(\) => setPreview\(a\)\}/);
    // no navigating <Link> around the appointment card anymore
    expect(DAYCOL).not.toMatch(/<Link[\s\S]{0,120}\/calendar\/\$\{a\.id\}/);
  });
  it("DayColumn renders the preview drawer with the appointment + returnTo + tz + timeFormat", () => {
    expect(DAYCOL).toMatch(/<AppointmentPreviewDrawer/);
    expect(DAYCOL).toMatch(/appointment=\{preview\}/);
    expect(DAYCOL).toMatch(/returnTo=\{returnTo\}/);
    expect(DAYCOL).toMatch(/studioTimezone=\{tz\}/);
    expect(DAYCOL).toMatch(/timeFormat=\{timeFormat\}/);
  });
});

describe("preview shows safe summary from existing data + the full-details link", () => {
  it("shows client, service, time range + duration, and status", () => {
    expect(PREVIEW).toMatch(/a\.client\?\.name/);
    expect(PREVIEW).toMatch(/a\.service\?\.name/);
    expect(PREVIEW).toMatch(/timeRangeLabel\(/);
    expect(PREVIEW).toMatch(/a\.duration_minutes/);
    expect(PREVIEW).toMatch(/appointmentDisplayStatus\(/);
  });
  it("respects the studio 12h/24h preference + timezone (never device-local)", () => {
    expect(PREVIEW).toMatch(/formatTimeForStudio\([^)]*timeFormat\)/);
    expect(PREVIEW).toMatch(/studioTimezone/);
    expect(PREVIEW).not.toMatch(/toLocaleTimeString|toLocaleString/);
  });
  it("includes an 'Open full details' deep link to /calendar/[id] with returnTo", () => {
    expect(PREVIEW).toMatch(/Open full details/);
    expect(PREVIEW).toMatch(/href=\{`\/calendar\/\$\{a\.id\}\$\{returnTo\}`\}/);
  });
  it("the full detail route still exists (not duplicated in the preview)", () => {
    expect(existsSync(path.resolve(__dirname, "../../../app/(app)/calendar/[id]/page.tsx"))).toBe(true);
    // sanity: the preview is small, not a copy of the 1394-line detail page
    expect(PREVIEW.split("\n").length).toBeLessThan(200);
  });
});

describe("preview is READ-ONLY (no mutation / payment / portal / intake)", () => {
  it("has no server actions and no forbidden action surfaces", () => {
    expect(PREVIEW).not.toMatch(/"use server"/);
    expect(PREVIEW).not.toMatch(
      /refund|charge|payment|portal|intake|consent|cancelAppointment|markComplete|noShow|deleteAppointment|updateAppointment/i,
    );
    // no form-submit / mutation buttons, only the read-only deep link + close
    expect(PREVIEW).not.toMatch(/<form|startTransition|\baction=\{/);
  });
});

describe("other interactions unchanged", () => {
  it("blocked-time click still opens the block edit drawer in-place", () => {
    expect(DAYCOL).toMatch(/onClick=\{\(\) => setEditingBlock\(tb\)\}/);
    expect(DAYCOL).toMatch(/<TimedBlockEditDrawer/);
  });
  it("empty-slot click still opens QuickBookDrawer (exact-time booking)", () => {
    expect(DAYCOL).toMatch(/<QuickBookDrawer/);
    expect(DAYCOL).toMatch(/openDraftAtY/);
  });
  it("the mobile #380 day view still navigates via its appointment Link (unchanged)", () => {
    expect(MOBILE).toMatch(/href=\{`\/calendar\/\$\{a\.id\}\$\{returnTo\}`\}/);
    expect(MOBILE).not.toMatch(/AppointmentPreviewDrawer/);
  });
});
