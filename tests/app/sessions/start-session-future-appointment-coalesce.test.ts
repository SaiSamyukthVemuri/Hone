import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// ===========================================================================
// A FUTURE APPOINTMENT MUST NOT ADOPT ANOTHER APPOINTMENT'S SESSION
// ===========================================================================
//
// `start_session` coalesces on (studio, client, PRACTITIONER, modality) within
// `p_coalesce_minutes` — it never keys on the appointment. For the visit
// happening now that is correct: two entries for one visit are one session.
//
// The dashboard now offers "Chart session" on an UPCOMING row, and for an
// appointment that has not happened the same window is wrong two ways:
//
//   (a) a recent session with a NULL appointment is silently RE-POINTED to the
//       future appointment — the command promotes a null link;
//   (b) a session belonging to a DIFFERENT appointment is reused as-is, so the
//       practitioner edits the wrong session AND the upcoming appointment is
//       left with none.
//
// An independent review raised (b) as a P1 against the new CTA.
//
// SCOPE IS DELIBERATE. The same reuse can occur between two PAST appointments
// less than 90 minutes apart. That is pre-existing, shipped behaviour and is
// NOT changed here — widening it would alter the completed-appointment and
// calendar-timeline flows. These assertions pin the narrow rule so a later
// edit cannot quietly widen OR drop it.
// ===========================================================================

const ROOT = path.resolve(__dirname, "../../..");
const SRC = readFileSync(
  path.join(ROOT, "app/(app)/clients/[id]/sessions/new/actions.ts"),
  "utf8",
);
/** Comment-stripped: prose must not satisfy any assertion below. */
const CODE = SRC.replace(/\/\/.*$/gm, " ").replace(/\/\*[\s\S]*?\*\//g, " ");

describe("the visit window is suppressed for a FUTURE appointment", () => {
  it("decides the window instead of always passing the constant", () => {
    expect(CODE).toMatch(/let\s+coalesceMinutes\s*=\s*COALESCE_MINUTES/);
    expect(CODE).toMatch(/coalesceMinutes\s*=\s*0/);
  });

  it("gates that decision on the appointment being in the FUTURE", () => {
    expect(CODE).toMatch(/endsAtMs\s*>\s*Date\.now\(\)/);
    // Past and unlinked starts keep the shipped behaviour.
    expect(CODE).toMatch(/COALESCE_MINUTES\s*=\s*90/);
  });

  it("reuses a session ALREADY linked to THIS appointment, preserving idempotency", () => {
    // Without this the fix would trade cross-appointment capture for a
    // duplicate session on every second click.
    expect(CODE).toMatch(/\.eq\("appointment_id",\s*appointmentId\)/);
    expect(CODE).toMatch(/\.is\("deleted_at",\s*null\)/);
    expect(CODE).toMatch(/redirect\(`\/clients\/\$\{clientId\}\/sessions\/\$\{existing\[0\]!\.id\}`\)/);
  });

  it("applies the SAME window to the reverse-skew fallback call", () => {
    // Two rpc("start_session") call sites exist for old/new database skew. A
    // fallback still passing the constant would reopen the hole on an old DB.
    const calls = CODE.match(/p_coalesce_minutes:\s*\w+/g) ?? [];
    expect(calls.length).toBe(2);
    for (const c of calls) expect(c).toMatch(/p_coalesce_minutes:\s*coalesceMinutes/);
  });

  it("the appointment-scoped lookup happens BEFORE the session is started", () => {
    const lookup = CODE.search(/\.eq\("appointment_id",\s*appointmentId\)/);
    const start = CODE.search(/rpc\("start_session"/);
    expect(lookup).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(-1);
    expect(lookup).toBeLessThan(start);
  });

  it("does NOT widen to past appointments, and adds no migration-shaped change", () => {
    // The correct universal fix is in the RPC predicate (appointment_id is null
    // or = p_appointment_id). That needs a migration and is out of scope here;
    // if one is ever written, this assertion should be replaced by it.
    expect(CODE).not.toMatch(/p_coalesce_minutes:\s*0\b/);
    expect(CODE).toMatch(/appointmentId\s*&&\s*appointmentEndsAt/);
  });
});
