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

/** The owner-facing wording for the studio-wide count, so the copy says what the number is. */
export const expiringSoonLabel = (count: number): string =>
  `${count} ${count === 1 ? "invitation" : "invitations"} across the studio ${count === 1 ? "expires" : "expire"} within 24 hours`;

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
  /**
   * Live invitations across the WHOLE STUDIO that expire within 24 hours, as the server reports them. NOT scoped to the booking window, so it can
   * exceed `active` (which is the live invitations overlapping the window). Informational only; it takes no part in the totals.
   */
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
  // Not clamped to `active`: the two are scoped differently (studio-wide vs the window), so one can legitimately exceed the other.
  const expiringSoon = whole(input.expiringSoon);
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

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/**
 * What the owner is about to send, in three plain lines shown BEFORE the send: the service, the booking window (how many days, and which weekdays)
 * and how many people are selected. Built from the same scope the form posts, so the words cannot describe something other than what is sent.
 */
export function buildScopeSummary(input: {
  serviceName: string;
  windowDays: number;
  allowedWeekdays: readonly number[] | null;
  selected: number;
}): { service: string; window: string; people: string } {
  const days = Math.max(1, whole(input.windowDays));
  const weekdays =
    input.allowedWeekdays && input.allowedWeekdays.length > 0
      ? input.allowedWeekdays.map((d) => WEEKDAY_NAMES[d] ?? "").filter(Boolean).join(", ")
      : "any day";
  return {
    service: `Service: ${input.serviceName}`,
    window: `Booking window: next ${n(days, "day", "days")}, ${weekdays}`,
    people: `People selected: ${whole(input.selected)}`,
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
