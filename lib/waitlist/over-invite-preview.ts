// The owner's preview for inviting MORE people than the estimate says will fit (pure: no reads, no writes).
//
// The app is the single availability authority: `fit` always comes from computeConsultationFit on the server (the
// slot engine, real durations, overlap counted once), never from the browser. This module only turns the numbers
// the server already holds into the preview and its exact words. It decides nothing about who may send.

/** The agreed owner wording. Pinned verbatim by a test. */
export const OVER_INVITE_OWNER_COPY = "Invitations do not reserve appointments. Some clients may find no availability.";

/** The agreed client wording, shown on the invitation page. Pinned verbatim by a test. */
export const OVER_INVITE_CLIENT_COPY =
  "Choose from current availability. Appointment times are not reserved and may fill before your invitation expires.";

export type ExpiringInvitation = { expiresAt: string };

/**
 * How many LIVE invitations expire within `horizonHours` from `now` (inclusive at the horizon, exclusive at `now` itself and of anything
 * already past). Callers pass only invitations that are still valid (sent, unexpired, unredeemed, unreleased).
 */
export function countUpcomingExpirations(
  invitations: readonly ExpiringInvitation[],
  now: Date,
  horizonHours: number,
): number {
  const from = now.getTime();
  const to = from + Math.max(0, horizonHours) * 3_600_000;
  let n = 0;
  for (const i of invitations) {
    const t = Date.parse(i.expiresAt);
    if (Number.isFinite(t) && t > from && t <= to) n += 1;
  }
  return n;
}

export type OverInvitePreview = {
  /** Estimated appointments that fit the window (overlap counted once, from the server). */
  fit: number;
  /** Still-valid invitations already out. */
  active: number;
  /** Invitations that will expire soon (informational; they are still counted in `active`). */
  expiringSoon: number;
  /** The extra the owner proposes to send now. */
  extra: number;
  /** active + extra. */
  resultingTotal: number;
  /** True when the resulting total is more than the estimate: the override case. */
  beyondCapacity: boolean;
  /** "5 estimated appointments available · 8 invitations active · Send 10 more → 18 active invitations" */
  line: string;
  ownerCopy: string;
};

const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const whole = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);

export function buildOverInvitePreview(input: {
  fit: number;
  active: number;
  expiringSoon: number;
  extra: number;
}): OverInvitePreview {
  const fit = whole(input.fit);
  const active = whole(input.active);
  const extra = whole(input.extra);
  const expiringSoon = Math.min(whole(input.expiringSoon), active);
  const resultingTotal = active + extra;
  return {
    fit,
    active,
    expiringSoon,
    extra,
    resultingTotal,
    beyondCapacity: resultingTotal > fit,
    line:
      `${n(fit, "estimated appointment", "estimated appointments")} available · ` +
      `${n(active, "invitation", "invitations")} active · ` +
      `Send ${extra} more → ${n(resultingTotal, "active invitation", "active invitations")}`,
    ownerCopy: OVER_INVITE_OWNER_COPY,
  };
}

/**
 * Did anything the owner SAW change materially before the send? Compared on the three numbers the preview shows.
 * Any difference in fit or active count (or a changed extra) is material: the owner confirms again on the new numbers.
 */
export function isMaterialChange(
  shown: Pick<OverInvitePreview, "fit" | "active" | "extra">,
  fresh: Pick<OverInvitePreview, "fit" | "active" | "extra">,
): boolean {
  return shown.fit !== fresh.fit || shown.active !== fresh.active || shown.extra !== fresh.extra;
}
