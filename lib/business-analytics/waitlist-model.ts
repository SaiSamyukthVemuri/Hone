import { buildInvitationBookingSummary, type CommandCounts, type Count, type InvitationBookingSummary, type OutcomeCounts } from "@/lib/waitlist/invitation-booking-summary";

export const WAITLIST_HORIZONS = [7, 14, 28] as const;
export type WaitlistHorizon = typeof WAITLIST_HORIZONS[number];
export type WaitlistService = { id: string; name: string };
export type WaitingEntry = { status: "waiting" | "claimed" | "invited"; joinedAt: string };
export type WaitingPool = { total: number; waiting: number; claimed: number; invited: number; medianDays: number; longestDays: number };
export type DeliveryCounts = { accepted: Count; refused: Count; unknown: Count; unrecorded: Count };
export type WaitlistAnalyticsView = {
  asOf: string;
  periodStartIso: string;
  timezone: string;
  summary: InvitationBookingSummary;
  booked: Count;
  conversion: { booked: number; invitations: number; percent: number } | null;
  pool: WaitingPool | null;
  delivery: DeliveryCounts;
};

/** These records are the current active pool, not a historical queue or a claim of invitation eligibility. */
export function summarizeWaitingPool(entries: readonly WaitingEntry[], now: Date): WaitingPool | null {
  const ages: number[] = [];
  const counts = { waiting: 0, claimed: 0, invited: 0 };
  for (const entry of entries) {
    const joined = Date.parse(entry.joinedAt);
    if (!Number.isFinite(joined) || joined > now.getTime() || !(entry.status in counts)) return null;
    counts[entry.status]++;
    ages.push((now.getTime() - joined) / 86_400_000);
  }
  ages.sort((a, b) => a - b);
  const middle = Math.floor(ages.length / 2);
  return {
    total: ages.length,
    ...counts,
    medianDays: ages.length === 0 ? 0 : ages.length % 2 ? ages[middle] : (ages[middle - 1] + ages[middle]) / 2,
    longestDays: ages.length === 0 ? 0 : ages[ages.length - 1],
  };
}

/** A conversion is a linked booking, including later cancellations, divided by all issued invitations in the same cohort. */
export function buildWaitlistAnalytics(input: {
  now: Date; timezone: string; periodStartIso: string; command: CommandCounts | null; outcomes: OutcomeCounts;
  pool: WaitingPool | null; delivery: DeliveryCounts;
}): WaitlistAnalyticsView {
  const summary = buildInvitationBookingSummary(input);
  const { command, outcomes } = input;
  const partition = [outcomes.declined, outcomes.linkUsed, outcomes.expiredRecorded, outcomes.released, outcomes.open, outcomes.deadlinePassed];
  const coherent = command !== null && outcomes.total === command.invitationsTotal && !summary.inconsistent &&
    partition.every((n) => n !== null) && (partition as number[]).reduce((a, b) => a + b, 0) === command.invitationsTotal &&
    command.peopleInvited <= command.invitationsTotal &&
    command.bookedLinkedLive + command.bookedThenCancelled + command.convertedUnlinked <= (outcomes.linkUsed ?? -1);
  const booked = command ? command.bookedLinkedLive + command.bookedThenCancelled : 0;
  return {
    asOf: input.now.toISOString(), periodStartIso: input.periodStartIso, timezone: input.timezone, summary,
    booked: coherent ? booked : null,
    conversion: coherent && command.invitationsTotal > 0 ? { booked, invitations: command.invitationsTotal, percent: booked / command.invitationsTotal * 100 } : null,
    pool: input.pool, delivery: input.delivery,
  };
}

export function parseWaitlistParams(raw: Record<string, string | string[] | undefined>, services: readonly WaitlistService[]) {
  const notices: string[] = [];
  const day = typeof raw.days === "string" ? Number(raw.days) : NaN;
  const days: WaitlistHorizon = WAITLIST_HORIZONS.includes(day as WaitlistHorizon) ? day as WaitlistHorizon : 7;
  if (raw.days !== undefined && !WAITLIST_HORIZONS.includes(day as WaitlistHorizon)) notices.push("Choose 7, 14 or 28 days. The next 7 days are shown.");
  let serviceId: string | null = services[0]?.id ?? null;
  if (raw.service !== undefined) {
    serviceId = typeof raw.service === "string" && services.some((s) => s.id === raw.service) ? raw.service : null;
    if (!serviceId) notices.push("Choose an available consultation service to see capacity.");
  }
  return { days, serviceId, notices };
}
