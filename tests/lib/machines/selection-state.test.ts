import { describe, expect, it } from "vitest";

import {
  FAILED_CLEAR_NOTE,
  FAILED_SET_NOTE,
  initialSelection,
  selectionRequested,
  selectionSettled,
  type SelectionState,
} from "@/lib/machines/selection-state";

// MPX-03 — the truth table for what the panel may CLAIM about a selection.
//
// The status line has been wrong twice, both times in a client component's
// state update, and this repository has no jsdom or testing-library in the
// unit stack (interaction is proved in Playwright, not here). So the rule was
// extracted into a pure function and this is its exhaustive table: the four
// outcomes crossed with set and clear, plus the no-persister case.
//
// THE TWO DEFECTS THIS WOULD HAVE CAUGHT, stated as the cases that fail
// without the current rule:
//
//   1. Reading the store's CAPABILITY instead of the stored fact - caught by
//      "a fresh panel with no server value remembers nothing", which the
//      capability-based version failed for every working database.
//
//   2. Reading the OPTIMISTIC selection instead of the stored fact - caught by
//      "a failed set leaves the stored fact alone" and "a failed clear still
//      reports the machine as remembered", both of which the selection-based
//      version failed.
//
// No fixture here corresponds to a real device; the ids are opaque labels.
const A = "device-a";
const B = "device-b";

/** Apply both steps the way the component does. */
function choose(
  prev: SelectionState,
  next: string | null,
  write: Parameters<typeof selectionSettled>[2],
): SelectionState {
  return selectionSettled(selectionRequested(prev, next), next, write);
}

describe("the first render reports the server's value, and nothing more", () => {
  it("a fresh panel with no server value remembers nothing", () => {
    // Defect 1 in one line: this said "yes" for every practitioner with a
    // working database, because it was reading whether a store EXISTED.
    expect(initialSelection(null)).toEqual({
      selected: null,
      persisted: null,
      note: null,
    });
  });

  it("a server-provided default is both selected and stored", () => {
    // It genuinely is the stored fact at first render - that is where it came
    // from - so seeding both is correct, not optimism.
    expect(initialSelection(A)).toEqual({ selected: A, persisted: A, note: null });
  });
});

describe("the optimistic step moves the selection and NOTHING else", () => {
  it("shows the new choice immediately while the stored fact stands still", () => {
    const s = selectionRequested(initialSelection(A), B);
    expect(s.selected).toBe(B);
    expect(s.persisted, "the write has not happened yet").toBe(A);
    expect(s.note).toBeNull();
  });

  it("clears a stale note, so an old failure is not shown against a new choice", () => {
    const failed = choose(initialSelection(A), B, { ok: false });
    expect(failed.note).not.toBeNull();
    expect(selectionRequested(failed, A).note).toBeNull();
  });
});

describe("an acknowledged SUCCESS is the only thing that moves the stored fact", () => {
  it("a successful set stores it", () => {
    expect(choose(initialSelection(null), A, { ok: true })).toEqual({
      selected: A,
      persisted: A,
      note: null,
    });
  });

  it("a successful clear un-stores it", () => {
    expect(choose(initialSelection(A), null, { ok: true })).toEqual({
      selected: null,
      persisted: null,
      note: null,
    });
  });

  it("a successful switch replaces it", () => {
    expect(choose(initialSelection(A), B, { ok: true })).toEqual({
      selected: B,
      persisted: B,
      note: null,
    });
  });
});

describe("a FAILED write leaves the stored fact exactly as it was", () => {
  it("a failed set keeps the selection but stores nothing", () => {
    // Defect 2, first half: this reported B as remembered.
    const s = choose(initialSelection(null), B, { ok: false });
    expect(s.selected, "the choice still applies to this block").toBe(B);
    expect(s.persisted, "but nothing was stored").toBeNull();
    expect(s.note).toBe(FAILED_SET_NOTE);
  });

  it("a failed CLEAR still reports the machine as remembered", () => {
    // Defect 2, second half, and the more dangerous one: the practitioner was
    // told nothing was remembered while the old default was still in place.
    const s = choose(initialSelection(A), null, { ok: false });
    expect(s.selected).toBeNull();
    expect(s.persisted, "the old default is still there").toBe(A);
    expect(s.note).toBe(FAILED_CLEAR_NOTE);
  });

  it("the failed-clear note SAYS it is still remembered, not that it could not be", () => {
    // Wording is the whole payload of this branch. "Could not be remembered"
    // is actively false after a failed clear.
    expect(FAILED_CLEAR_NOTE).toMatch(/still remembered/i);
    expect(FAILED_CLEAR_NOTE).not.toBe(FAILED_SET_NOTE);
  });

  it("a failed switch keeps the PREVIOUS machine stored, not the new one", () => {
    const s = choose(initialSelection(A), B, { ok: false });
    expect(s.selected).toBe(B);
    expect(s.persisted).toBe(A);
  });

  it("the server's own message is preferred over either default", () => {
    const s = choose(initialSelection(null), A, {
      ok: false,
      error: "That machine was retired.",
    });
    expect(s.note).toBe("That machine was retired.");
  });
});

describe("NO PERSISTER is not the same as a successful write", () => {
  it("the selection applies locally and claims nothing stored", () => {
    // The third costume of the same mistake: with no persister wired, setting
    // `persisted` would report a stored fact that no store holds.
    const s = choose(initialSelection(null), A, null);
    expect(s.selected).toBe(A);
    expect(s.persisted).toBeNull();
    expect(s.note, "there is no failure to report either").toBeNull();
  });

  it("a pre-existing server value is not erased by a local-only change", () => {
    const s = choose(initialSelection(A), B, null);
    expect(s.selected).toBe(B);
    expect(s.persisted).toBe(A);
  });
});

describe("the stored fact only ever changes through an acknowledged write", () => {
  it("across every outcome, `persisted` moves on ok:true and on nothing else", () => {
    // The table as a single invariant, so a new branch cannot quietly opt out.
    const starts: Array<string | null> = [null, A];
    const nexts: Array<string | null> = [null, A, B];
    const writes: Array<Parameters<typeof selectionSettled>[2]> = [
      { ok: true },
      { ok: false },
      { ok: false, error: "nope" },
      null,
    ];
    let acknowledged = 0;
    for (const start of starts) {
      for (const next of nexts) {
        for (const write of writes) {
          const before = initialSelection(start);
          const after = choose(before, next, write);
          expect(after.selected, "the selection always moves").toBe(next);
          if (write?.ok) {
            acknowledged += 1;
            expect(after.persisted).toBe(next);
            expect(after.note).toBeNull();
          } else {
            expect(
              after.persisted,
              `unacknowledged write moved the stored fact: ${JSON.stringify({ start, next, write })}`,
            ).toBe(before.persisted);
            expect(after.note === null).toBe(write === null);
          }
        }
      }
    }
    // Non-vacuity: the acknowledged branch really ran, so the loop is not
    // passing merely because nothing matched it.
    expect(acknowledged).toBe(starts.length * nexts.length);
  });
});
