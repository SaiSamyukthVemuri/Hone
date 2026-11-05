import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Codex P2 4476158119: Cancel left the staged (unsaved) performer on screen as if it were the record. The line now keeps the SAVED performer
// apart from the DRAFT in the select: it displays and decides "is this a correction" from the saved value, and Cancel puts the draft back.
// Source contract (the repo has no DOM test harness); the behaviour is the wiring below.
const src = readFileSync("components/session-performer-line.tsx", "utf8");

describe("session performer line: the draft never stands in for the saved performer", () => {
  it("keeps a saved value and a draft as two states", () => {
    expect(src).toMatch(/const \[savedPerformerId, setSavedPerformerId\] = useState\(initialPerformerId \?\? ""\)/);
    expect(src).toMatch(/const \[performerId, setPerformerId\] = useState\(initialPerformerId \?\? ""\)/);
  });
  it("displays the saved performer, not the draft", () => {
    expect(src).toMatch(/practitioners\.find\(\(p\) => p\.id === savedPerformerId\)/);
    expect(src).not.toMatch(/practitioners\.find\(\(p\) => p\.id === performerId\)/);
  });
  it("Cancel restores the draft to the saved value and clears the reason and the error", () => {
    const cancel = src.match(/function cancelEditing\(\) \{([\s\S]*?)\n  \}/);
    expect(cancel).not.toBeNull();
    expect(cancel![1]).toMatch(/setPerformerId\(savedPerformerId\)/);
    expect(cancel![1]).toMatch(/setReason\(""\)/);
    expect(cancel![1]).toMatch(/setError\(null\)/);
    expect(cancel![1]).toMatch(/setEditing\(false\)/);
    expect(src).toMatch(/onClick=\{cancelEditing\}/);
    expect(src).not.toMatch(/onClick=\{\(\) => setEditing\(false\)\}/);
  });
  it("only a SUCCESSFUL save updates the saved performer", () => {
    expect(src).toMatch(/await updatePerformerAction\(fd\);\s*setSavedPerformerId\(next\)/);
  });
  it("whether a change is a correction follows the saved performer, so a second change after a first attribution asks for a reason", () => {
    expect(src).toMatch(/const needsReason = Boolean\(savedPerformerId\)/);
    expect(src).toMatch(/performerId === savedPerformerId/);
  });
});
