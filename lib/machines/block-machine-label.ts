import { machineModelLabel } from "./display-name";
import { selectableDevices, type SelectionScope, type StudioDevice } from "./selection";
import type { MachineProfile } from "./profile-contract";

/**
 * The machine a SAVED block carries, as a label for the New view's "This visit" row. Used where the block's own editor is not open (the
 * add-pass form inherits the block's machine). DISPLAY ONLY.
 *   - a saved unit that is live on an active profile at its published version: the model's display label (the picker's own);
 *   - a saved unit that is retired or unavailable: its name, as no longer available;
 *   - the existing xCell saved without a unit: the picker's own label for it;
 *   - nothing saved: null.
 */
export function savedBlockMachineLabel(
  block: { studio_machine_id: string | null; machine_profile_id: string | null },
  ctx: {
    scope: SelectionScope | null;
    devices: readonly StudioDevice[];
    catalogue: readonly MachineProfile[];
    legacyMachine: { label: string } | null;
    unitNames?: Readonly<Record<string, string>>;
  },
): string | null {
  if (block.studio_machine_id) {
    const live = ctx.scope ? selectableDevices(ctx.scope, [...ctx.devices], [...ctx.catalogue]).find((s) => s.device.deviceId === block.studio_machine_id) : undefined;
    if (live) return machineModelLabel(live.profile);
    return `${ctx.unitNames?.[block.studio_machine_id] ?? "Saved machine"} (no longer available)`;
  }
  if (block.machine_profile_id && ctx.legacyMachine) return ctx.legacyMachine.label;
  return null;
}
