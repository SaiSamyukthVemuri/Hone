// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { CopyDraftCard } from "@/components/copy-draft-card";
import { buildTreatmentSetupDraftPatch } from "@/lib/sessions/treatment-setup-snapshot";
import type { CopyAreaDraft } from "@/lib/sessions/whole-session-copy";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A copied GALVANIC area keeps its Energy level when the redesign is on (the server writes it), so the preview must SHOW it, or the practitioner
// reviews a card that hides a value the copy will record. Off: the card is exactly as before. Synthetic records.
const BLOCK = { mode: "galv", apilus_modality: null, energy_level: 14, probe_key: null, machine_frequency: null, probe_lot_number: null, probe_inventory_item_id: null, probe_lot_confirmed: false } as never;
const ENTRY = { mode: "galv", galvanic_ma: 2, galvanic_duration_seconds: 30, units_of_lye: 3, pulse_count: 1, pulse_delay_seconds: null } as never;
const draftFor = (keep: boolean): CopyAreaDraft => ({
  key: "d1", primaryArea: "Chin", side: "center", customAreaDetail: null,
  areas: [{ area: "Chin", laterality: "midline" }] as never,
  setup: buildTreatmentSetupDraftPatch(BLOCK, ENTRY, undefined, { keepGalvanicEnergy: keep }),
  probe: { probe_brand: null, probe_material: null, probe_piece_type: null, probe_shank: null, probe_size_value: null, probe_length: null, probe_label: null },
});

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = host = null; });
async function mount(keep: boolean, patch?: (d: CopyAreaDraft) => CopyAreaDraft) {
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  const d = patch ? patch(draftFor(keep)) : draftFor(keep);
  await act(async () => root!.render(createElement(CopyDraftCard, { draft: d, onChange: () => undefined, onRemove: () => undefined, keepGalvanicEnergy: keep })));
}
const energy = () => host!.querySelector<HTMLInputElement>('[data-testid="copy-draft-d1-energy"]');

describe("the copy preview for a Galvanic area", () => {
  it("rollout ON: the Energy level input is shown with the copied value, and there is no modality select", async () => {
    await mount(true);
    expect(energy()).not.toBeNull();
    expect(energy()!.value).toBe("14");
    expect(host!.querySelector('[data-testid="copy-draft-d1-apilus"]')).toBeNull();
  });
  it("OFF: no Energy level input (exactly as before)", async () => {
    await mount(false);
    expect(energy()).toBeNull();
  });
  it("a thermolysis area shows both either way", async () => {
    for (const keep of [true, false]) {
      await mount(keep, (d) => ({ ...d, setup: { ...d.setup, mode: "thermo", energyLevel: "30" } }));
      expect(energy()!.value).toBe("30");
      expect(host!.querySelector('[data-testid="copy-draft-d1-apilus"]')).not.toBeNull();
      act(() => root?.unmount()); host?.remove(); root = host = null;
    }
  });
});
