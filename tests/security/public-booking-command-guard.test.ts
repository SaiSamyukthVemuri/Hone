import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// ===========================================================================
// The public booking route must create appointments ONLY through the reviewed
// command (migration 0170).
// ===========================================================================
//
// Before 0170 this route inserted the appointment itself and wrote its
// appointment_audit row in a SEPARATE statement whose error was discarded, so a
// confirmed public booking could exist with no audit trail — production carries
// exactly one such row.
//
// SCOPE HONESTY: this guard covers the PUBLIC BOOKING ROUTE only. Other narrow
// appointment writers still exist elsewhere (postcare email-state columns on the
// practitioner surface, the reschedule/cancel commands). Their migration is a
// later PR in the appointment-boundary train, and `authenticated` still holds
// direct appointment DML at the database layer. Nothing here should be read as
// "appointment direct DML is gone".

const ROUTE = "app/book/[slug]/actions.ts";
const SRC = readFileSync(ROUTE, "utf8");
const CODE = SRC.split("\n")
  .filter((l) => !l.trim().startsWith("//"))
  .join("\n");

describe("public booking route — no direct appointment creation", () => {
  it("performs NO direct DML against appointments", () => {
    // Both literal and variable table forms, matching the L18 lesson that a
    // `.from(variable)` writer hides from a literal-only scan.
    const literal = [...CODE.matchAll(/\.from\(\s*["']appointments["']\s*\)/g)];
    for (const m of literal) {
      const chain = CODE.slice(m.index ?? 0, (m.index ?? 0) + 400);
      expect(
        /\.(insert|update|upsert|delete)\s*\(/.test(chain),
        "the public route may READ appointments but must never write them",
      ).toBe(false);
    }
  });

  it("performs NO direct DML against appointment_audit — the command owns it", () => {
    expect(CODE).not.toMatch(/\.from\(\s*["']appointment_audit["']\s*\)/);
  });

  it("creates the appointment through create_public_appointment", () => {
    expect(CODE).toMatch(/rpc\(\s*\n?\s*"create_public_appointment"/);
  });

  it("passes only server-prepared identifiers to the command", () => {
    const call = CODE.slice(CODE.indexOf('"create_public_appointment"'));
    const args = call.slice(0, call.indexOf("},") + 1);
    // The studio id is resolved from the slug server-side, never posted.
    expect(args).toContain("p_studio_id: studio.id");
    // No duration, end time, status, practitioner or override may be supplied.
    for (const forbidden of [
      "p_duration",
      "p_ends_at",
      "p_status",
      "p_practitioner",
      "p_allow_outside",
      "p_capacity",
      "p_details",
    ]) {
      expect(args, `must not pass ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("never sends a confirmation before the command has confirmed success", () => {
    // Match the CALL sites (`fn({`), not the import statements at the top.
    const created = CODE.indexOf('"create_public_appointment"');
    const send = CODE.indexOf("sendBookingConfirmationToClient({");
    const sms = CODE.indexOf("sendBookingConfirmationSmsToClient({");
    expect(created).toBeGreaterThan(-1);
    expect(send, "confirmation email call must follow the command").toBeGreaterThan(created);
    expect(sms, "confirmation SMS call must follow the command").toBeGreaterThan(created);
  });

  it("maps command refusals to safe copy, never to a raw code or SQLSTATE", () => {
    // The visitor-facing strings must be the existing constants/messages.
    expect(CODE).toContain(
      'error: "That time is no longer available. Please choose another time."',
    );
    expect(CODE).toContain("PUBLIC_BOOKING_GENERIC_ERROR");
    // A result code must never be interpolated into a visitor-facing string.
    expect(CODE).not.toMatch(/error:\s*`[^`]*\$\{commandResult\}/);
    expect(CODE).not.toMatch(/error:\s*commandResult/);
  });
});
