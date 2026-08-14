import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// ===========================================================================
// The public booking route must create appointments ONLY through the reviewed
// command (migration 0170).
// ===========================================================================
//
// Before 0170 this route inserted the appointment itself and wrote its
// appointment_audit row in a SEPARATE statement whose error was discarded, so a
// confirmed public booking could exist with no audit trail, production carries
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

describe("public booking route: no direct appointment creation", () => {
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

  it("performs NO direct DML against appointment_audit, the command owns it", () => {
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

describe("authoritative practitioner: no stale pre-command owner", () => {
  it("does NOT fetch a practitioner before the command", () => {
    // The pre-RPC "current active owner" lookup is gone. If it returns, an
    // ownership or activity change between the pre-fetch and the command's own
    // resolution would email and name the WRONG practitioner for an appointment
    // that committed to someone else.
    const beforeRpc = CODE.slice(0, CODE.indexOf('"create_public_appointment"'));
    expect(
      beforeRpc,
      "no practitioners lookup may precede the command",
    ).not.toMatch(/\.from\(\s*["']practitioners["']\s*\)/);
  });

  it("resolves the practitioner from the command's returned id, scoped to the studio", () => {
    expect(CODE).toMatch(/commandRow\?\.practitioner_id/);
    const after = CODE.slice(CODE.indexOf("assignedPractitionerId"));
    expect(after).toMatch(/\.from\(\s*["']practitioners["']\s*\)/);
    expect(after).toMatch(/\.eq\("id", assignedPractitionerId\)/);
    expect(after).toMatch(/\.eq\("studio_id", studio\.id\)/);
    // Must NOT re-derive "the current active owner" as a substitute.
    const lookup = after.slice(0, after.indexOf("maybeSingle()"));
    expect(lookup).not.toContain('.eq("role", "owner")');
    expect(lookup).not.toContain('.eq("active", true)');
  });

  it("every practitioner-specific side effect uses the authoritative record", () => {
    expect(CODE).toMatch(/practitionerId: assignedPractitionerId/);
    expect(CODE).toMatch(/practitionerEmail: assignedPractitioner\.email/);
    expect(CODE).toMatch(/assignedPractitioner\?\.email &&/);
    // No `owner` identifier survives as a value anywhere.
    const codeNoComments = CODE.split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(codeNoComments).not.toMatch(/\bowner\?\./);
    expect(codeNoComments).not.toMatch(/\bowner\.\w/);
  });

  it("a null or unresolved practitioner falls back to the studio name, not a stale record", () => {
    expect(CODE).toMatch(
      /assignedPractitioner\?\.display_name\?\.trim\(\)[\s\S]{0,80}studio\.name/,
    );
    // The metadata failure is logged with a PII-safe payload and does not throw.
    expect(CODE).toMatch(/public_booking_practitioner_lookup_failed/);
  });

  it("the client confirmation is NOT gated on the practitioner lookup succeeding", () => {
    // Losing the confirmation email loses the only copy of the raw cancellation
    // token, so it must not depend on any post-commit read.
    const conf = CODE.indexOf("if (studio.send_confirmation_emails)");
    expect(conf).toBeGreaterThan(-1);
    const guard = CODE.slice(conf, conf + 60);
    expect(guard).not.toContain("assignedPractitioner");
    expect(guard).not.toContain("created &&");
  });
});

describe("policy split: what the command does NOT enforce", () => {
  it("the new-client consultation restriction stays in the action, BEFORE the command", () => {
    // The command never receives client_type, and the consultation rule is a
    // public-flow product policy rather than an appointment-table lineage fact.
    // It must therefore run before the RPC and must not be claimed as a DB
    // guarantee.
    const gate = CODE.indexOf("isConsultationService");
    const rpc = CODE.indexOf('"create_public_appointment"');
    expect(gate, "the consultation gate must exist").toBeGreaterThan(-1);
    expect(gate, "and must precede the command").toBeLessThan(rpc);
  });

  it("does not pass client_type to the command", () => {
    const call = CODE.slice(CODE.indexOf('"create_public_appointment"'));
    const args = call.slice(0, call.indexOf("},") + 1);
    expect(args).not.toContain("client_type");
    expect(args).not.toContain("clientType");
  });
});

describe("the parity harness stays runnable on the CI Node version", () => {
  const PARITY = readFileSync("tests/db/public-booking-slot-parity.db.test.ts", "utf8");

  it("does not construct a full supabase-js client", () => {
    // `createClient` from @supabase/supabase-js builds a RealtimeClient in its
    // constructor, which needs a native WebSocket. CI runs Node 20, which has
    // none, so the whole suite died at import there ("0 test") while passing on
    // a newer local Node. PostgrestClient satisfies getAvailableSlots, adds no
    // dependency and opens no socket.
    expect(PARITY).not.toMatch(/^import \{[^}]*\bcreateClient\b[^}]*\} from "@supabase\/supabase-js"/m);
    expect(PARITY).toMatch(/import \{ PostgrestClient \} from "@supabase\/postgrest-js"/);
  });

  it("imports SupabaseClient as a TYPE only, so nothing is loaded at runtime", () => {
    const valueImport = /^import\s+(?!type\b)[^;]*from "@supabase\/supabase-js"/m;
    expect(PARITY).not.toMatch(valueImport);
  });
});
