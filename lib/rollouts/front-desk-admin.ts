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

/**
 * The admin page shows the outcome of the last action from its own `notice` query parameter. That parameter is user-editable, so only the
 * fixed sentences the actions can produce (and the one counted sentence) are rendered; anything else becomes a generic line. A crafted
 * link therefore cannot put free text on the page.
 */
const FIXED_NOTICES: readonly string[] = [
  "Not authorized.",
  "Choose a studio from the list.",
  "Choose on or off.",
  "That was refused. Nothing changed.",
  "The result is UNKNOWN: the change may or may not have been saved. Reload this page and check before trying again.",
  "That studio was not found.",
  "Already on.",
  "Front desk switched on for this studio.",
  "It was not on.",
  "Front desk switched off for this studio.",
  "Seats must be a whole number from 1 to 50.",
  "Choose where the seats come from.",
  `A reason of 1 to ${REASON_MAX} characters is required.`,
  "Enter the expiry as a date.",
  "The expiry must be in the future.",
  "Seats granted.",
  "Already granted.",
  "Choose a grant from the list.",
  "That grant was not found.",
  "Already revoked.",
  "Revoked.",
];
const OVER_LIMIT_NOTICE = /^Revoked\. [1-9]\d{0,2} receptionists? (is|are) now over the seat limit and cannot use the front desk\. Nothing was deleted\.$/;

export function safeNotice(notice: unknown, ok: boolean): string | null {
  if (typeof notice !== "string" || notice === "") return null;
  if (FIXED_NOTICES.includes(notice) || OVER_LIMIT_NOTICE.test(notice)) return notice;
  return ok ? "Done." : "That did not go through.";
}

/** A grant made this recently with the same seats, source, reason and expiry is the same click arriving twice. */
export const DUPLICATE_GRANT_WINDOW_MS = 60_000;

export function hasRecentIdenticalGrant(
  listing: FrontDeskListing | null,
  a: { seats: number; source: string; reason: string; expiresAt: string | null },
  now: number = Date.now(),
): boolean {
  if (!listing) return false;
  const day = (v: string | null) => (v ? v.slice(0, 10) : null);
  return listing.seats.some(
    (g) =>
      g.state === "live" &&
      g.seats === a.seats &&
      g.source === a.source &&
      g.reason === a.reason &&
      day(g.expiresAt) === day(a.expiresAt) &&
      now - Date.parse(g.grantedAt) >= 0 &&
      now - Date.parse(g.grantedAt) < DUPLICATE_GRANT_WINDOW_MS,
  );
}

/** Reads the studio's grants (service role) and answers whether this exact grant was just made. A read that fails answers false: the database still decides. */
export async function grantAlreadyMade(
  studioId: string,
  a: { seats: number; source: string; reason: string; expiresAt: string | null },
  rpc: RolloutRpc = defaultRpc,
): Promise<boolean> {
  try {
    const { data, error } = await rpc("admin_list_front_desk", { p_studio_id: studioId });
    if (error) return false;
    return hasRecentIdenticalGrant(parseFrontDeskListing(data), a);
  } catch {
    return false;
  }
}
