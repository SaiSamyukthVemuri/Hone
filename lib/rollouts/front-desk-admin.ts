import "server-only";
import { call, defaultRpc, type Actor, type RolloutOutcome, type RolloutRpc } from "@/lib/rollouts/admin-commands";

// Platform-admin commands for the Front Desk (0390). The switch is the existing platform rollout under the key 'front_desk', limited by the database
// to modes off and pilot, so no operator click can turn it on for every studio. A studio is "on" when the key is in pilot mode and the studio is listed.
// The ACTOR is a parameter the server action fills from the authenticated admin session after isAdmin; nothing here reads a request. A grant or
// revoke REASON travels to the database and is stored on the grant row only: it is never logged, never put in a notice and never returned to an owner.

export const FRONT_DESK_ROLLOUT_KEY = "front_desk";
export const SEAT_SOURCES = ["plan_included", "custom_agreed", "pilot"] as const;
export type SeatSource = (typeof SEAT_SOURCES)[number];
export const REASON_MAX = 500;

export const setFrontDeskKeyPilot = (actor: Actor, rpc: RolloutRpc = defaultRpc): Promise<RolloutOutcome> =>
  call(rpc, "set_platform_rollout_mode", { p_key: FRONT_DESK_ROLLOUT_KEY, p_mode: "pilot", p_actor_user_id: actor.userId, p_actor_email: actor.email });
export const enableFrontDeskForStudio = (studioId: string, actor: Actor, rpc: RolloutRpc = defaultRpc) =>
  call(rpc, "add_platform_rollout_studio", { p_key: FRONT_DESK_ROLLOUT_KEY, p_studio: studioId, p_actor_user_id: actor.userId, p_actor_email: actor.email });
export const disableFrontDeskForStudio = (studioId: string, actor: Actor, rpc: RolloutRpc = defaultRpc) =>
  call(rpc, "remove_platform_rollout_studio", { p_key: FRONT_DESK_ROLLOUT_KEY, p_studio: studioId, p_actor_user_id: actor.userId, p_actor_email: actor.email });

/** Grant answers with the new grant's id (a uuid string). */
export const grantFrontDeskSeats = (
  a: { studioId: string; seats: number; source: SeatSource; reason: string; expiresAt: string | null },
  actor: Actor,
  rpc: RolloutRpc = defaultRpc,
) =>
  call(rpc, "admin_grant_front_desk_seats", {
    p_studio_id: a.studioId, p_seats: a.seats, p_source: a.source, p_reason: a.reason, p_expires_at: a.expiresAt,
    p_actor_user_id: actor.userId, p_actor_email: actor.email,
  });

/** Revoke answers with jsonb, not a string, so it reads its own result. Same three outcomes as the other commands. */
export async function revokeFrontDeskSeats(
  a: { seatId: string; reason: string },
  actor: Actor,
  rpc: RolloutRpc = defaultRpc,
): Promise<{ kind: "ok"; status: string; seatsOverLimit: number } | { kind: "refused" } | { kind: "unknown" }> {
  try {
    const { data, error } = await rpc("admin_revoke_front_desk_seats", {
      p_seat_id: a.seatId, p_reason: a.reason, p_actor_user_id: actor.userId, p_actor_email: actor.email,
    });
    if (error) return typeof error.code === "string" && /^(22|23|42|P0)[0-9A-Z]{3}$/.test(error.code) ? { kind: "refused" } : { kind: "unknown" };
    const d = data as { status?: unknown; seats_over_limit?: unknown } | null;
    if (!d || typeof d.status !== "string") return { kind: "unknown" };
    return { kind: "ok", status: d.status, seatsOverLimit: typeof d.seats_over_limit === "number" ? d.seats_over_limit : 0 };
  } catch {
    return { kind: "unknown" };
  }
}

export type FrontDeskListing = {
  switchOn: boolean; seatLimit: number; seatsActive: number; seatsReserved: number; seatsOverLimit: number;
  seats: { id: string; seats: number; source: string; reason: string; grantedAt: string; expiresAt: string | null; state: "live" | "expired" | "revoked" }[];
};

export function parseFrontDeskListing(data: unknown): FrontDeskListing | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" ? v : null);
  if (typeof d.switch_on !== "boolean" || n(d.seat_limit) === null || n(d.seats_active) === null || n(d.seats_reserved) === null || n(d.seats_over_limit) === null || !Array.isArray(d.seats)) return null;
  const seats: FrontDeskListing["seats"] = [];
  for (const g of d.seats as Record<string, unknown>[]) {
    if (typeof g.id !== "string" || typeof g.seats !== "number" || typeof g.source !== "string" || typeof g.granted_at !== "string") return null;
    if (g.state !== "live" && g.state !== "expired" && g.state !== "revoked") return null;
    seats.push({ id: g.id, seats: g.seats, source: g.source, reason: typeof g.reason === "string" ? g.reason : "", grantedAt: g.granted_at, expiresAt: typeof g.expires_at === "string" ? g.expires_at : null, state: g.state });
  }
  return { switchOn: d.switch_on, seatLimit: d.seat_limit as number, seatsActive: d.seats_active as number, seatsReserved: d.seats_reserved as number, seatsOverLimit: d.seats_over_limit as number, seats };
}
