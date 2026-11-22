import type { FollowUpList } from "@/lib/waitlist/followups-owner";

// DECLINE VISIBILITY. PURE: no I/O, no clock, nothing is sent or written.
//
// WHAT "DECLINED" MEANS HERE, AND NOTHING ELSE. A person declined when the invitation row carries `declined_at`: they pressed "None of
// these times work" (or said they no longer need an appointment). It is NEVER inferred from a passed deadline (that is an invitation that
// expired without a response: `expired_at`, or `expires_at` in the past with nothing stamped) and NEVER from `released_at` alone (that is a
// release, whose reason is not recorded: the database keeps the same stamp for an owner release and a person's withdrawal). A test pins that
// the only source of a decline is `declined_at`.

export const DECLINED_VIEW = "declined";
export const DECLINED_SHOW_MAX = 50;
/** The most invitation rows one Data API statement returns (config.toml max_rows). The count is trusted only when the exact count equals the rows returned. */
export const DECLINE_READ_PAGE = 1000;

export type DeclineInvitationRow = { id: string; entry_id: string; declined_at: string };

export type DeclineRecords = { kind: "unknown" } | { kind: "ok"; rows: DeclineInvitationRow[] };

export type EntryFacts = { name: string; status: string };

export type DeclinedPerson = {
  entryId: string;
  /** The invitation the person declined: the most recent decline for that entry. */
  invitationId: string;
  declinedAt: string;
  /** Null when the entry could not be read: the row says so rather than inventing a name. */
  name: string | null;
  entryStatus: string | null;
};

const readable = (v: unknown): v is string => typeof v === "string" && Number.isFinite(new Date(v).getTime());

/** One person per entry (their most recent decline), newest decline first. A row without a readable id, entry or time is dropped, never guessed. */
export function latestDeclinePerPerson(rows: ReadonlyArray<Record<string, unknown>>): DeclineInvitationRow[] {
  const best = new Map<string, DeclineInvitationRow>();
  for (const r of rows) {
    if (typeof r.id !== "string" || typeof r.entry_id !== "string" || !readable(r.declined_at)) continue;
    const cur = best.get(r.entry_id);
    const at = new Date(r.declined_at).getTime();
    if (!cur || at > new Date(cur.declined_at).getTime() || (at === new Date(cur.declined_at).getTime() && r.id > cur.id)) {
      best.set(r.entry_id, { id: r.id, entry_id: r.entry_id, declined_at: r.declined_at });
    }
  }
  return [...best.values()].sort((a, b) => {
    const d = new Date(b.declined_at).getTime() - new Date(a.declined_at).getTime();
    return d !== 0 ? d : a.entry_id < b.entry_id ? -1 : a.entry_id > b.entry_id ? 1 : 0;
  });
}

/** The number of PEOPLE who have declined, all time. Null when the read was unreadable: unknown is never zero. */
export function declinedCount(records: DeclineRecords): number | null {
  return records.kind === "ok" ? latestDeclinePerPerson(records.rows).length : null;
}

export function declinedPeople(records: DeclineRecords, entries: ReadonlyMap<string, EntryFacts> | null): DeclinedPerson[] {
  if (records.kind !== "ok") return [];
  return latestDeclinePerPerson(records.rows).map((r) => {
    const e = entries?.get(r.entry_id);
    return { entryId: r.entry_id, invitationId: r.id, declinedAt: r.declined_at, name: e ? e.name : null, entryStatus: e ? e.status : null };
  });
}

export function declinedAtLabel(iso: string, timeZone: string | null | undefined): string {
  const zone = timeZone?.trim() || "UTC";
  const fmt = (z: string) =>
    new Intl.DateTimeFormat("en-US", { timeZone: z, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(iso));
  try {
    return fmt(zone);
  } catch {
    return fmt("UTC");
  }
}

export type DeclineAnswers =
  | { kind: "not_collected" }
  | { kind: "unreadable" }
  | { kind: "none_on_record" }
  /** The follow-up list was cut at its cap and this person's row is not in it: their answers may exist, so "none on record" would be a guess. */
  | { kind: "may_be_missing" }
  | { kind: "erased"; at: string | null }
  | { kind: "answers"; why: string; better: string };

/**
 * What the person wrote when they declined, from the owner's existing follow-up read, matched by INVITATION id (never by name). `answersOn` is the
 * WAITLIST_DECLINE_ANSWERS gate: off means answers are not collected, which is different from "none on record".
 */
export function answersFor(invitationId: string, answersOn: boolean, followUps: FollowUpList | null): DeclineAnswers {
  if (!answersOn) return { kind: "not_collected" };
  if (followUps === null || followUps.kind !== "ok") return { kind: "unreadable" };
  const f = followUps.rows.find((r) => r.kind === "decline" && r.invitationId === invitationId);
  if (!f) return followUps.capped === true ? { kind: "may_be_missing" } : { kind: "none_on_record" };
  if (f.answersErasedAt) return { kind: "erased", at: f.answersErasedAt };
  if (f.whyNotWork === null && f.betterTimes === null) return { kind: "none_on_record" };
  return { kind: "answers", why: f.whyNotWork ?? "", better: f.betterTimes ?? "" };
}

export const DECLINE_OUTCOME_NOTE =
  "These people declined the times offered. That is different from an invitation that expired with no reply, and from one that was released (the reason for a release is not recorded). Neither of those appears here.";

export function declinedSummaryText(count: number | null): string {
  if (count === null) return "People who declined: we couldn’t count them just now.";
  return count === 1 ? "1 person has declined." : `${count} people have declined.`;
}
