import { describe, expect, it } from "vitest";
import {
  normalizeNumbingNotes,
  numbingDisplay,
} from "@/lib/sessions/clinical-response";

// 0156 conditional numbing notes: pure server normalization + shared display.
// The status/notes rules and the read-surface presenter both live in one module
// so charting write, saved display, and any future summary can't drift.

describe("normalizeNumbingNotes (server contract)", () => {
  it("used + text → trimmed text", () => {
    expect(normalizeNumbingNotes("used", "  EMLA cream applied 20 min  ")).toBe(
      "EMLA cream applied 20 min",
    );
  });
  it("used + blank/whitespace → NULL (no placeholder)", () => {
    expect(normalizeNumbingNotes("used", "   ")).toBeNull();
    expect(normalizeNumbingNotes("used", "")).toBeNull();
    expect(normalizeNumbingNotes("used", null)).toBeNull();
    expect(normalizeNumbingNotes("used", undefined)).toBeNull();
  });
  it("none + text → NULL (a note is discarded without 'used'; never infers use)", () => {
    expect(normalizeNumbingNotes("none", "some note")).toBeNull();
  });
  it("not recorded (null / empty) + text → NULL", () => {
    expect(normalizeNumbingNotes(null, "some note")).toBeNull();
    expect(normalizeNumbingNotes("", "some note")).toBeNull();
  });
  it("invalid/unknown status + text → NULL (defensive; never fabricates)", () => {
    expect(normalizeNumbingNotes("bogus", "x")).toBeNull();
    expect(normalizeNumbingNotes(undefined, "x")).toBeNull();
  });
  it("preserves multiline text exactly (only outer trim)", () => {
    expect(normalizeNumbingNotes("used", "line one\nline two")).toBe(
      "line one\nline two",
    );
  });
});

describe("numbingDisplay (shared read presenter)", () => {
  it("used + note → label + trimmed note", () => {
    expect(numbingDisplay("used", "  cream  ")).toEqual({
      label: "Numbing used",
      note: "cream",
    });
  });
  it("used + no/blank note → label only", () => {
    expect(numbingDisplay("used", "")).toEqual({ label: "Numbing used", note: null });
    expect(numbingDisplay("used", "   ")).toEqual({ label: "Numbing used", note: null });
    expect(numbingDisplay("used", null)).toEqual({ label: "Numbing used", note: null });
  });
  it("none → label only, never a note (even if a stray note is passed)", () => {
    expect(numbingDisplay("none", "stray")).toEqual({
      label: "No numbing used",
      note: null,
    });
  });
  it("not recorded / legacy (null) → nothing to render", () => {
    expect(numbingDisplay(null, null)).toBeNull();
    expect(numbingDisplay(null, "x")).toBeNull();
    expect(numbingDisplay("", "x")).toBeNull();
  });
  it("invalid status → nothing to render", () => {
    expect(numbingDisplay("bogus", "x")).toBeNull();
  });
});
