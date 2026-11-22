import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { recordOpsAlert } from "@/lib/ops/alerts";

// The ONE server resolver for the platform rollout of xCell MultiPlex and New view. The mode (off, pilot,
// all) and the pilot list are set by an authorized Hone admin in /admin/rollouts; nothing here reads an environment variable.
//
// * READ PER REQUEST, NEVER CACHED: nothing is memoized across calls, and the read is an rpc (a POST), which a framework never caches.
// * FAILS CLOSED: a missing studio id is off; a failed or malformed read is "error", which every DISPLAY treats as off. A NEW-SETUP route gate
//   must NOT degrade on "error" (it would save a new setup under the legacy machine): it refuses with a retryable message instead.
// * A failed read raises a rate-limited ops alert so an outage is not silently "off".

export const CHARTING_ROLLOUT_KEY = "charting_new_view_xcell";
export type RolloutRead = "on" | "off" | "error";

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string } | null }>;
export type RolloutDeps = { rpc?: Rpc; alert?: (message: string) => void; now?: () => number };

const ALERT_EVERY_MS = 5 * 60 * 1000;
let lastAlertAt = 0; // per server instance: at most one alert per window, best effort

function defaultAlert(message: string): void {
  void recordOpsAlert({ severity: "warning", event: "platform_rollout_read_failed", message, safeDetails: { rollout: CHARTING_ROLLOUT_KEY } }).catch(() => undefined);
}

export async function readChartingRollout(studioId: string | null | undefined, deps: RolloutDeps = {}): Promise<RolloutRead> {
  if (typeof studioId !== "string" || studioId.length === 0) return "off";
  const now = deps.now ?? Date.now;
  const alert = deps.alert ?? defaultAlert;
  try {
    const rpc: Rpc = deps.rpc ?? ((fn, args) => createAdminClient().rpc(fn, args) as unknown as ReturnType<Rpc>);
    const { data, error } = await rpc("platform_rollout_enabled_for", { p_key: CHARTING_ROLLOUT_KEY, p_studio: studioId });
    if (error || typeof data !== "boolean") throw new Error(error?.message ? "rollout read failed" : "rollout read returned an unexpected value");
    return data ? "on" : "off";
  } catch {
    const t = now();
    if (t - lastAlertAt >= ALERT_EVERY_MS) {
      lastAlertAt = t;
      alert("The platform rollout could not be read; New view and the xCell offer are hidden until it can.");
    }
    return "error";
  }
}

/** For DISPLAY and for offers: true only when the rollout is on for this studio; an error is off. */
export async function chartingRolloutFor(studioId: string | null | undefined, deps: RolloutDeps = {}): Promise<boolean> {
  return (await readChartingRollout(studioId, deps)) === "on";
}

/** Test seam: forget the alert window. */
export function resetRolloutAlertWindowForTests(): void {
  lastAlertAt = 0;
}

/**
 * The NEW-SETUP route gate. An EXISTING MultiPlex block keeps its route whatever the rollout says (re-saving it while off keeps its
 * saved identity). Otherwise: on = offer it, off = do not, error = REFUSE with a retryable message. It never degrades to the legacy machine.
 */
export function xcellRouteDecision(o: { existingBlockUsesXcellPur: boolean; rollout: RolloutRead }): "offer" | "hide" | "refuse" {
  if (o.existingBlockUsesXcellPur) return "offer";
  if (o.rollout === "on") return "offer";
  if (o.rollout === "off") return "hide";
  return "refuse";
}

export const ROLLOUT_UNAVAILABLE_MESSAGE = "We could not check whether this is available right now. Please try again in a moment.";
