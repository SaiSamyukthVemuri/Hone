import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ===========================================================================
// Chloe Session 1A, clinical-note actions must never leak database detail.
// ===========================================================================
//
// THE DEFECT. `insertClinicalNote` RETURNED `error.message` inside its result
// object. Because the value is RETURNED rather than THROWN, Next.js server-
// action error redaction never applies to it, and ClinicalNotesSection renders
// `state.message` verbatim. An RLS denial or a constraint violation would print
// table names, policy names, constraint names and, in a constraint detail
// row values, straight onto the practitioner's screen.
//
// Three call sites leaked: the client lookup, the INSERT, and the read-back
// verification. All three now return fixed copy and log a safe classification.

const ROOT = join(__dirname, "..", "..", "..");
const ACTIONS = readFileSync(
  join(ROOT, "app", "(app)", "clients", "[id]", "clinical-notes-actions.ts"),
  "utf8",
);
const SECTION = readFileSync(
  join(ROOT, "components", "clinical-notes-section.tsx"),
  "utf8",
);

/** Executable source only: a comment describing a banned pattern is not it. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");
}

const CODE = code(ACTIONS);

describe("clinical-note actions return fixed, practitioner-safe copy", () => {
  it("no raw database message is ever returned", () => {
    // The exact leak shapes that existed: `${error.message}` interpolated into
    // the returned string, and a bare `error: err.message`.
    expect(CODE).not.toMatch(/error\.message/);
    expect(CODE).not.toMatch(/Err\.message/);
    expect(CODE).not.toMatch(/\$\{[^}]*\.message\}/);
  });

  it("every failure path returns one of the reviewed fixed strings", () => {
    for (const copy of [
      "We couldn't save this clinical note. Please try again.",
      "Saved note could not be confirmed. Please reload and check before re-entering.",
      "We couldn't open this client's record. Please reload and try again.",
    ]) {
      expect(ACTIONS, `missing fixed copy: ${copy}`).toContain(copy);
    }
  });

  it("the distinct stale-revision message is RETAINED", () => {
    // It discloses no internal detail and is the one case where the
    // practitioner needs a specific, actionable instruction.
    expect(ACTIONS).toContain("stale_revision");
    expect(ACTIONS).toMatch(/already revised elsewhere/i);
  });

  it("validation and not-found copy is retained (it discloses nothing internal)", () => {
    expect(ACTIONS).toContain("Note text is required.");
    expect(ACTIONS).toContain("Client not found.");
    expect(ACTIONS).toContain("Unknown note type.");
  });

  it("no SQL/schema vocabulary can reach the returned copy", () => {
    // Scan every string literal that is RETURNED as an `error:` value.
    const returned = [...CODE.matchAll(/error:\s*("(?:[^"\\]|\\.)*")/g)].map(
      (m) => m[1],
    );
    expect(returned.length).toBeGreaterThan(0);
    for (const lit of returned) {
      for (const banned of [
        "row-level security",
        "policy",
        "constraint",
        "violates",
        "relation",
        "column",
        "duplicate key",
        "client_clinical_notes",
        "SQLSTATE",
      ]) {
        expect(
          lit.toLowerCase().includes(banned.toLowerCase()),
          `returned copy leaks "${banned}": ${lit}`,
        ).toBe(false);
      }
    }
  });
});

describe("operator logging is a safe classification, never PHI", () => {
  it("logs the event, a safe code, the note kind and the owning ids", () => {
    expect(CODE).toContain("logNoteFailure");
    for (const field of [
      "code",
      "kind",
      "clientId",
      "studioId",
      "practitionerId",
      "isRevision",
    ]) {
      expect(CODE, `logger should carry ${field}`).toContain(field);
    }
  });

  it("covers all three previously-leaking paths", () => {
    for (const event of [
      "clinical_note_client_lookup_failed",
      "clinical_note_insert_failed",
      "clinical_note_readback_failed",
    ]) {
      expect(CODE, `missing log event ${event}`).toContain(event);
    }
  });

  it("never logs the note body, the areas, or the raw database message", () => {
    // Bound the slice to the function itself: from its declaration to the next
    // top-level `function` keyword. (An earlier version sliced to a COMMENT
    // marker that `code()` had already stripped, so indexOf returned -1 and the
    // slice silently captured the whole rest of the file, a guard that would
    // have failed for the wrong reason.)
    const start = CODE.indexOf("function logNoteFailure");
    expect(start).toBeGreaterThan(-1);
    const after = CODE.indexOf("\nasync function", start);
    const logFn = CODE.slice(start, after > start ? after : start + 900);
    expect(logFn).toContain("logNoteFailure");
    expect(logFn.length).toBeLessThan(1200);
    for (const banned of ["body", "areas", "message", "occurredAt"]) {
      expect(
        logFn.includes(banned),
        `logNoteFailure must not carry ${banned}`,
      ).toBe(false);
    }
  });

  it("the call sites pass no note content either", () => {
    // Only the CALL sites (`logNoteFailure("event", { ... })`), not the
    // declaration, a non-greedy match from the declaration would run past it.
    const calls = [...CODE.matchAll(/logNoteFailure\(\s*"[a-z_]+",[\s\S]*?\}\);/g)];
    expect(calls.length).toBe(3);
    for (const m of calls) {
      expect(m[0]).not.toMatch(/\bbody\b/);
      expect(m[0]).not.toMatch(/\bareas\b/);
      expect(m[0]).not.toMatch(/\.message/);
    }
  });
});

describe("the renderer is the reason this matters", () => {
  it("ClinicalNotesSection still renders the message verbatim", () => {
    // Not a defect in itself, it is WHY the action must be the fixed-copy
    // boundary. If this ever stopped being true the guard above still holds,
    // but this documents the coupling.
    expect(SECTION).toMatch(/\{state\.message\}/);
  });
});
