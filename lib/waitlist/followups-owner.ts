import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";

// 0325 — the OWNER's side of the decline and withdrawal follow-up.
//
// Every function takes the studio and the actor user id and passes both to a service_role-only command that RE-DERIVES the owner role inside
// (new_client_waitlist_resolve_owner), exactly like the 0319 module. The caller supplies them from the verified session (getUser) and never
// from a form field. The recipient's answers are returned ONLY by `readFollowUps`, which is reached only from the owner-gated settings page;
// nothing here logs a row, an answer or an error body. An unreadable result is `unknown`, never an empty list.

export type FollowUpKind = "decline" | "withdrawal";
export type FollowUpStatus = "open" | "handled" | "kept" | "booked" | "removed";

export type FollowUpRow = {
  followupId: string;
  kind: FollowUpKind;
  invitationId: string | null;
  entryId: string;
  /** The name the studio already holds on the waitlist entry. The email address is deliberately not carried to the page. */
  clientName: string;
  openedAt: string;
  status: FollowUpStatus;
  /** The person's own words. Null once erased, and for a withdrawal with no earlier decline answers. */
  whyNotWork: string | null;
  betterTimes: string | null;
  answersErasedAt: string | null;
  submittedAt: string | null;
  closedAt: string | null;
  /** When the answers will be erased by retention (null once erased). The warning shown to the owner. */
  eraseBy: string | null;
};

/** The columns `read_waitlist_followups` returns (0325 contract). erase_by, submitted_at and closed_at are contract fields, not extras; a test pins that each is read below. */
export const FOLLOWUP_READ_COLUMNS = [
  "followup_id", "kind", "entry_id", "invitation_id", "client_name", "opened_at", "status",
  "why_not_work", "better_times", "answers_erased_at", "submitted_at", "closed_at", "erase_by",
] as const;

/** read_waitlist_followups returns at most this many rows (0325, frozen). A list this long may be missing the rest, and must say so. */
export const FOLLOWUP_LIST_CAP = 500;

/** `capped` is present (true) only when the list reached the cap, so a partial list can never look complete. */
export type FollowUpList = { kind: "unknown" } | { kind: "ok"; rows: FollowUpRow[]; capped?: true };

const STATUSES = new Set(["open", "handled", "kept", "booked", "removed"]);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * One keyset page of the studio export of saved decline answers (0325 export_waitlist_decline_answers). Owner re-derived inside the function;
 * a non-owner gets zero rows. The caller is the owner-only export, after its role refusal, passing the session user. The error carries no body:
 * a page of answers must never be echoed into a message or a log.
 */
export async function exportDeclineAnswersPage(
  studioId: string,
  actorUserId: string,
  afterId: string | null,
  limit: number,
): Promise<{ data: Array<Record<string, unknown>> | null; error: { message: string; code?: string } | null }> {
  try {
    const { data, error } = await createAdminClient().rpc("export_waitlist_decline_answers", {
      p_studio_id: studioId,
      p_actor_user_id: actorUserId,
      p_after_id: afterId,
      p_limit: limit,
    });
    if (error) {
      // the code is a database error class, never a value; the message is dropped so no echoed input can travel
      const code = typeof error.code === "string" ? error.code : undefined;
      return { data: null, error: { message: "the answers export function did not return a page", ...(code ? { code } : {}) } };
    }
    if (!Array.isArray(data)) return { data: null, error: { message: "the answers export function did not return a page" } };
    return { data: data as Array<Record<string, unknown>>, error: null };
  } catch {
    return { data: null, error: { message: "the answers export function could not be reached" } };
  }
}

export async function readFollowUps(studioId: string, actorUserId: string | null): Promise<FollowUpList> {
  if (!actorUserId) return { kind: "unknown" };
  try {
    const { data, error } = await createAdminClient().rpc("read_waitlist_followups", {
      p_studio_id: studioId,
      p_actor_user_id: actorUserId,
    });
    if (error || !Array.isArray(data)) return { kind: "unknown" };
    const rows: FollowUpRow[] = [];
    for (const r of data as Array<Record<string, unknown>>) {
      const kind = r.kind === "decline" || r.kind === "withdrawal" ? r.kind : null;
      const status = typeof r.status === "string" && STATUSES.has(r.status) ? (r.status as FollowUpStatus) : null;
      if (!kind || !status || typeof r.followup_id !== "string" || typeof r.entry_id !== "string") return { kind: "unknown" };
      rows.push({
        followupId: r.followup_id,
        kind,
        invitationId: str(r.invitation_id),
        entryId: r.entry_id,
        clientName: str(r.client_name) ?? "",
        openedAt: str(r.opened_at) ?? "",
        status,
        whyNotWork: str(r.why_not_work),
        betterTimes: str(r.better_times),
        answersErasedAt: str(r.answers_erased_at),
        submittedAt: str(r.submitted_at),
        closedAt: str(r.closed_at),
        eraseBy: str(r.erase_by),
      });
    }
    return rows.length >= FOLLOWUP_LIST_CAP ? { kind: "ok", rows, capped: true } : { kind: "ok", rows };
  } catch {
    return { kind: "unknown" };
  }
}

/**
 * The status of many invitations' follow-ups in ONE call, from the STATUS-ONLY read, which returns no name and no answer, so counting never
 * loads personal text. An invitation with no follow-up has no row (`none`, absent from the map).
 * Contract: `read_waitlist_followup_status(p_studio_id, p_actor_user_id, p_invitation_ids uuid[])`, at most 500 ids; more is REFUSED by the database
 * (errcode 22023), never truncated, so this refuses to call with more and reports `too_many`.
 */
export const FOLLOWUP_STATUS_MAX_IDS = 500;
export type FollowUpStatusesRead = { kind: "unknown" } | { kind: "too_many" } | { kind: "ok"; byInvitation: Map<string, FollowUpStatus> };

export async function readFollowUpStatuses(studioId: string, actorUserId: string | null, invitationIds: string[]): Promise<FollowUpStatusesRead> {
  if (!actorUserId) return { kind: "unknown" };
  if (invitationIds.length === 0) return { kind: "ok", byInvitation: new Map() };
  if (invitationIds.length > FOLLOWUP_STATUS_MAX_IDS) return { kind: "too_many" };
  try {
    const { data, error } = await createAdminClient().rpc("read_waitlist_followup_status", {
      p_studio_id: studioId,
      p_actor_user_id: actorUserId,
      p_invitation_ids: invitationIds,
    });
    if (error?.code === "22023") return { kind: "too_many" };
    if (error || !Array.isArray(data)) return { kind: "unknown" };
    const byInvitation = new Map<string, FollowUpStatus>();
    for (const r of data as Array<{ invitation_id?: unknown; status?: unknown }>) {
      if (typeof r.invitation_id !== "string" || typeof r.status !== "string" || !STATUSES.has(r.status)) return { kind: "unknown" };
      byInvitation.set(r.invitation_id, r.status as FollowUpStatus);
    }
    return { kind: "ok", byInvitation };
  } catch {
    return { kind: "unknown" };
  }
}

// ---- the commands. Every outcome is a member of a closed list; anything else is `unavailable`.

export type CommandOutcome =
  | "done"
  | "already"
  | "not_found"
  | "not_owner"
  | "already_closed"
  | "appointment_not_found"
  | "appointment_mismatch"
  | "appointment_not_bookable"
  | "appointment_already_linked"
  | "entry_not_waiting"
  | "unavailable";

type Spec = { fn: string; ok: ReadonlySet<string>; already: ReadonlySet<string>; others: ReadonlySet<string> };
const set = (...v: string[]) => new Set(v);

const MARK_HANDLED: Spec = { fn: "mark_waitlist_decline_handled", ok: set("handled"), already: set("already_handled"), others: set("not_found", "not_owner", "already_closed") };
const KEEP: Spec = { fn: "keep_waitlist_withdrawal", ok: set("kept"), already: set("already_resolved"), others: set("not_found", "not_owner") };
const LINK: Spec = {
  fn: "link_waitlist_followup_appointment",
  ok: set("booked"),
  already: set("already_booked"),
  others: set("not_found", "not_owner", "appointment_not_found", "appointment_mismatch", "appointment_not_bookable", "appointment_already_linked", "entry_not_waiting"),
};
const ERASE: Spec = { fn: "erase_waitlist_decline_answers", ok: set("erased"), already: set("already_erased"), others: set("not_found", "not_owner") };

async function run(spec: Spec, args: Record<string, string>): Promise<CommandOutcome> {
  try {
    const { data, error } = await createAdminClient().rpc(spec.fn, args);
    if (error || !Array.isArray(data) || data.length !== 1) return "unavailable";
    const result = (data[0] as { result?: unknown }).result;
    if (typeof result !== "string") return "unavailable";
    if (spec.ok.has(result)) return "done";
    if (spec.already.has(result)) return "already";
    return spec.others.has(result) ? (result as CommandOutcome) : "unavailable";
  } catch {
    return "unavailable";
  }
}

const base = (studioId: string, actorUserId: string, followupId: string) => ({
  p_studio_id: studioId,
  p_actor_user_id: actorUserId,
  p_followup_id: followupId,
});

export const markDeclineHandled = (studioId: string, actorUserId: string, followupId: string) =>
  run(MARK_HANDLED, base(studioId, actorUserId, followupId));
export const keepWithdrawal = (studioId: string, actorUserId: string, followupId: string) =>
  run(KEEP, base(studioId, actorUserId, followupId));
export const eraseAnswers = (studioId: string, actorUserId: string, followupId: string) =>
  run(ERASE, base(studioId, actorUserId, followupId));
export const linkFollowUpAppointment = (studioId: string, actorUserId: string, followupId: string, appointmentId: string) =>
  run(LINK, { ...base(studioId, actorUserId, followupId), p_appointment_id: appointmentId });
