import { describe, expect, it } from "vitest";

import { restoreSelectionFromRecordedSetup } from "@/lib/machines/restore-recorded-selection";
import { restoredSelection } from "@/lib/machines/selection-state";
import { SYNTHETIC_DEMO_PROFILE } from "@/lib/machines/synthetic-profile";
import type { RecordedReading } from "@/lib/machines/machine-queries";
import type { StudioDevice } from "@/lib/machines/selection";

// HON-8 reload continuity: a reopened visit comes back on the machine and mode
// its LAST SAVED capture used, not on whatever the practitioner happens to have
// remembered since. Current schema: every recorded reading already carries its
// unit (studio_machine_id), mode and capture.

const scope = { studioId: "studio-1", practitionerId: "pract-1" };
const profile = SYNTHETIC_DEMO_PROFILE;
const catalogue = [profile];
const mode = profile.modes.find((m) => m.availability === "active")!;

function device(over: Partial<StudioDevice> = {}): StudioDevice {
  return {
    deviceId: "dev-a",
    studioId: "studio-1",
    profileId: profile.profileId,
    profileVersion: profile.version,
    displayName: "Room 1 unit",
    installedOptions: [],
    retiredAt: null,
    ...over,
  };
}

function reading(over: Partial<RecordedReading> = {}): RecordedReading {
  return {
    blockId: "block-1",
    captureId: "cap-1",
    revision: 1,
    deviceId: "dev-a",
    profileId: profile.profileId,
    profileVersion: profile.version,
    modeKey: mode.key,
    groupKey: "g",
    channels: [],
    stageKey: null,
    fieldKey: "f",
    value: { kind: "numeric", value: 1 },
    nativeUnit: "u",
    decimals: 0,
    observationSource: null,
    recordedAt: "2026-10-29T10:00:00Z",
    ...over,
  } as RecordedReading;
}

const run = (rows: RecordedReading[], devices = [device()]) =>
  restoreSelectionFromRecordedSetup({ scope, recordedSetup: rows, devices, catalogue });

describe("restoreSelectionFromRecordedSetup", () => {
  it("restores the unit and mode of the last saved capture", () => {
    expect(run([reading()])).toEqual({ deviceId: "dev-a", modeKey: mode.key });
  });

  it("uses the LATEST capture when a block was saved more than once", () => {
    const rows = [
      reading({ captureId: "cap-1", revision: 1, deviceId: "dev-a", recordedAt: "2026-10-29T10:00:00Z" }),
      reading({ captureId: "cap-2", revision: 2, deviceId: "dev-b", recordedAt: "2026-10-29T10:05:00Z" }),
    ];
    const devices = [device(), device({ deviceId: "dev-b", displayName: "Room 2 unit" })];
    expect(run(rows, devices)?.deviceId).toBe("dev-b");
  });

  it("restores nothing when the last capture spans units or modes (no guessing)", () => {
    expect(run([reading(), reading({ deviceId: "dev-b" })], [device(), device({ deviceId: "dev-b" })])).toBeNull();
    expect(run([reading(), reading({ modeKey: "other-mode" })])).toBeNull();
  });

  it("restores nothing for a retired unit, another studio's unit, or an inactive mode", () => {
    expect(run([reading()], [device({ retiredAt: "2026-10-01T00:00:00Z" })])).toBeNull();
    expect(run([reading()], [device({ studioId: "studio-2" })])).toBeNull();
    expect(run([reading({ modeKey: "no-such-mode" })])).toBeNull();
  });

  it("restores nothing without recorded rows", () => {
    expect(run([])).toBeNull();
  });
});

describe("restoredSelection state", () => {
  it("selects the restored unit but leaves the STORED fact as the practitioner's own", () => {
    expect(restoredSelection("dev-a", "dev-z")).toEqual({
      selected: "dev-a",
      persisted: "dev-z",
      note: null,
    });
    expect(restoredSelection("dev-a", null).persisted).toBeNull();
  });
});
