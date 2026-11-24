/**
 * THE OWNER'S xCELL SWITCH, READ FROM THE DATABASE.
 *
 * `get_studio_machine_choices()` runs as the SIGNED-IN user and returns, for the caller's own studios, only the machine models that are ON,
 * and only while the platform rollout is on for that studio. So:
 *   - no row for the studio  -> the switch is UNAVAILABLE here (rollout off, nothing enabled, a failed read, or a deploy ahead of the
 *     migration): the studio keeps exactly the route it had before, and nothing is guessed;
 *   - a row for the studio, and one of them is the xCell -> available and ON;
 *   - rows for the studio but none is the xCell -> available and OFF (the owner opted out, or never opted in): xCell is not offered.
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
      const { createClient } = await import("@/lib/supabase/server");
      const db = await createClient();
      rpc = (fn) => db.rpc(fn as never) as unknown as ReturnType<Rpc>;
    }
    const { data, error } = await rpc("get_studio_machine_choices");
    if (error || !Array.isArray(data)) return { available: false };
    const mine = data.filter((r): r is { studio_id: string; profile_id: string } => !!r && typeof r === "object" && (r as { studio_id?: unknown }).studio_id === studioId);
    if (mine.length === 0) return { available: false };
    return { available: true, enabled: mine.some((r) => r.profile_id === XCELL_PUR) };
  } catch {
    return { available: false };
  }
}
