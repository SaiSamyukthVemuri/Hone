import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  presetConfirmControl,
  settlePendingPreset,
} from "@/lib/availability/preset-state";

// AVAIL-PRESET-01. A preset chosen while the previous save is still finishing
// must survive that save's completion. The component could not be rendered
// here (no DOM in this suite), so the interleaving is driven through the same
// pure transition the component uses, and a source contract pins that the
// component really routes its clear through it.

const A = { id: "weekdays-9-5" };
const B = { id: "weekdays-10-6" };

describe("settling a preset save", () => {
  it("clears the confirmation panel when the settled preset is still the pending one", () => {
    expect(settlePendingPreset(A, A)).toBeNull();
  });

  it("the interleaving: confirm A, choose B while A is saving, A settles => B stays pending", () => {
    let pending: typeof A | null = null;
    pending = A; // request A
    const confirmed = pending; // Replace clicked: the save captures A
    pending = B; // user picks B while A's save is in flight
    pending = settlePendingPreset(pending, confirmed); // A's save finishes
    expect(pending).toBe(B);
  });

  it("a refused save of A does not discard B either", () => {
    expect(settlePendingPreset(B, A)).toBe(B);
  });

  it("nothing pending stays nothing", () => {
    expect(settlePendingPreset(null, A)).toBeNull();
  });
});

describe("AvailabilityClient routes both settle paths through it", () => {
  const SRC = readFileSync(
    join(process.cwd(), "app/(app)/settings/availability/AvailabilityClient.tsx"),
    "utf8",
  );
  const confirm = SRC.slice(
    SRC.indexOf("function confirmApplyPreset"),
    SRC.indexOf("const openDaysForCopy"),
  );

  it("the confirm function is the slice under test", () => {
    expect(confirm.length).toBeGreaterThan(300);
  });

  it("never clears the pending preset unconditionally after a save", () => {
    expect(confirm).not.toMatch(/setPendingPreset\(null\)/);
  });

  it("clears it only if it is still the confirmed one, on success and on error", () => {
    const uses = confirm.match(/setPendingPreset\(\(cur\) => settlePendingPreset\(cur, preset\)\)/g) ?? [];
    expect(uses).toHaveLength(2);
  });
});

describe("the confirm button follows the save in flight, not the panel", () => {
  it("nothing in flight: Replace, enabled", () => {
    expect(presetConfirmControl(A, null, false)).toEqual({ label: "Replace", disabled: false });
  });

  it("the panel shows the preset being saved: Applying…, disabled", () => {
    expect(presetConfirmControl(A, A, false)).toEqual({ label: "Applying…", disabled: true });
  });

  it("the panel shows B while A saves: it does not claim B is applying, and waits", () => {
    expect(presetConfirmControl(B, A, false)).toEqual({ label: "Replace", disabled: true });
  });

  it("after A settles B is offered again, enabled", () => {
    expect(presetConfirmControl(B, null, false)).toEqual({ label: "Replace", disabled: false });
  });

  it("a day-hours save in flight blocks a preset save", () => {
    expect(presetConfirmControl(A, null, true)).toEqual({ label: "Replace", disabled: true });
  });
});

describe("AvailabilityClient wires the in-flight preset and the cross-save guards", () => {
  const SRC = readFileSync(
    join(process.cwd(), "app/(app)/settings/availability/AvailabilityClient.tsx"),
    "utf8",
  );
  const confirm = SRC.slice(
    SRC.indexOf("function confirmApplyPreset"),
    SRC.indexOf("const replaceControl"),
  );

  it("records the preset being saved before the transition and clears it only if still that one, in finally", () => {
    expect(confirm).toMatch(/setApplyingPreset\(preset\);\s*startPresetTransition/);
    expect(confirm).toMatch(/finally \{\s*setApplyingPreset\(\(cur\) => settlePendingPreset\(cur, preset\)\);/);
  });

  it("the Replace button takes its label and disabled state from presetConfirmControl", () => {
    expect(SRC).toMatch(/disabled=\{replaceControl\.disabled\}/);
    expect(SRC).toMatch(/\{replaceControl\.label\}/);
    expect(SRC).not.toMatch(/presetPending \? "Applying…"/);
  });

  it("the day editor's Save is disabled while a preset saves", () => {
    expect(SRC).toMatch(/saving=\{savingDow === editingDow \|\| presetPending\}/);
  });
});
