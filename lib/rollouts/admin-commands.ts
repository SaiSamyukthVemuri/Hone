import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { CHARTING_ROLLOUT_KEY } from "@/lib/rollouts/charting-rollout";

// The admin-side commands for the platform rollout. They call the service-role-only database commands, which write the audit row in the same
// transaction. The ACTOR (user id and email) is a parameter the SERVER ACTION fills from the authenticated session after isAdmin; nothing here
// reads a request. Callers never pass free text: modes and ids only.

/** The phrase an operator must type to turn the rollout on for every studio. Enforced in the server action. */
export const ALL_CONFIRM_PHRASE = "ALL STUDIOS";
export const ROLLOUT_MODES = ["off", "pilot", "all"] as const;
export type RolloutMode = (typeof ROLLOUT_MODES)[number];
export type Actor = { userId: string; email: string };
export type RolloutRpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string } | null }>;

const defaultRpc: RolloutRpc = (fn, args) => createAdminClient().rpc(fn, args) as unknown as ReturnType<RolloutRpc>;

async function call(rpc: RolloutRpc, fn: string, args: Record<string, unknown>): Promise<string | null> {
  try {
    const { data, error } = await rpc(fn, args);
    return !error && typeof data === "string" ? data : null;
  } catch {
    return null;
  }
}

export const setRolloutMode = (mode: RolloutMode, actor: Actor, rpc: RolloutRpc = defaultRpc) =>
  call(rpc, "set_platform_rollout_mode", { p_key: CHARTING_ROLLOUT_KEY, p_mode: mode, p_actor_user_id: actor.userId, p_actor_email: actor.email });
export const addPilotStudio = (studioId: string, actor: Actor, rpc: RolloutRpc = defaultRpc) =>
  call(rpc, "add_platform_rollout_studio", { p_key: CHARTING_ROLLOUT_KEY, p_studio: studioId, p_actor_user_id: actor.userId, p_actor_email: actor.email });
export const removePilotStudio = (studioId: string, actor: Actor, rpc: RolloutRpc = defaultRpc) =>
  call(rpc, "remove_platform_rollout_studio", { p_key: CHARTING_ROLLOUT_KEY, p_studio: studioId, p_actor_user_id: actor.userId, p_actor_email: actor.email });
/** A signed-in NON-admin's attempt: user id only, de-duplicated inside the command. Never throws. */
export async function logBlockedAttempt(userId: string, action: "platform_rollout_mode_set" | "platform_rollout_studio_added" | "platform_rollout_studio_removed", rpc: RolloutRpc = defaultRpc): Promise<void> {
  try {
    await rpc("log_refused_platform_rollout_attempt", { p_actor_user_id: userId, p_action: action });
  } catch {
    /* a failed audit write of a REFUSED attempt never changes the refusal */
  }
}
