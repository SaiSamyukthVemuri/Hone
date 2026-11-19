import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChartingViewContext } from "@/components/charting-view-context";
import { SettingDraftFields } from "@/components/machines/setting-draft-fields";
import { nativeFieldGroups } from "@/lib/machines/charting";
import { firstGroup } from "@/lib/machines/setting-groups";
import { XCELL_PUR_PROFILES } from "@/lib/machines/xcell-pur";
import { APILUS_3G_PROFILES } from "@/lib/machines/apilus-3g";
import type { MachineMode, MachineProfile } from "@/lib/machines/profile-contract";

const html = (view: "current" | "new", profile: MachineProfile, mode: MachineMode) =>
  renderToStaticMarkup(
    createElement(
      ChartingViewContext.Provider,
      { value: { view, setView: () => undefined, notice: null } },
      createElement(SettingDraftFields, { profile, mode, groups: firstGroup(), groupOrdinal: 1, editDraft: () => {}, onAdvanceOrdinal: () => {}, setValue: () => {}, flipChannel: () => {} }),
    ),
  );
const hints = (h: string) => (h.match(/data-testid="new-view-hint-blank"/g) ?? []).length;
const carriesDisplayed = (g: { fields: ReadonlyArray<{ key: string }> }) => g.fields.some((f) => f.key === "displayed_el" || f.key === "displayed_ul");

describe('"Blank stays blank." appears only on field groups that hold displayed_el or displayed_ul', () => {
  const xcell = XCELL_PUR_PROFILES[0];
  const mode = xcell.modes.find((m) => m.key === "multiplex")!;
  const groups = nativeFieldGroups(xcell, mode);
  it("control: the xCell Pur multiplex mode has groups with and without the displayed readings", () => {
    expect(groups.some(carriesDisplayed)).toBe(true);
    expect(groups.some((g) => !carriesDisplayed(g))).toBe(true);
  });
  it("New view: exactly one line per group that carries displayed_el or displayed_ul, and none for the other groups", () => {
    const h = html("new", xcell, mode);
    expect(hints(h)).toBe(groups.filter(carriesDisplayed).length);
    expect(hints(h)).toBeLessThan(groups.length);
    expect(h).toContain("Blank stays blank.");
  });
  it("Current view shows it nowhere", () => {
    expect(html("current", xcell, mode)).not.toContain("Blank stays blank");
  });
  it("a machine whose groups hold neither reading shows it nowhere, even in New view", () => {
    for (const p of APILUS_3G_PROFILES) for (const m of p.modes) {
      const g = nativeFieldGroups(p, m);
      if (g.some(carriesDisplayed)) continue;
      expect(hints(html("new", p, m)), `${p.model} ${m.key}`).toBe(0);
    }
  });
});
