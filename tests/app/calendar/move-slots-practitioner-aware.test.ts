import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR B Part 4 Item 2 — the move surface loads slots for the appointment's OWN
// practitioner (so A's appointment never removes B's slot).

const MOVE = readFileSync(
  join(process.cwd(), "app/(app)/calendar/move-appointment-actions.ts"),
  "utf8",
);

describe("move slots are practitioner-aware", () => {
  it("studioRow carries practitioner_capacity_enabled into getAvailableSlots", () => {
    expect(MOVE).toMatch(/practitioner_capacity_enabled\?: boolean/);
    expect(MOVE).toMatch(/practitioner_capacity_enabled: studio\.practitioner_capacity_enabled/);
  });
  it("both getAvailableSlots call sites pass the appointment's practitioner_id", () => {
    // Selected on the appointment reads.
    expect((MOVE.match(/duration_minutes, practitioner_id/g) ?? []).length).toBeGreaterThanOrEqual(1);
    // Passed as the explicit practitioner argument on BOTH the loader + the recheck.
    expect((MOVE.match(/appt\.practitioner_id,/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
