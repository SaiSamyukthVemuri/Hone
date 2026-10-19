import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { APILUS_3G_PROFILES } from "../../lib/machines/apilus-3g";
import { MACHINE_CATALOGUE } from "../../lib/machines/catalogue";
import { modeFields } from "../../lib/machines/profile-contract";
import { nativeFieldGroups } from "../../lib/machines/charting";
import { firstGroup, draftKey } from "../../lib/machines/setting-groups";
import { SettingDraftFields } from "../../components/machines/setting-draft-fields";
import { MachinePriorSetup } from "../../components/machines/machine-prior-setup";
import { MachineRecordedSetups } from "../../components/machines/machine-recorded-setups";
import type { RecordedReading } from "../../lib/machines/machine-queries";

describe.each(APILUS_3G_PROFILES)("$model real component static rendering (not browser proof)", (profile) => {
  it.each(profile.modes)("renders $key native controls with exact units, values and precision", (mode) => {
    const groups = firstGroup();
    const fields = nativeFieldGroups(profile, mode);
    for (const fg of fields) for (const f of fg.fields) groups[0].values[draftKey(fg.key, f)] = f.decimals === 3 ? "0.047" : f.decimals === 2 ? "0.27" : f.decimals === 1 ? "1.3" : "7";
    const html = renderToStaticMarkup(createElement(SettingDraftFields, { profile, mode, groups, groupOrdinal: 1, editDraft: () => {}, onAdvanceOrdinal: () => {}, setValue: () => {}, flipChannel: () => {} }));
    expect([...html.matchAll(/type="number"/g)]).toHaveLength(modeFields(mode).length);
    for (const { field } of modeFields(mode)) {
      expect(html).toContain(`data-testid="reading-${field.key}"`);
      expect(html).toContain(field.nativeLabel.replace(/&/g, "&amp;"));
      expect(html).toContain(`step="${field.decimals === 0 ? 1 : 1 / 10 ** field.decimals}"`);
    }
    expect(html).not.toContain('data-testid="reading-preset_number"'); // identifiers must remain text
    expect(html).not.toContain("device-display");
    if (mode.captureHold) expect(html).toContain('data-testid="native-control-pending"');
  });
  it.each(profile.modes)("renders $key history and next-visit reference from supplied v2 rows unchanged", (mode) => {
    // Supplied synthetic rows test display only. No database save, browser
    // reload or next-session RPC is simulated or claimed here.
    const readings: RecordedReading[] = modeFields(mode).map(({ field, stageKey }) => ({
      blockId: "block", deviceId: "device", profileId: profile.profileId,
      profileVersion: 2, modeKey: mode.key, stageKey, fieldKey: field.key,
      nativeUnit: field.unit, decimals: field.decimals, captureId: "capture",
      groupKey: "g1", revision: 1, channels: [], recordedAt: "2026-10-19T00:00:00Z",
      observationSource: field.expectedSource,
      value: { kind: "value", value: field.decimals === 3 ? 0.047 : field.decimals === 2 ? 0.27 : field.decimals === 1 ? 1.3 : 7 },
    }));
    const original = JSON.stringify(readings);
    for (const Component of [MachinePriorSetup, MachineRecordedSetups]) {
      const html = renderToStaticMarkup(createElement(Component, { readings, catalogue: MACHINE_CATALOGUE }));
      for (const reading of readings) {
        const field = modeFields(mode).find(({ field }) => field.key === reading.fieldKey)!.field;
        expect(html).toContain(field.nativeLabel);
        expect(html).toContain(reading.nativeUnit);
        expect(html).toContain((reading.value as { kind: "value"; value: number }).value.toFixed(reading.decimals));
      }
      for (const stage of mode.stages) expect(html).toContain(stage.nativeLabel);
      expect(html).toContain("entered by hand");
    }
    expect(JSON.stringify(readings)).toBe(original);
  });
});

describe("retained Senior v1 next-visit and history rendering", () => {
  const readings: RecordedReading[] = [{
    blockId: "block", deviceId: "device", profileId: "dectro-apilus:senior-3g", profileVersion: 1,
    modeKey: "multiplex", stageKey: "snap", fieldKey: "snap_duration", nativeUnit: "ms", decimals: 0,
    captureId: "capture", groupKey: "g1", revision: 1, channels: [], recordedAt: "2026-10-12T12:00:00Z",
    value: { kind: "value", value: 47 }, observationSource: "practitioner-entered",
  } as RecordedReading];
  it("uses v1 labels and stored ms without conversion despite v2 being current", () => {
    const frozen = JSON.stringify(readings);
    for (const Component of [MachinePriorSetup, MachineRecordedSetups]) {
      const html = renderToStaticMarkup(createElement(Component, { readings, catalogue: MACHINE_CATALOGUE }));
      expect(html).toContain("Duration");
      expect(html).toContain("Snap");
      expect(html).toContain("47");
      expect(html).toContain("ms");
      expect(html).not.toContain("0.047");
      expect(html).not.toContain("MicroFlash pulse");
    }
    expect(JSON.stringify(readings)).toBe(frozen);
  });
});
