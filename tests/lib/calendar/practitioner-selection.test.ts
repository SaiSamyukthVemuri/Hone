import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EMPTY_SELECTION_MESSAGE,
  SELECTION_PARAM,
  SELECTION_STORAGE_PREFIX,
  filterBySelection,
  clearLegacySelection,
  decideFirstVisit,
  firstVisitParam,
  isSelected,
  miniCalendarHref,
  parseSelection,
  readStoredSelection,
  selectionStorageKey,
  restoreParam,
  sanitizeStoredSelection,
  selectedPractitioners,
  serializeSelection,
  withSelection,
  writeStoredSelection,
} from "@/lib/calendar/practitioner-selection";
import { buildSidebarModel } from "@/lib/calendar/sidebar-model";
import { practitionerInitials } from "@/lib/calendar/practitioner-identity";
import { calendarUsesFullWidth } from "@/lib/calendar/page-width";

const LISTED = ["p1", "p2", "p3", "p4", "p5"];
const row = (id: string | null) => ({ practitioner_id: id, n: String(id) });

describe("the selection model", () => {
  it("no param = everyone: no filter, unassigned rows included", () => {
    const s = parseSelection(undefined, LISTED);
    expect(s.mode).toBe("all");
    const rows = [row("p1"), row(null), row("former")];
    expect(filterBySelection(rows, s)).toEqual(rows);
  });

  it("0 selected: mode none, nothing is drawn and nobody is silently restored", () => {
    for (const raw of ["none", "  none ", "ghost1,ghost2"]) {
      const s = parseSelection(raw, LISTED);
      expect(s.mode).toBe("none");
      expect(filterBySelection([row("p1"), row(null)], s)).toEqual([]);
      expect(selectedPractitioners(LISTED.map((id) => ({ id })), s)).toEqual([]);
    }
    expect(EMPTY_SELECTION_MESSAGE).toBe("Select a practitioner to view their calendar.");
  });

  it("1, 2 and 5+ selected: exactly those, in list order, rows of others and unassigned rows hidden", () => {
    const one = parseSelection("p3", LISTED);
    expect(one.mode).toBe("some");
    expect(filterBySelection([row("p1"), row("p3"), row(null)], one).map((r) => r.practitioner_id)).toEqual(["p3"]);
    const two = parseSelection("p4,p1", LISTED);
    expect(selectedPractitioners(LISTED.map((id) => ({ id })), two).map((p) => p.id)).toEqual(["p1", "p4"]);
    const four = parseSelection("p1,p2,p3,p4", LISTED);
    expect(four.mode).toBe("some");
    expect(four.ids.size).toBe(4);
  });

  it("every listed id selected collapses to everyone (the unfiltered view)", () => {
    expect(parseSelection("p1,p2,p3,p4,p5", LISTED).mode).toBe("all");
    expect(serializeSelection(LISTED, LISTED)).toBeUndefined();
  });

  it("can only narrow: an id the viewer is not offered is dropped, never selected", () => {
    const s = parseSelection("p2,not-listed", LISTED);
    expect([...s.ids]).toEqual(["p2"]);
    expect(isSelected(s, "not-listed")).toBe(false);
    expect(isSelected(s, null)).toBe(false);
  });

  it("round-trips: serialize then parse gives the same selection", () => {
    for (const picked of [[], ["p2"], ["p5", "p1"], ["p1", "p2", "p3", "p4"], LISTED]) {
      const param = serializeSelection(picked, LISTED);
      const back = parseSelection(param, LISTED);
      expect([...back.ids].sort()).toEqual((picked.length === 0 ? [] : [...picked]).sort());
    }
    expect(serializeSelection([], LISTED)).toBe("none");
  });

  it("repeated params use the first value; blank means everyone", () => {
    expect(parseSelection(["p2", "p3"], LISTED).ids.has("p2")).toBe(true);
    expect(parseSelection("", LISTED).mode).toBe("all");
  });
});

describe("the sidebar model lists only who the page already loaded", () => {
  const active = [
    { id: "a", display_name: "Ann", color: "sky" },
    { id: "b", display_name: " ", color: null },
  ];
  it("the list is exactly the active practitioners passed in, named, with a colour class and label", () => {
    const m = buildSidebarModel(active, undefined);
    expect(m.practitioners.map((p) => p.id)).toEqual(["a", "b"]);
    expect(m.practitioners[1].name).toBe("Practitioner");
    for (const p of m.practitioners) {
      expect(p.swatchClass.length).toBeGreaterThan(0);
      expect(p.colorLabel.length).toBeGreaterThan(0);
    }
    expect(m.param).toBeUndefined();
    expect(m.selectedIds).toEqual(["a", "b"]);
  });
  it("a selection of someone not in the list cannot widen it", () => {
    const m = buildSidebarModel(active, "a,zzz");
    expect(m.practitioners.map((p) => p.id)).toEqual(["a", "b"]);
    expect(m.selectedIds).toEqual(["a"]);
    expect(m.param).toBe("a");
  });
});

describe("persistence: URL param plus a per-viewer local preference, no DB write", () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
  };
  it("stores and reads the serialised selection per studio AND per viewer", () => {
    const s = mem();
    writeStoredSelection(s, "studio-1", "viewer-d", "p1,p2");
    expect(s.m.get(SELECTION_STORAGE_PREFIX + "studio-1:viewer-d")).toBe("p1,p2");
    expect(readStoredSelection(s, "studio-1", "viewer-d")).toBe("p1,p2");
    expect(readStoredSelection(s, "studio-2", "viewer-d")).toBeNull();
    writeStoredSelection(s, "studio-1", "viewer-d", undefined); // everyone
    expect(readStoredSelection(s, "studio-1", "viewer-d")).toBe("all");
  });
  it("a second viewer on the same browser never reads the first viewer's choice (Photos O4)", () => {
    const s = mem();
    writeStoredSelection(s, "studio-1", "viewer-d", "p-d");
    expect(readStoredSelection(s, "studio-1", "viewer-e")).toBeNull();
    // First visit for E: nothing stored, so E lands on E's own column, not D's.
    expect(firstVisitParam(readStoredSelection(s, "studio-1", "viewer-e"), "p-e", ["p-d", "p-e"])).toBe("p-e");
    // E's own later choice is E's alone and D's is untouched.
    writeStoredSelection(s, "studio-1", "viewer-e", "p-d,p-e");
    expect(readStoredSelection(s, "studio-1", "viewer-e")).toBe("p-d,p-e");
    expect(readStoredSelection(s, "studio-1", "viewer-d")).toBe("p-d");
  });
  it("the pre-fix per-studio key is never read or written, so nobody inherits it and D's later choice is unaffected", () => {
    const s = mem();
    s.setItem(SELECTION_STORAGE_PREFIX + "studio-1", "p-d"); // left by an older build
    expect(readStoredSelection(s, "studio-1", "viewer-e")).toBeNull();
    expect(readStoredSelection(s, "studio-1", "viewer-d")).toBeNull();
    writeStoredSelection(s, "studio-1", "viewer-d", "p-x");
    expect(s.m.get(SELECTION_STORAGE_PREFIX + "studio-1")).toBe("p-d"); // untouched
    expect(readStoredSelection(s, "studio-1", "viewer-d")).toBe("p-x");
  });
  it("without a usable viewer id nothing is read or written (no shared fallback key)", () => {
    const s = mem();
    for (const bad of [null, undefined, "", "a b", "x:y", "<s>"]) {
      writeStoredSelection(s, "studio-1", bad, "p1");
      expect(readStoredSelection(s, "studio-1", bad)).toBeNull();
    }
    expect(s.m.size).toBe(0);
    expect(selectionStorageKey("studio-1", "viewer-d")).toBe(SELECTION_STORAGE_PREFIX + "studio-1:viewer-d");
    expect(selectionStorageKey("", "viewer-d")).toBeNull();
  });
  it("restores a stored subset or none, never 'all' (nothing to change)", () => {
    expect(restoreParam("p1,p2")).toBe("p1,p2");
    expect(restoreParam("none")).toBe("none");
    expect(restoreParam("all")).toBeNull();
    expect(restoreParam(null)).toBeNull();
  });
  it("drops a stored value that is not 'all', 'none' or id-shaped tokens", () => {
    expect(sanitizeStoredSelection("p1,<script>")).toBeNull();
    expect(sanitizeStoredSelection("a b")).toBeNull();
    expect(sanitizeStoredSelection(",,")).toBeNull();
    expect(sanitizeStoredSelection(null)).toBeNull();
  });
  it("survives unavailable storage", () => {
    const boom = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(readStoredSelection(boom, "s", "v")).toBeNull();
    expect(() => writeStoredSelection(boom, "s", "v", "p1")).not.toThrow();
    expect(readStoredSelection(null, "s", "v")).toBeNull();
  });
  it("carries the selection onto hrefs, across date and view changes, and omits it for everyone", () => {
    expect(withSelection("/calendar?view=day&day=2026-11-02", "p1,p2")).toBe(`/calendar?view=day&day=2026-11-02&${SELECTION_PARAM}=p1%2Cp2`);
    expect(withSelection("/calendar?view=week", "none")).toContain("people=none");
    expect(withSelection("/calendar?view=week", undefined)).toBe("/calendar?view=week");
    expect(withSelection("/calendar", "p1")).toBe("/calendar?people=p1");
  });
});

describe("the mini calendar navigates the CURRENT view to the picked date", () => {
  it("day, week and month", () => {
    expect(miniCalendarHref("day", "2026-11-18")).toBe("/calendar?view=day&day=2026-11-18");
    expect(miniCalendarHref("week", "2026-11-18")).toBe("/calendar?view=week&day=2026-11-18");
    expect(miniCalendarHref("month", "2026-11-18")).toBe("/calendar?view=month&month=2026-11-01");
  });
});

describe("small helpers", () => {
  it("initials for the column avatar", () => {
    expect(practitionerInitials("Sam Vemuri")).toBe("SV");
    expect(practitionerInitials("Practitioner B (synthetic)")).toBe("PB");
    expect(practitionerInitials("madonna")).toBe("M");
    expect(practitionerInitials("  ")).toBe("?");
    expect(practitionerInitials(null)).toBe("?");
  });
  it("only the calendar grid page is full width", () => {
    expect(calendarUsesFullWidth("/calendar")).toBe(true);
    expect(calendarUsesFullWidth("/calendar/")).toBe(true);
    expect(calendarUsesFullWidth("/calendar/upcoming")).toBe(false);
    expect(calendarUsesFullWidth("/calendar/abc")).toBe(false);
    expect(calendarUsesFullWidth("/dashboard")).toBe(false);
    expect(calendarUsesFullWidth(null)).toBe(false);
  });
});

// The selection is VIEW-ONLY: pin that it is never imported by slot generation, conflict checks,
// booking or any server action.
describe("view-only invariant", () => {
  function files(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) files(p, out);
      else if (/\.(ts|tsx)$/.test(name)) out.push(p);
    }
    return out;
  }
  const importsSelection = (p: string) => /practitioner-selection|sidebar-model|filterBySelection|parseSelection/.test(readFileSync(p, "utf8"));
  it("no booking, slot, availability or action module touches the selection", () => {
    const guarded = [
      ...files("lib/booking"),
      ...files("app/(app)/calendar").filter((p) => /actions?\.ts$|-actions\.ts$|move-.*\.ts$/.test(p)),
      ...files("app/api"),
      ...files("lib/availability").filter(() => true),
    ].filter((p) => !p.endsWith("MonthView.tsx"));
    expect(guarded.length).toBeGreaterThan(5);
    for (const p of guarded) expect(importsSelection(p), p).toBe(false);
  });
  it("the page uses it only to narrow what it draws, and never passes it to a drawer or column", () => {
    const page = readFileSync("app/(app)/calendar/page.tsx", "utf8");
    expect([...page.matchAll(/filterBySelection\(/g)].length).toBe(3);
    expect(page).not.toMatch(/<QuickBookDrawer[^>]*selection/i);
    expect(page).not.toMatch(/<DayColumn[^>]*(selection|sidebar)/i);
  });
});

describe("duplicate ids never widen a selection (Y1)", () => {
  it("?people=a,a with two listed is one person, not everyone", () => {
    const s = parseSelection("p1,p1", ["p1", "p2"]);
    expect(s.mode).toBe("some");
    expect([...s.ids]).toEqual(["p1"]);
  });
  it("a stored preference is stored without its duplicates", () => {
    expect(sanitizeStoredSelection("p1,p1,p2")).toBe("p1,p2");
  });
});

describe("first visit opens on the viewer's own column (a default, never an access control)", () => {
  it("never chosen + a listed practitioner + others to see = the viewer's own id", () => {
    expect(firstVisitParam(null, "p2", LISTED)).toBe("p2");
  });

  it("a stored preference always wins: 'all' stays everyone, a list is restored, none is kept", () => {
    expect(firstVisitParam("all", "p2", LISTED)).toBeNull();
    expect(firstVisitParam("p3,p4", "p2", LISTED)).toBe("p3,p4");
    expect(firstVisitParam("none", "p2", LISTED)).toBe("none");
  });

  it("an owner or a viewer with no practitioner record stays on everyone", () => {
    expect(firstVisitParam(null, null, LISTED)).toBeNull();
    expect(firstVisitParam(null, undefined, LISTED)).toBeNull();
    expect(firstVisitParam(null, "", LISTED)).toBeNull();
  });

  it("an id that is not listed (deactivated, foreign) never becomes a selection", () => {
    expect(firstVisitParam(null, "ghost", LISTED)).toBeNull();
  });

  it("a studio with only the viewer listed has nothing to narrow: everyone", () => {
    expect(firstVisitParam(null, "p1", ["p1"])).toBeNull();
    expect(firstVisitParam(null, "p1", [])).toBeNull();
  });

  it("the result round-trips: parsing it selects exactly the viewer, and every other person is one tap away", () => {
    const param = firstVisitParam(null, "p2", LISTED);
    const sel = parseSelection(param, LISTED);
    expect(sel.mode).toBe("some");
    expect([...sel.ids]).toEqual(["p2"]);
    expect(serializeSelection([...sel.ids, "p3"], LISTED)).toBe("p2,p3");
  });
});

describe("an explicit choice in this mount is never undone by the first-visit default, even with storage blocked (Codex P2, #1424)", () => {
  const LISTED = ["p1", "p2", "p3"];
  const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  // The caller's in-memory flag, driven the way the sidebar effect drives it.
  function mount() {
    let decided = false;
    return (hasParam: boolean, ownFirstId: string | null) => {
      const r = decideFirstVisit({ decided, hasParam, readStored: () => readStoredSelection(blocked, "s", "v"), ownFirstId, listedIds: LISTED });
      decided = r.decided;
      return r.param;
    };
  }
  it("explicit ?people= link, then ticking everyone removes the param: nothing is reinstated", () => {
    const effect = mount();
    expect(effect(true, "p1")).toBeNull(); // the link carries the selection
    expect(effect(false, "p1")).toBeNull(); // everyone ticked, param removed, storage unreadable
  });
  it("a plain first visit applies the own default once; unticking back to everyone then stays everyone", () => {
    const effect = mount();
    expect(effect(false, "p1")).toBe("p1"); // first visit, nothing stored (blocked)
    expect(effect(true, "p1")).toBeNull(); // the URL now carries it
    expect(effect(false, "p1")).toBeNull(); // viewer chose everyone: no re-apply
  });
  it("a new mount (reload) with storage blocked applies the default again: that is the first visit, by design", () => {
    expect(mount()(false, "p1")).toBe("p1");
  });
  it("with working storage the stored preference still wins over the default on the first decision", () => {
    const s = { m: new Map<string, string>(), getItem(k: string) { return this.m.get(k) ?? null; }, setItem(k: string, v: string) { this.m.set(k, v); } };
    writeStoredSelection(s, "s", "v", "p2,p3");
    expect(decideFirstVisit({ decided: false, hasParam: false, readStored: () => readStoredSelection(s, "s", "v"), ownFirstId: "p1", listedIds: LISTED }).param).toBe("p2,p3");
  });
  it("readStored is not even called once a choice exists", () => {
    let reads = 0;
    const read = () => { reads += 1; return null; };
    decideFirstVisit({ decided: true, hasParam: false, readStored: read, ownFirstId: "p1", listedIds: LISTED });
    decideFirstVisit({ decided: false, hasParam: true, readStored: read, ownFirstId: "p1", listedIds: LISTED });
    expect(reads).toBe(0);
  });
});

describe("the pre-fix per-studio key is removed once, unread (Privacy N1, #1424)", () => {
  function store(initial: Record<string, string>) {
    const m = new Map(Object.entries(initial));
    const reads: string[] = [];
    return { m, reads, getItem: (k: string) => { reads.push(k); return m.get(k) ?? null; }, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  }
  it("removes exactly the legacy key and leaves every other key, without reading anything", () => {
    const s = store({
      [SELECTION_STORAGE_PREFIX + "studio-1"]: "p-d", // legacy, studio-1
      [SELECTION_STORAGE_PREFIX + "studio-1:viewer-d"]: "p-d", // per-viewer key
      [SELECTION_STORAGE_PREFIX + "studio-2"]: "p-x", // another studio's legacy key
      "hone:calendar:sidebar:v1": "closed",
    });
    clearLegacySelection(s, "studio-1");
    expect([...s.m.keys()].sort()).toEqual(
      [
        "hone:calendar:sidebar:v1",
        SELECTION_STORAGE_PREFIX + "studio-1:viewer-d",
        SELECTION_STORAGE_PREFIX + "studio-2",
      ].sort(),
    );
    expect(s.reads).toEqual([]); // never inspected
  });
  it("does not widen what the per-viewer key stores, and a later choice still round-trips", () => {
    const s = store({ [SELECTION_STORAGE_PREFIX + "studio-1"]: "p-d" });
    clearLegacySelection(s, "studio-1");
    writeStoredSelection(s, "studio-1", "viewer-d", "p1,p2");
    expect(s.m.get(SELECTION_STORAGE_PREFIX + "studio-1:viewer-d")).toBe("p1,p2");
    expect(s.m.has(SELECTION_STORAGE_PREFIX + "studio-1")).toBe(false);
  });
  it("is harmless when there is nothing to remove, no studio id, no storage, or storage throws", () => {
    const s = store({});
    expect(() => clearLegacySelection(s, "studio-1")).not.toThrow();
    expect(() => clearLegacySelection(s, "")).not.toThrow();
    expect(() => clearLegacySelection(null, "studio-1")).not.toThrow();
    expect(() => clearLegacySelection({ removeItem: () => { throw new Error("blocked"); } }, "studio-1")).not.toThrow();
  });
});
