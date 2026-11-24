"use server";

import { WAITLIST_OVER_INVITE_PATH } from "@/lib/waitlist/paths";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { addDays, localDateString } from "@/lib/booking/tz";
import { computeConsultationFit } from "@/lib/waitlist/send-time-fit";
import { WAIT_INVITATION_TTL_HOURS } from "@/lib/waitlist/invitation-window";
import { recheckBeforeSend } from "@/lib/waitlist/over-invite-batch";
import { parseOverInviteForm } from "@/lib/waitlist/over-invite-selection";
import { createBatch, previewSelection, stopBatch } from "@/lib/waitlist/over-invite-port";
import { retryByKind, runRounds } from "@/lib/waitlist/over-invite-run";
import { DEFAULT_LIMITS } from "@/lib/waitlist/over-invite-worker";
import { createClient } from "@/lib/supabase/server";
import { asReader, loadRefusedTargets, loadUnknownTargets } from "@/lib/waitlist/over-invite-shown";
import { RETRY_CLICK_MAX } from "@/lib/waitlist/over-invite-progress";
import { OVER_INVITE_NOTICES as N, type OverInviteResult } from "@/lib/waitlist/over-invite-result";

// The owner's "invite beyond estimated capacity" action. The SERVER is the authority; the form is untrusted:
//  - the studio and the actor come from the session; the fit, the live count and the extra are recomputed here. The posted `shown*` numbers are
//    ONLY compared with the fresh ones to decide whether to ask again.
//  - every posted entry id goes to the database command, which re-validates studio, owner and eligibility. No id is trusted from the form.
//  - `confirmed=on` is required, and with nothing chosen the action says so (a notice, not a disabled button).
//  - nothing here logs a name, an email, a token or an id, and no SMS path is imported anywhere on this route.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The confirm action runs only the FIRST round(s) inline; the cron route finishes the rest with no page open and no click.
const FIRST_ROUNDS_BUDGET_MS = 20_000;

type Scope = { serviceId: string; windowDays: number; allowedWeekdays: number[] | null };

function readScope(formData: FormData): Scope | null {
  const serviceId = formData.get("serviceId");
  const days = formData.get("windowDays");
  const weekdays = formData.get("allowedWeekdays");
  if (typeof serviceId !== "string" || !UUID.test(serviceId)) return null;
  if (typeof days !== "string" || !/^\d{1,3}$/.test(days)) return null;
  const windowDays = Number(days);
  if (windowDays < 1 || windowDays > 365) return null;
  let allowedWeekdays: number[] | null = null;
  if (typeof weekdays === "string" && weekdays.length > 0) {
    const parts = weekdays.split(",");
    if (parts.some((p) => !/^[0-6]$/.test(p))) return null;
    allowedWeekdays = [...new Set(parts.map(Number))].sort();
  }
  return { serviceId, windowDays, allowedWeekdays };
}

export async function sendOverInviteAction(_prev: OverInviteResult, formData: FormData): Promise<OverInviteResult> {
  // Once the batch is created it is SAVED whatever happens next, so a later failure must never say "Nothing was sent".
  let batchSaved = false;
  try {
    const parsed = parseOverInviteForm(formData);
    if (!parsed.ok) return { state: "notice", notice: N.malformed };
    const sub = parsed.submission;
    if (sub.entryIds.length === 0) return { state: "notice", notice: N.nobody };
    if (!sub.confirmed) return { state: "notice", notice: N.needConfirm };
    const scope = readScope(formData);
    if (!scope) return { state: "notice", notice: N.malformed };

    const { practitioner, studio } = await getCurrentPractitionerWithStudio();
    if (practitioner.role !== "owner" || !practitioner.user_id) return { state: "notice", notice: N.ownerOnly };
    const actorUserId = practitioner.user_id;
    const timezone = studio.timezone ?? "UTC";
    const start = localDateString(new Date(), timezone);
    const end = addDays(start, scope.windowDays - 1);

    const db = createAdminClient();
    // THE POSTED SERVICE MUST BE THIS STUDIO'S OWN ACTIVE SERVICE. At an ordinary fit the slot lookup would refuse a forged id, but a closed week
    // answers zero without looking at it, so the check is made here, before any batch can be saved.
    const svc = await db.from("services").select("id").eq("id", scope.serviceId).eq("studio_id", studio.id).eq("active", true).maybeSingle();
    if (svc.error || !svc.data) return { state: "notice", notice: N.badService };
    const fit = await computeConsultationFit({
      admin: db,
      studioId: studio.id,
      serviceId: scope.serviceId,
      windowDays: scope.windowDays,
      allowedWeekdays: scope.allowedWeekdays,
    });
    if (!fit.ok) return { state: "notice", notice: N.unavailable };

    const preview = await previewSelection(db, {
      studioId: studio.id,
      actorUserId,
      entryIds: sub.entryIds,
      startDate: start,
      endDate: end,
      allowedWeekdays: scope.allowedWeekdays,
    });
    if (!preview.ok) return { state: "notice", notice: N.unavailable };
    if (preview.result === "not_owner") return { state: "notice", notice: N.ownerOnly };
    if (preview.result !== "ok") return { state: "notice", notice: N.malformed };
    if (preview.admissible === 0) return { state: "notice", notice: N.noneEligible };

    // The extra is what the SERVER counts as invitable among the chosen, never the posted number.
    const fresh = { fit: fit.fit, active: preview.liveCount, extra: preview.admissible };
    if (sub.shown === null || recheckBeforeSend(sub.shown, fresh) === "reconfirm") {
      return { state: "reconfirm", notice: N.changed, ...fresh, expiringSoon: preview.expiringWithin24h };
    }

    // AT ZERO THE OWNER MUST ALSO ACKNOWLEDGE THAT THE INVITED MAY FIND NO TIMES. The server decides this from ITS fit, never from the posted
    // `shownFit`, the same way `confirmed` is required above: a form that omits or forges the box sends nothing.
    if (fit.fit === 0 && !sub.noTimesAcknowledged) return { state: "notice", notice: N.needNoTimesAck };

    const created = await createBatch(db, {
      studioId: studio.id,
      actorUserId,
      batchKey: sub.batchKey,
      entryIds: sub.entryIds,
      serviceId: scope.serviceId,
      startDate: start,
      endDate: end,
      allowedWeekdays: scope.allowedWeekdays,
      ttlHours: WAIT_INVITATION_TTL_HOURS,
      fit: fit.fit,
      shownLiveCount: preview.liveCount,
      confirmed: true,
    });
    if (!created.ok) return { state: "notice", notice: created.code === "not_applied" ? N.notYetAvailable : N.unavailable };
    switch (created.result) {
      case "created":
      case "exists":
        batchSaved = true;
        break;
      case "material_change":
        return {
          state: "reconfirm",
          notice: N.changed,
          fit: fit.fit,
          active: created.liveCount ?? preview.liveCount,
          extra: preview.admissible,
          expiringSoon: preview.expiringWithin24h,
        };
      case "key_reused":
        return { state: "notice", notice: N.keyReused };
      case "entry_in_other_batch":
        return { state: "notice", notice: N.alreadyQueued };
      case "invalid_entries":
        return { state: "notice", notice: N.invalidEntries };
      case "not_owner":
        return { state: "notice", notice: N.ownerOnly };
      case "confirmation_required":
        return { state: "notice", notice: N.needConfirm };
      default:
        return { state: "notice", notice: N.malformed };
    }

    // Without the batch id the inline round could not be scoped to THIS batch, so it does not run at all (the background route still sends the batch).
    if (!created.batchId) return { state: "notice", notice: N.batchSaved };
    // The batch is persisted. Run the first round(s) now; whatever is left is finished by the background route with no page open and no click.
    const first = await runRounds({ budgetMs: FIRST_ROUNDS_BUDGET_MS, mode: { mode: "scoped", studioId: studio.id, batchId: created.batchId, actorUserId: practitioner.user_id } });
    revalidatePath(WAITLIST_OVER_INVITE_PATH);
    const quantity = created.quantity ?? sub.entryIds.length;
    return {
      state: "progress",
      quantity,
      extraRequested: created.extraRequested ?? 0,
      sent: first.sent,
      skipped: first.skipped,
      failed: first.failed,
      pending: Math.max(0, quantity - first.sent - first.skipped - first.failed),
    };
  } catch {
    // A fixed sentence: no name, id, token or provider text.
    return { state: "notice", notice: batchSaved ? N.batchSaved : N.unavailable };
  }
}

/** "Stop sending the rest": moves this batch's PENDING items (and lease-expired claimed ones with no invitation) to skipped; in-flight items finish. */
export async function stopBatchAction(_prev: OverInviteResult, formData: FormData): Promise<OverInviteResult> {
  try {
    const batchId = formData.get("batchId");
    if (typeof batchId !== "string" || !UUID.test(batchId)) return { state: "notice", notice: N.malformed };
    const { practitioner, studio } = await getCurrentPractitionerWithStudio();
    if (practitioner.role !== "owner" || !practitioner.user_id) return { state: "notice", notice: N.ownerOnly };
    const r = await stopBatch(createAdminClient(), { studioId: studio.id, actorUserId: practitioner.user_id, batchId, leaseSeconds: DEFAULT_LIMITS.leaseSeconds });
    revalidatePath(WAITLIST_OVER_INVITE_PATH);
    if (!r.ok) return { state: "notice", notice: N.unavailable };
    if (r.result === "stopped") return { state: "notice", notice: N.stopped(r.cancelled) };
    if (r.result === "nothing_pending") return { state: "notice", notice: N.nothingToStop };
    return { state: "notice", notice: N.unavailable };
  } catch {
    return { state: "notice", notice: N.unavailable };
  }
}

async function retryAction(kind: "refused" | "unknown", formData: FormData): Promise<OverInviteResult> {
  try {
    if (formData.get(kind === "refused" ? "confirmRetry" : "confirmRetryUnknown") !== "on") return { state: "notice", notice: kind === "refused" ? N.needRetryConfirm : N.needUnknownConfirm };
    const { practitioner, studio } = await getCurrentPractitionerWithStudio();
    if (practitioner.role !== "owner" || !practitioner.user_id) return { state: "notice", notice: N.ownerOnly };
    const supabase = asReader(await createClient());
    const targets = kind === "refused" ? await loadRefusedTargets(supabase, studio.id) : await loadUnknownTargets(supabase, studio.id);
    if (targets === null) return { state: "notice", notice: N.unavailable };
    if (targets.length === 0) return { state: "notice", notice: kind === "refused" ? N.nothingToRetry : N.nothingUnknownToRetry };
    const chosen = targets.slice(0, RETRY_CLICK_MAX);
    const out = await retryByKind(kind, studio.id, practitioner.user_id, chosen, supabase);
    revalidatePath(WAITLIST_OVER_INVITE_PATH);
    return {
      state: "progress",
      quantity: chosen.length,
      extraRequested: 0,
      pending: 0,
      sent: out.filter((o) => o.status === "sent").length,
      skipped: out.filter((o) => o.status === "skipped").length,
      failed: out.filter((o) => o.status === "failed").length,
    };
  } catch {
    return { state: "notice", notice: N.unavailable };
  }
}

/**
 * The owner's SEPARATE, explicitly confirmed retry of deliveries the provider REFUSED. Nothing is posted but the confirmation: the targets are read
 * here from the batches shown on the page (the same query that produces the number on the confirm box), so a forged id cannot name anyone. A sent
 * item is never in this set, and an unknown outcome is not either (it has its own action below). Each retry goes through replace, never admit.
 */
export async function retryFailedDeliveriesAction(_prev: OverInviteResult, formData: FormData): Promise<OverInviteResult> {
  return retryAction("refused", formData);
}

/** The owner's separate, more strongly confirmed retry of deliveries whose outcome is UNKNOWN (we cannot tell whether the email arrived). */
export async function retryUnknownDeliveriesAction(_prev: OverInviteResult, formData: FormData): Promise<OverInviteResult> {
  return retryAction("unknown", formData);
}
