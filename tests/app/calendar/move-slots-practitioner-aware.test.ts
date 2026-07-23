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
  it("both getAvailableSlots call sites pass the resolved slot target (current practitioner or reassignment target)", () => {
    // Selected on the appointment reads (now also service_id for eligibility).
    expect((MOVE.match(/duration_minutes, practitioner_id, service_id/g) ?? []).length).toBeGreaterThanOrEqual(1);
    // Item 7: both the loader + the recheck pass `slotTarget` — the proposed
    // reassignment target when set, otherwise the appointment's current practitioner.
    expect((MOVE.match(/slotTarget/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(MOVE).toMatch(/const slotTarget = target \?\? appt\.practitioner_id/);
  });
});
