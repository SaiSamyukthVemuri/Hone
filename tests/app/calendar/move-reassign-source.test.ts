import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR B Part 4 — the move action routes through the atomic move/reassign command
// (0143), not the legacy time-only RPC (0133) — no bypassable alternative.

const MOVE = readFileSync(
  join(process.cwd(), "app/(app)/calendar/move-appointment-actions.ts"),
  "utf8",
);

describe("move action — routes through move_or_reassign_appointment (0143)", () => {
  it("calls the new command and no longer calls the legacy time-only RPC", () => {
    expect(MOVE).toMatch(/\.rpc\("move_or_reassign_appointment"/);
    expect(MOVE).not.toMatch(/\.rpc\("practitioner_move_appointment"/);
  });
  it("passes an explicit actor + target (current practitioner for a time-only move)", () => {
    expect(MOVE).toMatch(/p_actor_practitioner_id: practitioner\.id/);
    expect(MOVE).toMatch(/p_target_practitioner_id: appt\.practitioner_id/);
  });
  it("maps the new result codes (booking_paused / eligibility) to safe copy", () => {
    for (const code of ["booking_paused", "invalid_practitioner", "not_eligible", "reassigned"]) {
      expect(MOVE).toContain(`"${code}"`);
    }
  });
});
