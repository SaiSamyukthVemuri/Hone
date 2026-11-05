import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { validateClientLastMachine } from "@/lib/machines/client-last-machine";
import type { MachineProfile } from "@/lib/machines/profile-contract";
import type { StudioDevice } from "@/lib/machines/selection";

// Privacy EL-2 (a, b), Insurance N-5, N-6, N-7 (#1369): the client's last machine is read per client, from live visits only, and is
// validated like any other choice before it is offered.
const mode = (key: string, availability: "active" | "blocked" = "active") => ({
  key, nativeLabel: key, family: "galvanic", availability, verification: "device-confirmed", evidence: ["p"], stages: [], fields: [],
});
const PROFILE = {
  profileId: "fixture:last", version: 1, family: "S", manufacturer: "F", model: "L", availability: "active", verification: "device-confirmed",
  frequency: { kind: "not-applicable" }, evidence: [{ id: "p", kind: "studio-device-photo", consultedOn: "2026-10-12", establishes: "x" }], openQuestions: [],
  channels: { count: 1, nativeLabel: "Channel", associationRequired: false, supportsDistinctSettingGroups: false, verification: "device-confirmed", evidence: ["p"] },
  modes: [mode("flash"), mode("blend"), mode("retired", "blocked")],
} as unknown as MachineProfile;
const DEVICE: StudioDevice = { deviceId: "u1", studioId: "st", profileId: "fixture:last", profileVersion: 1, displayName: "Unit", installedOptions: [], retiredAt: null };
const scope = { studioId: "st", practitionerId: "pr" };
const base = { scope, devices: [DEVICE], catalogue: [PROFILE], legacyProfileId: "dectro-apilus:xcell" };

describe("validateClientLastMachine", () => {
  it("EL-2b: a saved mode that is one of the unit's active modes is kept", () => {
    expect(validateClientLastMachine({ ...base, last: { profileId: "fixture:last", deviceId: "u1", modeKey: "blend" } })).toEqual({ deviceId: "u1", modeKey: "blend", legacy: false });
  });
  it("EL-2b: an unknown or inactive mode falls back to null (the unit's first active mode), never reaches the panel", () => {
    for (const modeKey of ["nope", "retired", null]) {
      expect(validateClientLastMachine({ ...base, last: { profileId: "fixture:last", deviceId: "u1", modeKey } })).toEqual({ deviceId: "u1", modeKey: null, legacy: false });
    }
  });
  it("a unit the picker would refuse (retired, other studio) is dropped", () => {
    expect(validateClientLastMachine({ ...base, devices: [{ ...DEVICE, retiredAt: "2026-01-01" }], last: { profileId: "fixture:last", deviceId: "u1", modeKey: "flash" } })).toBeNull();
    expect(validateClientLastMachine({ ...base, last: { profileId: "fixture:last", deviceId: "other", modeKey: "flash" } })).toBeNull();
  });
  it("the existing workflow is offered only when that is the client's last model; nothing for no history", () => {
    expect(validateClientLastMachine({ ...base, last: { profileId: "dectro-apilus:xcell", deviceId: null, modeKey: null } })).toEqual({ deviceId: null, modeKey: null, legacy: true });
    expect(validateClientLastMachine({ ...base, legacyProfileId: null, last: { profileId: "dectro-apilus:xcell", deviceId: null, modeKey: null } })).toBeNull();
    expect(validateClientLastMachine({ ...base, last: null })).toBeNull();
  });
});

const read = (rel: string) => readFileSync(path.resolve(__dirname, "../../..", rel), "utf8");
describe("the reads and the use are scoped", () => {
  const READ = read("lib/sessions/client-last-machine.ts");
  const CONNECTED = read("components/machines/machine-first-setup-connected.tsx");
  it("N-6: the read is scoped to the client through an inner join on sessions", () => {
    expect(READ).toMatch(/sessions!inner\(client_id\)/);
    expect(READ).toMatch(/\.eq\("sessions\.client_id", clientId\)/);
  });
  it("N-5 / EL-2a: deleted and void sessions, and deleted blocks, are excluded", () => {
    expect(READ).toMatch(/\.is\("sessions\.deleted_at", null\)/);
    expect(READ).toMatch(/\.neq\("sessions\.record_status", "void"\)/);
    expect(READ).toMatch(/\.is\("deleted_at", null\)/);
  });
  it("N-7: only a NEW area (no block yet) takes the client's last machine; an existing identity-less area opens as before", () => {
    expect(CONNECTED).toMatch(/const newAreaLast = !hasSaved && !blockId \?/);
  });
});
