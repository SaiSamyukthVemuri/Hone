import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MACHINE_CATALOGUE } from "../../../lib/machines/catalogue";
import { LEGACY_WORKFLOW_NAME, NATIVE_XCELL_PUR_LABEL, legacyWorkflowLabel, machineDisplayName } from "../../../lib/machines/display-name";
import { LEGACY_MACHINE_PROFILE_ID, legacyMachineOffer } from "../../../lib/machines/legacy-machine";

// Sam's naming decision (18 Nov 2026): keep BOTH xCell workflows, label them clearly, name the workflow in the ambiguous message.
// LABEL-ONLY: no identifier, saved record, setting or history changes. These tests pin the labels, the reworded messages, and that nothing else moved.
const read = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");

describe("the two xCell workflows are labelled apart", () => {
  it("the existing charting is 'Dectro xCell — existing charting', still on the unchanged legacy profile id", () => {
    expect(legacyMachineOffer(MACHINE_CATALOGUE)).toEqual({ profileId: "dectro-apilus:xcell", label: "Dectro xCell — existing charting" });
    expect(LEGACY_MACHINE_PROFILE_ID).toBe("dectro-apilus:xcell");
    expect(LEGACY_WORKFLOW_NAME).toBe("Dectro xCell — existing charting");
  });

  it("the structured charting is 'Apilus xCell Pur — structured charting', on the unchanged native profile id", () => {
    const pur = MACHINE_CATALOGUE.find((p) => p.profileId === "dectro-apilus:xcell-pur")!;
    expect(machineDisplayName(pur)).toBe("Apilus xCell Pur — structured charting");
    expect(NATIVE_XCELL_PUR_LABEL).toBe("Apilus xCell Pur — structured charting");
  });

  it("the two labels are different, and neither is a prefix of the other", () => {
    expect(NATIVE_XCELL_PUR_LABEL).not.toBe(LEGACY_WORKFLOW_NAME);
    expect(NATIVE_XCELL_PUR_LABEL.startsWith(LEGACY_WORKFLOW_NAME)).toBe(false);
    expect(LEGACY_WORKFLOW_NAME.startsWith(NATIVE_XCELL_PUR_LABEL)).toBe(false);
  });

  it("every other profile keeps exactly its previous display name", () => {
    for (const p of MACHINE_CATALOGUE.filter((p) => p.profileId !== "dectro-apilus:xcell-pur")) {
      expect(machineDisplayName(p), `${p.profileId}@${p.version}`).toBe(`${p.manufacturer} ${p.model}${p.variant ? ` (${p.variant})` : ""}`);
    }
  });

  it("the legacy label is derived with a suffix, so the pinned catalogue entry is not edited", () => {
    const entry = MACHINE_CATALOGUE.find((p) => p.profileId === "dectro-apilus:xcell")!;
    expect(legacyWorkflowLabel(entry)).toBe("Dectro xCell — existing charting");
    expect(entry.model).toBe("xCell");
    expect(entry.manufacturer).toBe("Dectro");
  });
});

describe("the ambiguous messages say which workflow holds the saved readings", () => {
  it("the panel's note and the connected host's refusal both name 'Dectro xCell — existing charting'", () => {
    const panel = read("components/machines/machine-first-setup-panel.tsx");
    const host = read("components/machines/machine-first-setup-connected.tsx");
    expect(panel).toContain("This area already has readings saved with {LEGACY_WORKFLOW_NAME}. Add a new area to chart another machine.");
    expect(host).toContain("This area already has readings saved with ${LEGACY_WORKFLOW_NAME}. Add a new area to chart another machine.");
    for (const src of [panel, host]) expect(src).not.toMatch(/already has xCell Pur readings/);
  });
});

describe("label-only: identifiers and saved data are untouched", () => {
  it("the display-name module reads and writes no data and imports nothing but types", () => {
    const src = read("lib/machines/display-name.ts");
    const imports = [...src.matchAll(/^import .*$/gm)].map((m) => m[0]);
    expect(imports).toEqual(['import type { MachineProfile } from "./profile-contract";']);
    expect(src).not.toMatch(/supabase|fetch\(|\.from\(|\.insert\(|\.update\(|\.rpc\(/);
  });

  it("the profile ids, versions and the legacy mode values are exactly as before", () => {
    expect(MACHINE_CATALOGUE.filter((p) => /xcell/i.test(p.profileId)).map((p) => `${p.profileId}@${p.version}`).sort()).toEqual([
      "dectro-apilus:xcell-pur@1", "dectro-apilus:xcell@1",
    ]);
    expect(read("lib/sessions/client-last-machine.ts")).toContain('const LEGACY_MODE_VALUES = ["thermo", "galv", "blend"] as const;');
  });

  it("no label string reaches a saved value: the save and recall code paths do not import the display-name module", () => {
    for (const p of [
      "app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts",
      "app/(app)/clients/[id]/sessions/[sessionId]/machine-setup-actions.ts",
      "lib/sessions/client-last-machine.ts",
    ]) expect(read(p), p).not.toContain("display-name");
  });
});
