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

export type FollowUpList = { kind: "unknown" } | { kind: "ok"; rows: FollowUpRow[] };

const STATUSES = new Set(["open", "handled", "kept", "booked", "removed"]);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

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
    return { kind: "ok", rows };
  } catch {
    return { kind: "unknown" };
  }
}

/**
 * Is this invitation's follow-up still open? Uses the STATUS-ONLY read, which returns no name and no answer, so a count in the failed-email
 * notice never loads personal text. `none` = zero rows.
 */
export type FollowUpStatusRead = { kind: "unknown" } | { kind: "ok"; status: FollowUpStatus | "none" };

export async function readFollowUpStatus(studioId: string, actorUserId: string | null, invitationId: string): Promise<FollowUpStatusRead> {
  if (!actorUserId) return { kind: "unknown" };
  try {
    const { data, error } = await createAdminClient().rpc("read_waitlist_followup_status", {
      p_studio_id: studioId,
      p_actor_user_id: actorUserId,
      p_invitation_id: invitationId,
    });
    if (error || !Array.isArray(data)) return { kind: "unknown" };
    if (data.length === 0) return { kind: "ok", status: "none" };
    const s = (data[0] as { status?: unknown }).status;
    return typeof s === "string" && STATUSES.has(s) ? { kind: "ok", status: s as FollowUpStatus } : { kind: "unknown" };
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
