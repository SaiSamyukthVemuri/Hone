// What the database RECORDED about each invitation, stated as facts and nothing more.
//
// OWNER ONLY: reads go through the owner's own session (RLS policy new_client_waitlist_invitations_owner_select), after the
// calling page's owner check. Nothing here writes, sends, or logs a row.
//
// NOTHING IS INFERRED.
// * The DEADLINE is `expires_at`. The "expiry recorded at" time is `expired_at`: when expiry was written down (by the owner or a
//   sweep), which can be later than the deadline. They are different facts and are never shown as one another.
// * An invitation has at most one terminal outcome (redeemed, expired, released, declined). A release is shown as a release with
//   "reason not recorded": the database records released_at for an owner release, a person's withdrawal and a "times don't
//   work" reply alike, and the entry-event actor is the entry's earlier claimer, not who released. So "cancelled by the owner" is
//   NEVER asserted.
// * An invitation with no terminal column whose deadline has passed is stated as exactly that: deadline passed, expiry not recorded.

export type InvitationFacts = {
  invitationId: string;
  issuedAt: string;
  expiresAt: string;
  redeemedAt: string | null;
  expiredAt: string | null;
  releasedAt: string | null;
  declinedAt: string | null;
};

export type InvitationHistory = { kind: "unknown" } | { kind: "ok"; byEntry: ReadonlyMap<string, InvitationFacts[]> };

const iso = (v: unknown): string | null => (typeof v === "string" && !Number.isNaN(new Date(v).getTime()) ? v : null);

export function historyFromRows(rows: ReadonlyArray<Record<string, unknown>>): Map<string, InvitationFacts[]> {
  const byEntry = new Map<string, InvitationFacts[]>();
  for (const r of rows) {
    const issuedAt = iso(r.issued_at);
    const expiresAt = iso(r.expires_at);
    if (typeof r.id !== "string" || typeof r.entry_id !== "string" || !issuedAt || !expiresAt) continue;
    const f: InvitationFacts = {
      invitationId: r.id,
      issuedAt,
      expiresAt,
      redeemedAt: iso(r.redeemed_at),
      expiredAt: iso(r.expired_at),
      releasedAt: iso(r.released_at),
      declinedAt: iso(r.declined_at),
    };
    const list = byEntry.get(r.entry_id) ?? [];
    list.push(f);
    byEntry.set(r.entry_id, list);
  }
  for (const list of byEntry.values()) list.sort((a, b) => (a.issuedAt < b.issuedAt ? 1 : a.issuedAt > b.issuedAt ? -1 : 0));
  return byEntry;
}

export type InvitationOutcome = "booked_link_used" | "declined" | "expired" | "released" | "open" | "deadline_passed_unrecorded";

export function outcomeOf(f: InvitationFacts, nowMs: number): InvitationOutcome {
  if (f.declinedAt) return "declined";
  if (f.redeemedAt) return "booked_link_used";
  if (f.expiredAt) return "expired";
  if (f.releasedAt) return "released";
  return new Date(f.expiresAt).getTime() > nowMs ? "open" : "deadline_passed_unrecorded";
}

const OUTCOME_LABEL: Record<InvitationOutcome, string> = {
  booked_link_used: "Link used",
  declined: "Declined",
  expired: "Expired (not booked within the window)",
  released: "Released (reason not recorded)",
  open: "Open",
  deadline_passed_unrecorded: "Deadline passed (expiry not yet recorded)",
};

function when(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/** The recorded facts for one invitation, in a fixed order, in the studio's timezone. Only recorded values appear. */
export function describeInvitation(f: InvitationFacts, timeZone: string, nowMs: number): { outcome: string; facts: Array<{ label: string; value: string }> } {
  const o = outcomeOf(f, nowMs);
  const facts: Array<{ label: string; value: string }> = [
    { label: "Invited", value: when(f.issuedAt, timeZone) },
    { label: "Deadline", value: when(f.expiresAt, timeZone) },
  ];
  if (f.expiredAt) facts.push({ label: "Expiry recorded at", value: when(f.expiredAt, timeZone) });
  if (f.releasedAt) facts.push({ label: "Released at", value: when(f.releasedAt, timeZone) });
  if (f.declinedAt) facts.push({ label: "Declined at", value: when(f.declinedAt, timeZone) });
  if (f.redeemedAt) facts.push({ label: "Link used at", value: when(f.redeemedAt, timeZone) });
  return { outcome: OUTCOME_LABEL[o], facts };
}
