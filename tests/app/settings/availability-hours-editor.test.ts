import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

// The server actions are not under test here and pull in the Supabase server
// client; the editor only needs their names to exist.
vi.mock("@/app/(app)/settings/availability/actions", () => ({
  createBlockoutAction: vi.fn(),
  deleteBlockoutAction: vi.fn(),
  deleteOverrideAction: vi.fn(),
  saveWeeklyDefaultsAction: vi.fn(),
  upsertDayDefaultAction: vi.fn(),
  upsertOverrideAction: vi.fn(),
}));

import {
  DayEditor,
  dayDefaultFormData,
  daysFromDefaults,
  type DayState,
} from "@/app/(app)/settings/availability/AvailabilityClient";

// HON-62 — during onboarding an owner could not type a time into, or scroll,
// the weekly-hours "Opens"/"Closes" control on Settings > Availability.
//
// Cause (source): those fields were a custom picker — a <button> that opened
// a 15-minute <ul> clamped to 06:00–22:00 inside a max-h-64 overflow-y-auto
// nested scroller. A button cannot take typed input, the list always opened
// at 6:00 AM, and a saved time outside the window could not be chosen. The
// fix replaces it with a native <input type="time">, as every other time
// field in this directory already uses.
//
// What this file can and cannot prove. Vitest runs in the node environment
// with no DOM, so it proves the rendered CONTRACT (a real, typeable time
// input carrying the exact saved value, and no nested scroller) and the
// save → reload mapping. Actual keystrokes and touch scrolling on iPad
// Safari, macOS Safari and Chrome need a browser and are a separate,
// slot-gated Playwright run; nothing here claims device acceptance.

const SOURCE = "app/(app)/settings/availability/AvailabilityClient.tsx";
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function renderEditor(dow: number, draft: DayState): string {
  return renderToStaticMarkup(
    createElement(DayEditor, {
      dow,
      draft,
      saving: false,
      error: null,
      openDaysForCopy: [],
      onChangeOpen: () => {},
      onChangeClose: () => {},
      onToggleOpen: () => {},
      onCloseDay: () => {},
      onCopyFrom: () => {},
      onCancel: () => {},
      onSave: () => {},
    }),
  );
}

/** The attribute text of the <input> whose aria-label is `label`. */
function inputFor(markup: string, label: string): string | null {
  for (const m of markup.matchAll(/<input([^>]*)>/g)) {
    if (m[1].includes(`aria-label="${label}"`)) return m[1];
  }
  return null;
}

// A synthetic established week in the shape the database returns
// (HH:MM:SS), including times the old picker could not represent: an
// off-quarter minute and opening/closing outside the 06:00–22:00 grid.
const ESTABLISHED_WEEK = [
  { day_of_week: 0, is_open: false, open_time: null, close_time: null },
  { day_of_week: 1, is_open: true, open_time: "09:00:00", close_time: "17:00:00" },
  { day_of_week: 2, is_open: true, open_time: "07:45:00", close_time: "19:10:00" },
  { day_of_week: 3, is_open: true, open_time: "05:30:00", close_time: "22:30:00" },
  { day_of_week: 4, is_open: true, open_time: "10:00:00", close_time: "18:00:00" },
  { day_of_week: 5, is_open: true, open_time: "09:07:00", close_time: "13:00:00" },
  { day_of_week: 6, is_open: false, open_time: null, close_time: null },
];

/** What the database row looks like after upsertDayDefaultAction stores fd. */
function storedRow(fd: FormData) {
  const isOpen = fd.get("is_open") === "true";
  return {
    day_of_week: Number(fd.get("day_of_week")),
    is_open: isOpen,
    open_time: isOpen ? `${fd.get("open_time")}:00` : null,
    close_time: isOpen ? `${fd.get("close_time")}:00` : null,
  };
}

describe("HON-62 keyboard entry: the hour fields are native time inputs", () => {
  it("renders Opens and Closes as typeable <input type=\"time\"> with the draft value", () => {
    const markup = renderEditor(1, { is_open: true, open_time: "09:00", close_time: "17:00" });
    const opens = inputFor(markup, "Monday opens");
    const closes = inputFor(markup, "Monday closes");
    expect(opens).not.toBeNull();
    expect(closes).not.toBeNull();
    for (const attrs of [opens!, closes!]) {
      expect(attrs).toContain('type="time"');
      expect(attrs).not.toMatch(/\s(readonly|readOnly|disabled)(=|\s|$)/);
      // No step: an existing off-quarter minute must stay a valid value.
      expect(attrs).not.toContain("step=");
    }
    expect(opens).toContain('value="09:00"');
    expect(closes).toContain('value="17:00"');
  });

  it("no longer renders the button-and-list picker", () => {
    const markup = renderEditor(1, { is_open: true, open_time: "09:00", close_time: "17:00" });
    expect(markup).not.toContain("Pick time");
    // The old picker's trigger showed the formatted label on a button.
    expect(markup).not.toMatch(/<button[^>]*>9:00 AM<\/button>/);
    const src = code(SOURCE);
    expect(src).not.toMatch(/function TimePicker\b/);
    expect(src).not.toMatch(/<TimePicker\b/);
    // Special hours used the same picker; it must use the same input.
    expect(src.match(/<TimeField\b/g)?.length).toBe(4);
  });

  it("shows a saved time outside the old 06:00–22:00 / 15-minute list exactly", () => {
    const markup = renderEditor(3, { is_open: true, open_time: "05:30", close_time: "22:30" });
    expect(inputFor(markup, "Wednesday opens")).toContain('value="05:30"');
    expect(inputFor(markup, "Wednesday closes")).toContain('value="22:30"');
    const offQuarter = renderEditor(5, { is_open: true, open_time: "09:07", close_time: "13:00" });
    expect(inputFor(offQuarter, "Friday opens")).toContain('value="09:07"');
  });
});

describe("HON-62 touch scroll: no nested scroll container in the day editor", () => {
  // A real touch-scroll gesture is not modelled in node (or jsdom). What a
  // unit test can pin is the structural cause: the old list was a nested
  // overflow-y-auto scroller. The native input hands touch selection to the
  // OS picker; the gesture itself is in the browser HEAVY-REQUEST.
  it("renders no overflow scroller and no listbox inside the editor", () => {
    const markup = renderEditor(1, { is_open: true, open_time: "09:00", close_time: "17:00" });
    expect(markup).not.toMatch(/overflow-y-(auto|scroll)/);
    expect(markup).not.toContain("<ul");
    expect(markup).not.toContain('role="listbox"');
  });

  // The markup check alone is vacuous against the old picker: its list was
  // behind `open` state, closed on first render, so static markup never
  // contained it. Pin the field's own source as well.
  it("the time field holds no popover state and no scroller of its own", () => {
    const src = code(SOURCE);
    const start = src.indexOf("function TimeField(");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("\nfunction ", start + 1);
    const body = src.slice(start, end === -1 ? undefined : end);
    expect(body).toContain('type="time"');
    expect(body).not.toMatch(/useState|useRef|useEffect/);
    expect(body).not.toMatch(/overflow-y-|max-h-|<ul\b|<button\b/);
  });
});

describe("HON-62 save and reload of edited hours", () => {
  it("an edited day round-trips through Save and a reload; other days are untouched", () => {
    const before = daysFromDefaults(ESTABLISHED_WEEK);
    const edited: DayState = { is_open: true, open_time: "08:30", close_time: "16:45" };

    const fd = dayDefaultFormData(1, edited);
    expect(fd.get("day_of_week")).toBe("1");
    expect(fd.get("is_open")).toBe("true");
    // The exact values the server action validates with TIME_RE.
    expect(fd.get("open_time")).toMatch(TIME_RE);
    expect(fd.get("close_time")).toMatch(TIME_RE);

    const reloaded = daysFromDefaults(
      ESTABLISHED_WEEK.map((row) => (row.day_of_week === 1 ? storedRow(fd) : row)),
    );
    expect(reloaded.get(1)).toEqual(edited);
    for (const dow of [0, 2, 3, 4, 5, 6]) {
      expect(reloaded.get(dow)).toEqual(before.get(dow));
    }
    // And the editor reopens on the saved values.
    const markup = renderEditor(1, reloaded.get(1)!);
    expect(inputFor(markup, "Monday opens")).toContain('value="08:30"');
    expect(inputFor(markup, "Monday closes")).toContain('value="16:45"');
  });

  it("closing a day sends no times and reloads as closed", () => {
    const fd = dayDefaultFormData(4, { is_open: false, open_time: "10:00", close_time: "18:00" });
    expect(fd.get("is_open")).toBe("false");
    expect(fd.has("open_time")).toBe(false);
    expect(fd.has("close_time")).toBe(false);
    const reloaded = daysFromDefaults(
      ESTABLISHED_WEEK.map((row) => (row.day_of_week === 4 ? storedRow(fd) : row)),
    );
    expect(reloaded.get(4)).toEqual({ is_open: false, open_time: "", close_time: "" });
  });
});

describe("HON-62 existing availability is unchanged by the fix", () => {
  it("loads an established week to the exact HH:MM it stored, closed days empty", () => {
    const days = daysFromDefaults(ESTABLISHED_WEEK);
    expect([...days.entries()]).toEqual([
      [0, { is_open: false, open_time: "", close_time: "" }],
      [1, { is_open: true, open_time: "09:00", close_time: "17:00" }],
      [2, { is_open: true, open_time: "07:45", close_time: "19:10" }],
      [3, { is_open: true, open_time: "05:30", close_time: "22:30" }],
      [4, { is_open: true, open_time: "10:00", close_time: "18:00" }],
      [5, { is_open: true, open_time: "09:07", close_time: "13:00" }],
      [6, { is_open: false, open_time: "", close_time: "" }],
    ]);
  });

  it("re-saving every day without an edit reproduces the stored week", () => {
    const days = daysFromDefaults(ESTABLISHED_WEEK);
    const resaved = [...days.entries()].map(([dow, state]) =>
      storedRow(dayDefaultFormData(dow, state)),
    );
    expect(resaved).toEqual(ESTABLISHED_WEEK);
  });

  it("opening the editor on any established open day shows its stored times verbatim", () => {
    const days = daysFromDefaults(ESTABLISHED_WEEK);
    const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    for (const [dow, state] of days) {
      if (!state.is_open) continue;
      const markup = renderEditor(dow, state);
      expect(inputFor(markup, `${names[dow]} opens`)).toContain(`value="${state.open_time}"`);
      expect(inputFor(markup, `${names[dow]} closes`)).toContain(`value="${state.close_time}"`);
    }
  });
});
