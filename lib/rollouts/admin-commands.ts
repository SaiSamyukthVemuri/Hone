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
export type RolloutRpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string; code?: string } | null }>;

/**
 * WHAT HAPPENED TO A COMMAND, in three kinds, because "it failed" is not one thing:
 *   ok       the database ran the command and answered with its result string.
 *   refused  the database ran the command and REFUSED it with an error it raises itself, so the statement rolled back: nothing changed.
 *   unknown  anything else: a thrown call, a timeout, a gateway or connection error, or an answer that is not the expected string. The command may
 *            have COMMITTED with its answer lost on the way back, so the rollout may now be in the new state. Callers must never say "nothing
 *            changed" for this kind.
 */
export type RolloutOutcome = { kind: "ok"; value: string } | { kind: "refused" } | { kind: "unknown" };

// SQLSTATE classes the commands themselves can raise before changing anything (22 data, 23 integrity/check, 42 privilege or syntax, P0 raised in PL/pgSQL).
// A code from any other class (08 connection, 53 resources, 57 operator, 58 system, XX internal) or no code at all says nothing about whether the
// statement committed, so it is UNKNOWN.
const REFUSAL_CLASSES = /^(22|23|42|P0)[0-9A-Z]{3}$/;

export const defaultRpc: RolloutRpc = (fn, args) => createAdminClient().rpc(fn, args) as unknown as ReturnType<RolloutRpc>;

export async function call(rpc: RolloutRpc, fn: string, args: Record<string, unknown>): Promise<RolloutOutcome> {
  try {
    const { data, error } = await rpc(fn, args);
    if (error) return typeof error.code === "string" && REFUSAL_CLASSES.test(error.code) ? { kind: "refused" } : { kind: "unknown" };
    return typeof data === "string" ? { kind: "ok", value: data } : { kind: "unknown" };
  } catch {
    return { kind: "unknown" };
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
