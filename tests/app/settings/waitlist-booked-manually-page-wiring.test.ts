import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The page reads and renders "Booked manually" only behind its own flag, and the row control is withheld from finished entries.
const src = readFileSync("app/(app)/settings/waitlist/page.tsx", "utf8");
describe("waitlist page wiring for Booked manually", () => {
  it("reads the appointments only when the flag is on", () => {
    expect(src).toMatch(/const bookedManuallyOn = waitlistBookedManuallyEnabled\(\);\s*const manualChoices = bookedManuallyOn\s*\?\s*await loadManualBookingChoices/);
    expect(src).toMatch(/:\s*null;\s*const bookedManualNotice = bookedManuallyOn \?/);
  });
  it("excludes converted and removed entries from the read and from the row control", () => {
    expect(src).toMatch(/r\.status !== "converted" && r\.status !== "removed"/);
    expect(src).toMatch(/manualChoices !== null && row\.status !== "converted" && row\.status !== "removed"/);
  });
  it("the card gets the same choices", () => {
    expect(src).toContain("manualChoices={manualChoices}");
  });
});
