import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { appendHistoryPage } from "@/lib/settings/roles/api";
import { parseHistory } from "@/lib/settings/roles/core-parse";

// Codex on #1335 3888b802a: History showed only the first 50 audit rows. The page pages by the cursor the core returns.

const LIMIT = 50;
const raw = (id: number, kind = "role_permissions_saved") => ({
  id, at: "2026-11-01T00:00:00Z", kind, role: "practitioner", actor_name: "Owner", reason: null,
  before: { "appt.cancel": { stored: "studio", effective: "studio" } },
  after: { "appt.cancel": { stored: "off", effective: "off" } },
});
/** The core: newest first, strictly older than `before`, at most LIMIT per page. */
const core = (all: ReturnType<typeof raw>[]) => (before: string | null) =>
  parseHistory({ ok: true, rows: all.filter((r) => before === null || r.id < Number(before)).slice(0, LIMIT) }, LIMIT);

describe("History paging past 50", () => {
  const all = Array.from({ length: 120 }, (_, i) => raw(120 - i));
  it("reaches every row, once, newest first, and stops when the core has no more", () => {
    const page = core(all);
    let shown = [] as ReturnType<typeof appendHistoryPage>;
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r = page(cursor);
      if (!r.ok) throw new Error("expected ok");
      shown = appendHistoryPage(shown, r.rows);
      cursor = r.next;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(pages).toBe(3);
    expect(shown.map((r) => r.id)).toEqual(all.map((r) => String(r.id)));
  });
  it("an exactly full last page offers one more request that returns nothing", () => {
    const fifty = Array.from({ length: 50 }, (_, i) => raw(50 - i));
    const first = core(fifty)(null);
    if (!first.ok) throw new Error("expected ok");
    expect(first.next).toBe("1");
    const second = core(fifty)(first.next);
    if (second.ok) expect(second).toMatchObject({ rows: [], next: null });
  });
  it("a row of a kind the page does not know does not end the paging", () => {
    const page = Array.from({ length: 50 }, (_, i) => raw(100 - i, i === 49 ? "future_kind" : "role_permissions_saved"));
    const r = parseHistory({ ok: true, rows: page }, LIMIT);
    if (!r.ok) throw new Error("expected ok");
    expect(r.rows).toHaveLength(49);
    expect(r.next).toBe("51");
  });
  it("an overlapping page does not repeat a row", () => {
    const a = [{ id: "3" }, { id: "2" }] as never;
    const b = [{ id: "2" }, { id: "1" }] as never;
    expect(appendHistoryPage(a, b).map((r) => r.id)).toEqual(["3", "2", "1"]);
  });
});

describe("the History panel offers the older page", () => {
  const src = readFileSync("app/(app)/settings/roles/roles-editor.tsx", "utf8");
  it("has a Load older control wired to the returned cursor, disabled while loading, with a visible error", () => {
    expect(src).toContain('data-testid="history-load-older"');
    expect(src).toMatch(/loadOlder\(state\.next as string\)/);
    expect(src).toMatch(/disabled=\{more\.busy\}/);
    expect(src).toContain('data-testid="history-more-error"');
  });
  it("a failed older page keeps the rows already shown", () => {
    const fn = src.slice(src.indexOf("const loadOlder"), src.indexOf("return (", src.indexOf("const loadOlder")));
    expect(fn).toContain("appendHistoryPage(s.rows, r.rows)");
    expect(fn).not.toMatch(/setState\(\{ kind: "error"/);
  });
});
