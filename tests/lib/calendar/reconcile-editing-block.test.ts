import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { reconcileEditingBlock } from "@/lib/calendar/reconcile-editing-block";

// Codex P2 on #1222: after a stale refusal the drawer must hold the refreshed
// block (new updated_at), or every later save is refused again.

const b = (id: string, updated_at: string, note = "") => ({ id, updated_at, note });

describe("reconcileEditingBlock", () => {
  it("nothing open stays nothing", () => {
    expect(reconcileEditingBlock(null, [b("a", "t1")])).toBeNull();
  });
  it("a refresh that did not touch the block returns the SAME object (no reseed)", () => {
    const open = b("a", "t1");
    expect(reconcileEditingBlock(open, [b("a", "t1"), b("z", "t9")])).toBe(open);
  });
  it("a colleague's change replaces the drawer's copy, so the next save carries the NEW updated_at", () => {
    const open = b("a", "t1", "old");
    const next = reconcileEditingBlock(open, [b("a", "t2", "new")]);
    expect(next).toEqual(b("a", "t2", "new"));
    expect(next!.updated_at).toBe("t2");
  });
  it("a block deleted elsewhere closes the drawer", () => {
    expect(reconcileEditingBlock(b("a", "t1"), [b("z", "t1")])).toBeNull();
  });
});

describe("both stale-result handlers are reconciled (desktop day column and mobile day view)", () => {
  const DAY = readFileSync("app/(app)/calendar/DayColumn.tsx", "utf8");
  const MOBILE = readFileSync("app/(app)/calendar/CalendarMobileDayView.tsx", "utf8");
  const DRAWER = readFileSync("app/(app)/calendar/TimedBlockEditDrawer.tsx", "utf8");
  it("each parent reconciles its editingBlock against the refreshed blocks", () => {
    expect(DAY).toMatch(/setEditingBlock\(\(cur\) => reconcileEditingBlock\(cur, timedBlocks\)\)/);
    expect(MOBILE).toMatch(/days\.flatMap\(\(d\) => d\.timedBlocks\)/);
    expect(MOBILE).toMatch(/setEditingBlock\(\(cur\) => reconcileEditingBlock\(cur, all\)\)/);
  });
  it("the drawer keeps the stale message when the SAME block arrives fresh, and clears it for a different block", () => {
    expect(DRAWER).toMatch(/if \(seededId\.current !== block\.id\) setError\(null\)/);
    expect(DRAWER).not.toMatch(/setError\(null\);\n\s*setConfirmingDelete\(false\);\n\s*\}, \[block/);
  });
});
