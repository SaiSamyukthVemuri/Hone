import { describe, expect, it } from "vitest";
import { FINDER_INITIAL, onFinderInput, onFinderKey } from "@/lib/finance/statement-finder-keys";

const typed = onFinderInput("ada");

describe("typing", () => {
  it("opens the list when there is text, clears the highlight, and closes on an empty or blank query", () => {
    expect(typed).toEqual({ query: "ada", open: true, active: null });
    expect(onFinderInput("   ")).toEqual({ query: "   ", open: false, active: null });
    expect(onFinderInput("")).toEqual(FINDER_INITIAL);
  });
});

describe("arrow keys", () => {
  it("ArrowDown highlights the first, then moves and wraps; ArrowUp starts at the last and wraps", () => {
    let s = typed;
    const seq: (number | null)[] = [];
    for (let i = 0; i < 4; i++) {
      s = onFinderKey(s, "ArrowDown", 3).state;
      seq.push(s.active);
    }
    expect(seq).toEqual([0, 1, 2, 0]);
    expect(onFinderKey(typed, "ArrowUp", 3).state.active).toBe(2);
    expect(onFinderKey({ ...typed, active: 0 }, "ArrowUp", 3).state.active).toBe(2);
  });
  it("prevents the page scroll when it acts, and does nothing with no options", () => {
    expect(onFinderKey(typed, "ArrowDown", 3).preventDefault).toBe(true);
    const r = onFinderKey(typed, "ArrowDown", 0);
    expect(r).toEqual({ state: typed, select: null, preventDefault: false });
  });
  it("Home and End jump only while the list is open", () => {
    expect(onFinderKey({ ...typed, active: 1 }, "Home", 3).state.active).toBe(0);
    expect(onFinderKey({ ...typed, active: 1 }, "End", 3).state.active).toBe(2);
    expect(onFinderKey({ ...typed, open: false }, "End", 3).state.active).toBeNull();
  });
});

describe("Enter and Escape", () => {
  it("Enter opens ONLY an explicitly highlighted option, and closes the list", () => {
    const r = onFinderKey({ ...typed, active: 1 }, "Enter", 3);
    expect(r.select).toBe(1);
    expect(r.state.open).toBe(false);
    expect(onFinderKey(typed, "Enter", 3).select).toBeNull(); // typed but nothing pointed at: no accidental navigation
    expect(onFinderKey({ ...typed, active: 5 }, "Enter", 3).select).toBeNull(); // a stale highlight beyond the list
    expect(onFinderKey({ ...typed, open: false, active: 1 }, "Enter", 3).select).toBeNull();
  });
  it("Escape closes the list first, then clears the text", () => {
    const closed = onFinderKey({ ...typed, active: 1 }, "Escape", 3).state;
    expect(closed).toEqual({ query: "ada", open: false, active: null });
    expect(onFinderKey(closed, "Escape", 3).state.query).toBe("");
  });
  it("Tab closes the list without selecting", () => {
    const r = onFinderKey({ ...typed, active: 1 }, "Tab", 3);
    expect(r.select).toBeNull();
    expect(r.state.open).toBe(false);
  });
});
