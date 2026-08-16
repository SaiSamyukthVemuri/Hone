import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  initialNotesCommit,
  reconcileWithProp,
  commitSavedNotes,
} from "@/app/(app)/calendar/notes-commit";

// WHAT THE PRACTITIONER SEES AFTER A SUCCESSFUL SAVE.
//
// A governed 0173 write returning ok IS the evidence that the note was saved.
// The editor must not need a second, fallible read to remember it.
//
// On the appointment detail page `notes` is a SERVER prop and router.refresh()
// updates it. In the calendar drawer it is a CLIENT-held copy that only changes
// when the drawer's lazy detail reload succeeds — and that reload can fail. When
// it did, the editor closed and re-rendered the PRE-SAVE text beside a
// load-error message, with the database already holding the new note. Reopening
// Edit then seeded the obsolete value, so the next save silently overwrote a
// change that had succeeded.
//
// This is the reconciliation, kept pure because this repo's vitest is
// environment: "node" — a rule living only inside a component is a rule no unit
// test can exercise.

const OLD = "Old note";
const NEW = "New note";

describe("a successful write is remembered locally, not re-fetched", () => {
  it("commits the submitted text", () => {
    const s = commitSavedNotes(initialNotesCommit(OLD), NEW);
    expect(s.committed).toBe(NEW);
  });

  it("SUCCESS + REFRESH FAILURE — a rerender with the unchanged stale prop does not revert", () => {
    // THE EXACT DEFECT. The save succeeded; the drawer's reload failed, so the
    // parent still passes the pre-save value while re-rendering for its error
    // state. That rerender must change nothing.
    const saved = commitSavedNotes(initialNotesCommit(OLD), NEW);
    const afterRerender = reconcileWithProp(saved, OLD);
    expect(afterRerender.committed).toBe(NEW);
    expect(afterRerender.committed).not.toBe(OLD);
  });

  it("survives REPEATED stale rerenders, not just the first", () => {
    // The parent may rerender many times while the error state persists.
    let s = commitSavedNotes(initialNotesCommit(OLD), NEW);
    for (let i = 0; i < 5; i += 1) s = reconcileWithProp(s, OLD);
    expect(s.committed).toBe(NEW);
  });

  it("CLEAR + REFRESH FAILURE — a successful clear is not undone by the stale prop", () => {
    // Leaving the field empty clears the notes. The old text must not reappear.
    const cleared = commitSavedNotes(initialNotesCommit(OLD), "");
    expect(cleared.committed).toBeNull();
    expect(reconcileWithProp(cleared, OLD).committed).toBeNull();
  });

  it("treats a whitespace-only submission as a clear, not as text", () => {
    expect(commitSavedNotes(initialNotesCommit(OLD), "   \n ").committed).toBeNull();
  });

  it("preserves the practitioner's exact text, inventing no normalization", () => {
    // The SQL command owns canonical storage normalization. For the window
    // before an authoritative read lands, showing exactly what was submitted is
    // the honest thing — and never a second business rule.
    const messy = "  spacing   kept\n\nand blank lines  ";
    expect(commitSavedNotes(initialNotesCommit(null), messy).committed).toBe(messy);
  });
});

describe("a genuinely NEW server value still wins", () => {
  it("LATER SERVER REFRESH — syncs when the prop actually changes (positive control)", () => {
    // Without this the component would ignore router.refresh() and the drawer's
    // successful reloads forever, which is the opposite failure.
    const saved = commitSavedNotes(initialNotesCommit(OLD), NEW);
    const synced = reconcileWithProp(saved, "Server canonical note");
    expect(synced.committed).toBe("Server canonical note");
  });

  it("syncs when the server later reports the same value it saved", () => {
    const saved = commitSavedNotes(initialNotesCommit(OLD), NEW);
    expect(reconcileWithProp(saved, NEW).committed).toBe(NEW);
  });

  it("syncs a server-side CLEAR", () => {
    const s = reconcileWithProp(initialNotesCommit(OLD), null);
    expect(s.committed).toBeNull();
  });

  it("a prop that has not changed is a no-op, returning the same object", () => {
    // Identity matters: the component sets state only when this differs, so an
    // unconditional new object would loop.
    const s = initialNotesCommit(OLD);
    expect(reconcileWithProp(s, OLD)).toBe(s);
  });
});

describe("the editor wires the rule, and a failed WRITE commits nothing", () => {
  const EDITOR = readFileSync(
    path.resolve(__dirname, "../../../app/(app)/calendar/AppointmentNotesEditor.tsx"),
    "utf8",
  );

  // Comments in this file legitimately NAME router.refresh() and onSaved while
  // explaining why the commit precedes them, so ordering is checked against
  // code only. Otherwise the guard measures prose.
  const codeOnly = (src: string) =>
    src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
  const EDITOR_CODE = codeOnly(EDITOR);

  it("commits BEFORE relying on either refresh mechanism", () => {
    const body = EDITOR_CODE.slice(
      EDITOR_CODE.indexOf("const res = await setAppointmentNotesAction"),
    );
    const commitAt = body.indexOf("commitSavedNotes(");
    const refreshAt = body.indexOf("router.refresh()");
    const savedAt = body.indexOf("onSaved?.()");
    expect(commitAt).toBeGreaterThan(-1);
    // A local commit that happened after the refresh calls would still be
    // correct today and fragile tomorrow; ordering states the intent.
    expect(commitAt).toBeLessThan(refreshAt);
    expect(commitAt).toBeLessThan(savedAt);
  });

  it("FAILED WRITE commits nothing — the early return precedes the commit", () => {
    // WRITE FAILURE is not WRITE SUCCESS + REFRESH FAILURE. Only the latter may
    // preserve a new local value.
    const body = EDITOR_CODE.slice(
      EDITOR_CODE.indexOf("const res = await setAppointmentNotesAction"),
    );
    expect(body.indexOf("if (!res.ok)")).toBeLessThan(body.indexOf("commitSavedNotes("));
    expect(body).toMatch(/if \(!res\.ok\) \{[\s\S]{0,120}return;/);
  });

  it("the closed view, the label and the Edit seed all read the COMMITTED value", () => {
    // Every surface that used the raw prop is what made the stale text visible
    // and re-submittable.
    expect(EDITOR).toMatch(/committedNotes \? "Edit" : "Add notes"/);
    expect(EDITOR).toMatch(/setDraft\(committedNotes \?\? ""\)/);
    expect(EDITOR).toMatch(/\{committedNotes\}/);
    // The raw prop must not be read by any of them any more.
    expect(EDITOR).not.toMatch(/setDraft\(notes \?\? ""\)/);
    expect(EDITOR).not.toMatch(/\{notes \? "Edit" : "Add notes"\}/);
  });

  it("synchronizes only on a genuinely changed prop, never every render", () => {
    expect(EDITOR).toMatch(/reconcileWithProp\(/);
  });
});
