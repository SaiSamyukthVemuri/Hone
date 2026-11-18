import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 0313 flag guards. ADDED beside the existing redeem-first guards; none of those
// is reworded. They pin that the new path is reachable only behind the flag, that
// the old path is still what runs without it, and that the flag fails closed.

const ROOT = join(__dirname, "..", "..", "..");
const SRC = readFileSync(join(ROOT, "app/book/[slug]/actions.ts"), "utf8");
const FLAG = readFileSync(join(ROOT, "lib/booking/waitlist-booking-command.ts"), "utf8");
const strip = (s: string) => s.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
const code = strip(SRC);

describe("0313 flag", () => {
  it("is off unless the env value is exactly 1", () => {
    expect(strip(FLAG)).toMatch(/process\.env\.WAITLIST_BOOKING_COMMAND === "1"/);
  });

  it("the new command is reached only through the flag-gated binding", () => {
    expect(code.match(/redeem_and_book_waitlist_invitation/g)).toHaveLength(1);
    expect(code).toMatch(/const invitedCommand =\s*invitationAuth\?\.kind === "authorized" && waitlistBookingCommandEnabled\(\)/);
    expect(code).toMatch(/invitedCommand\s*\?\s*await admin\.rpc\("redeem_and_book_waitlist_invitation"/);
  });

  it("the redeem-first path still runs when the flag is off", () => {
    expect(code).toMatch(/if \(invitationAuth\?\.kind === "authorized" && !invitedCommand\) \{\s*const redeemed = await consumeInvitationForBooking\(/);
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
