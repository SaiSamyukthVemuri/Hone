/**
 * THE OWNER'S xCELL SWITCH, READ FROM THE DATABASE.
 *
 * `get_studio_machine_choices()` runs as the SIGNED-IN user and returns, for the caller's own studios, EVERY machine model with its switch
 * (`enabled`), and only while the platform rollout is on for that studio. So:
 *   - no row for the studio  -> the switch is UNAVAILABLE here (rollout off, a failed read, or a deploy ahead of the migration): the studio
 *     keeps exactly the route it had before, and nothing is guessed;
 *   - rows for the studio and the xCell's is ON -> available and ON;
 *   - rows for the studio and the xCell's is OFF (the owner opted out) -> available and OFF: xCell is not offered. When every model is off the
 *     answer is still "available", which is how the chart can tell "nothing enabled" from "unavailable".
 * It never throws: every failure is "unavailable", which is the old behaviour.
 */
export type XcellModelSwitch = { available: false } | { available: true; enabled: boolean };

const XCELL_PUR = "dectro-apilus:xcell-pur";

type Rpc = (fn: string) => PromiseLike<{ data: unknown; error: unknown }>;
export type SwitchDeps = { rpc?: Rpc };

export async function readXcellModelSwitch(studioId: string, deps: SwitchDeps = {}): Promise<XcellModelSwitch> {
  if (typeof studioId !== "string" || studioId.length === 0) return { available: false };
  try {
    let rpc = deps.rpc;
    if (!rpc) {
      const { studioMachineRpc } = await import("@/lib/machines/studio-machine-rpc");
      rpc = (fn) => studioMachineRpc(fn);
    }
    const { data, error } = await rpc("get_studio_machine_choices");
    if (error || !Array.isArray(data)) return { available: false };
    const mine = data.filter((r): r is { studio_id: string; profile_id: string; enabled?: unknown } => !!r && typeof r === "object" && (r as { studio_id?: unknown }).studio_id === studioId);
    if (mine.length === 0) return { available: false };
    return { available: true, enabled: mine.some((r) => r.profile_id === XCELL_PUR && r.enabled === true) };
  } catch {
    return { available: false };
  }
}
