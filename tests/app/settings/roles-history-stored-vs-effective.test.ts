import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseHistory } from "@/lib/settings/roles/core-parse";

// Codex P2 4476177056 (core-parse.ts:182): History discarded the stored values, so a pending-key change Studio -> Off printed
// "Whole studio to Whole studio". The audit row records both; History now carries the saved choice beside what was in force and shows
// them separately when they differ.

const row = (kind: string, before: unknown, after: unknown) => ({ id: 1, at: "t", kind, role: "practitioner", before, after });
const parse = (r: ReturnType<typeof row>) => {
  const out = parseHistory({ ok: true, rows: [r] }, 50);
  if (!out.ok) throw new Error("expected ok");
  return out.rows[0];
};
const K = "View clinical records";

describe("History keeps the saved choice beside what was in force", () => {
  it("a pending-key save Studio -> Off: stored moves, effective does not", () => {
    const r = parse(row("role_permissions_saved", { "clin.view_records": { stored: "studio", effective: "studio" } }, { "clin.view_records": { stored: "off", effective: "studio" } }));
    expect(r.storedBefore).toEqual({ [K]: "Whole studio" });
    expect(r.storedAfter).toEqual({ [K]: "Off" });
    expect(r.before).toEqual({ [K]: "Whole studio" });
    expect(r.after).toEqual({ [K]: "Whole studio" });
  });
  it("a released key: stored and effective agree", () => {
    const r = parse(row("role_permissions_saved", { "clin.view_records": { stored: "studio", effective: "studio" } }, { "clin.view_records": { stored: "off", effective: "off" } }));
    expect(r.storedAfter).toEqual({ [K]: "Off" });
    expect(r.after).toEqual({ [K]: "Off" });
  });
  it("a reset that records stored choices keeps them, and a stored-only move is not dropped as 'unchanged'", () => {
    const r = parse(row("role_reset", { "clin.view_records": { stored: "off", effective: "studio" } }, { "clin.view_records": { stored: "studio", effective: "studio" } }));
    expect(r.storedBefore).toEqual({ [K]: "Off" });
    expect(r.storedAfter).toEqual({ [K]: "Whole studio" });
  });
  it("Team's reset shape: a deleted pending-key choice shows as removed while access stays where it was", () => {
    const r = parse(row("role_reset", { "clin.view_records": { stored: "off", effective: "studio" } }, { "clin.view_records": { stored: null, effective: "studio" } }));
    expect(r.storedBefore).toEqual({ [K]: "Off" });
    expect(r.storedAfter).toEqual({ [K]: "no saved choice" });
    expect(r.before).toEqual(r.after);
  });
  it("an older reset row with flat effective values still parses, with no stored maps", () => {
    const r = parse(row("role_reset", { "clin.view_records": "studio" }, { "clin.view_records": "off" }));
    expect(r.storedBefore).toEqual({});
    expect(r.storedAfter).toEqual({});
    expect(r.after).toEqual({ [K]: "Off" });
  });
});

describe("the page shows them separately only when they differ", () => {
  const SRC = readFileSync("app/(app)/settings/roles/roles-editor.tsx", "utf8");
  it("renders a saved-choice line and an in-force line, and the plain line otherwise", () => {
    expect(SRC).toContain('data-testid="history-stored"');
    expect(SRC).toContain('data-testid="history-in-force"');
    expect(SRC).toContain("saved choice ");
    expect(SRC).toMatch(/in force: stays /);
    expect(SRC).toMatch(/const differs = hasStored && \(r\.storedBefore\[k\] !== r\.before\[k\] \|\| r\.storedAfter\[k\] !== r\.after\[k\]\)/);
  });
});
