import { describe, expect, it } from "vitest";
import { summarizeReports, visitMachineLine } from "@/components/charting-visit-draft";
import { machineModelLabel } from "@/lib/machines/display-name";
import { XCELL_PUR_PROFILE_ID } from "@/lib/machines/xcell-pur";
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

describe("visitMachineLine", () => {
  it("shows the xCell Pur unit under the studio's own name, not the catalogue's raw model", () => {
    const label = machineModelLabel({ profileId: XCELL_PUR_PROFILE_ID, manufacturer: "Apilus", model: "xCell Pur", variant: undefined });
    expect(visitMachineLine(label, "27.12 MHz")).toBe("Dectro xCell \u00b7 27.12 MHz");
    expect(visitMachineLine(label, "27.12 MHz")).not.toContain("xCell Pur");
  });
  it("renders the stored frequency as stored: exactly one MHz", () => {
    const line = visitMachineLine("Dectro xCell", "27.12 MHz")!;
    expect(line.match(/MHz/g)).toHaveLength(1);
  });
  it("trims the stored frequency, and a blank one adds nothing", () => {
    expect(visitMachineLine("Dectro xCell", "  27.12 MHz  ")).toBe("Dectro xCell \u00b7 27.12 MHz");
    expect(visitMachineLine("Dectro xCell", "   ")).toBe("Dectro xCell");
  });
  it("no frequency, or no machine", () => {
    expect(visitMachineLine("Dectro xCell", "")).toBe("Dectro xCell");
    expect(visitMachineLine("Dectro xCell", null)).toBe("Dectro xCell");
    expect(visitMachineLine(null, "27.12 MHz")).toBeNull();
  });
});
