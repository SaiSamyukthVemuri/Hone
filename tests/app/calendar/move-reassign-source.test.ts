import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR B Part 4 — the arguments the move action hands the atomic move/reassign
// command (0143). That it calls that command is proved behaviourally in
// tests/lib/calendar/move-appointment-actions.test.ts.

const MOVE = readFileSync(
  join(process.cwd(), "app/(app)/calendar/move-appointment-actions.ts"),
  "utf8",
);

describe("move action — move_or_reassign_appointment (0143) arguments", () => {
  it("passes the actor + a server-resolved target (Item 7: NULL for time-only, a validated id for owner reassignment)", () => {
    expect(MOVE).toMatch(/p_actor_practitioner_id: practitioner\.id/);
    // Item 7: the action resolves `target` — NULL for a time-only move (member /
    // Legacy / owner keeping the same practitioner), or a re-validated eligible id
    // for an owner reassignment — and passes it. The command is the final authority.
    expect(MOVE).toMatch(/p_target_practitioner_id: target/);
    expect(MOVE).toMatch(/let target: string \| null = null/);
    // The target is only honoured for an owner, in either capacity mode (eligibility is a capacity-ON rule).
    expect(MOVE).toMatch(/const reassignEnabled = practitioner\.role === "owner";/);
    // A forged/ineligible target is rejected (re-validated against the eligible set).
    expect(MOVE).toMatch(/if \(!eligible\.some\(\(p\) => p\.id === requestedTarget\)\)/);
  });
  it("passes the owner outside-availability bypass ONLY for the owner-gated custom_time mode (0148)", () => {
    expect(MOVE).toMatch(/p_allow_outside_availability: mode === "custom_time"/);
  });
  it("maps the new result codes (booking_paused / eligibility) to safe copy", () => {
    for (const code of ["booking_paused", "invalid_practitioner", "not_eligible", "reassigned"]) {
      expect(MOVE).toContain(`"${code}"`);
    }
  });
});
