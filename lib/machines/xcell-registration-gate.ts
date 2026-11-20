import { chartingRolloutFor, readChartingRollout, type RolloutRead } from "@/lib/rollouts/charting-rollout";

/**
 * Whether this studio may be OFFERED the xCell and may register it. It is the platform rollout (set in the admin control; nothing here reads an
 * environment variable). The studio comes from the authenticated scope, never from a posted value. An error is "not offered" for display.
 */
export async function xcellRegistrationAllowed(studioId: string | null | undefined): Promise<boolean> {
  return chartingRolloutFor(studioId);
}

/** The registration ACTION needs to tell "off" from "could not check" so it can refuse with a retryable message. */
export async function xcellRegistrationState(studioId: string | null | undefined): Promise<RolloutRead> {
  return readChartingRollout(studioId);
}
