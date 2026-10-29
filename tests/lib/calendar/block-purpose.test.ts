import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { blockPurpose, BLOCK_PURPOSE_GROUPS } from "@/lib/calendar/block-purpose";

// HON-48: breaks, lunch and working-time blocks must stay distinguishable on the
// calendar by more than a label's wording, and never by colour alone. Existing
// categories only; a cleaning/charting category is a schema decision (not here).

const CATEGORIES = ["lunch", "break", "meeting", "emergency", "personal", "training", "admin", "other"] as const;

describe("blockPurpose", () => {
  it("every stored block category has a purpose with a glyph, a group and an accent", () => {
    for (const c of CATEGORIES) {
      const p = blockPurpose(c);
      expect(p.glyph.length, c).toBeGreaterThan(0);
      expect(p.accent, c).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(BLOCK_PURPOSE_GROUPS).toContain(p.group);
    }
  });
  it("rest (lunch, break) is told apart from working-time blocks and from unavailable time", () => {
    expect(blockPurpose("lunch").group).toBe("rest");
    expect(blockPurpose("break").group).toBe("rest");
    expect(blockPurpose("admin").group).toBe("work");
    expect(blockPurpose("meeting").group).toBe("work");
    expect(blockPurpose("training").group).toBe("work");
    expect(blockPurpose("personal").group).toBe("away");
    expect(blockPurpose("emergency").group).toBe("away");
    expect(blockPurpose("other").group).toBe("away");
    const marks = new Set(["rest", "work", "away"].map((g) => CATEGORIES.map((c) => blockPurpose(c)).find((p) => p.group === g)!.glyph));
    expect(marks.size).toBe(3);
    const accents = new Set(["rest", "work", "away"].map((g) => CATEGORIES.map((c) => blockPurpose(c)).find((p) => p.group === g)!.accent));
    expect(accents.size).toBe(3);
  });
  it("an unknown category falls back to the neutral 'away' mark, never throws", () => {
    expect(blockPurpose("mystery").group).toBe("away");
    expect(blockPurpose(null).group).toBe("away");
  });
  it("recurring-break labels map the same way (lunch/break rest, admin work, custom = rest)", () => {
    expect(blockPurpose("Lunch").group).toBe("rest");
    expect(blockPurpose("school pickup", { recurring: true }).group).toBe("rest");
    expect(blockPurpose("Admin", { recurring: true }).group).toBe("work");
  });
  it("is never colour alone: the glyph is text, and the card keeps its written label", () => {
    const DAY = readFileSync("app/(app)/calendar/DayColumn.tsx", "utf8");
    expect(DAY).toMatch(/purpose=\{blockPurpose\(tb\.category\)\}/);
    expect(DAY).toMatch(/purpose=\{blockPurpose\(occ\.rule\?\.label, \{ recurring: true \}\)\}/);
    expect(DAY).toMatch(/<span aria-hidden="true" className="mr-1">\{purpose\.glyph\}<\/span>\}\{label\}/);
    expect(DAY).toMatch(/data-block-purpose=\{purpose\?\.group\}/);
  });
});
