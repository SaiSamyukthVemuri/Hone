import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 0313 flag guards. That the command runs only behind the flag, and redeem-first
// without it, is proved behaviourally in waitlist-command-no-write-before-proof.test.ts.
// These pin what that test does not: the flag is exactly "1", there is one
// redeem call site, and a missing command or an uncertain outcome fails closed.

const ROOT = join(__dirname, "..", "..", "..");
const SRC = readFileSync(join(ROOT, "app/book/[slug]/actions.ts"), "utf8");
const FLAG = readFileSync(join(ROOT, "lib/booking/waitlist-booking-command.ts"), "utf8");
const strip = (s: string) => s.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
const code = strip(SRC);

describe("0313 flag", () => {
  it("is off unless the env value is exactly 1", () => {
    expect(strip(FLAG)).toMatch(/process\.env\.WAITLIST_BOOKING_COMMAND === "1"/);
  });

  it("flag-on never redeems before the command: consume is only inside the flag-off block", () => {
    const calls = [...code.matchAll(/consumeInvitationForBooking\(/g)].length;
    expect(calls).toBe(1);
  });

  it("fails closed when the command is missing, and never falls back to redeem-first", () => {
    expect(code).toMatch(/rpcErr\.code === "PGRST202" \|\| rpcErr\.code === "42883"/);
    expect(code).toMatch(/waitlist_booking_command_missing/);
  });

  it("an uncertain outcome checks the database before it speaks and records a durable item", () => {
    expect(code).toMatch(/waitlist_invitation_booking_state/);
    expect(code).toMatch(/record_waitlist_invitation_followup/);
    expect(code).toMatch(/p_reason: "booking_outcome_unknown"/);
  });
});
