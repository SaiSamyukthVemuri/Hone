import { describe, expect, it } from "vitest";
import { summarizeReports } from "@/components/charting-visit-draft";
import { visitSaveStatus } from "@/components/charting-view-shell";

const r = (o: Partial<Parameters<typeof summarizeReports>[0][string]> = {}) => ({ machine: null, draftAreas: [], unsaved: false, attention: false, ...o });

describe("summarizeReports", () => {
  it("is empty with no form open", () => {
    expect(summarizeReports({})).toEqual({ machine: null, draftAreas: [], unsaved: false, attention: false });
  });
  it("takes the first selected machine, de-duplicates areas, and is unsaved or attention if ANY form is", () => {
    const s = summarizeReports({ "block:b": r({ draftAreas: ["Chin"], unsaved: true }), "block:a": r({ machine: "xCell Pur · 27.12 MHz", draftAreas: ["Chin", "Jawline"], attention: true }) });
    expect(s.machine).toBe("xCell Pur · 27.12 MHz");
    expect(s.draftAreas).toEqual(["Chin", "Jawline"]);
    expect(s.unsaved).toBe(true);
    expect(s.attention).toBe(true);
  });
});

describe("visitSaveStatus", () => {
  it("needs attention beats everything", () => {
    expect(visitSaveStatus({ attention: true, unsaved: false, savedCount: 3 })).toBe("Needs attention");
  });
  it("unsaved work, or nothing saved at all, is Not saved yet", () => {
    expect(visitSaveStatus({ attention: false, unsaved: true, savedCount: 3 })).toBe("Not saved yet");
    expect(visitSaveStatus({ attention: false, unsaved: false, savedCount: 0 })).toBe("Not saved yet");
  });
  it("saved blocks and no unsaved work is Saved", () => {
    expect(visitSaveStatus({ attention: false, unsaved: false, savedCount: 2 })).toBe("Saved");
  });
});
