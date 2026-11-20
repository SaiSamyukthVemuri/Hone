"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { addDays, localDateString } from "@/lib/booking/tz";
import { computeConsultationFit } from "@/lib/waitlist/send-time-fit";
import { WAIT_INVITATION_TTL_HOURS } from "@/lib/waitlist/invitation-window";
import { recheckBeforeSend } from "@/lib/waitlist/over-invite-batch";
import { parseOverInviteForm } from "@/lib/waitlist/over-invite-selection";
import { createBatch, previewSelection, stopBatch } from "@/lib/waitlist/over-invite-port";
import { retryRefused, runRounds } from "@/lib/waitlist/over-invite-run";
import { DEFAULT_LIMITS } from "@/lib/waitlist/over-invite-worker";
import { createClient } from "@/lib/supabase/server";
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
    if (!created.batchId) return { state: "notice", notice: N.unavailable };
    // The batch is persisted. Run the first round(s) now; whatever is left is finished by the background route with no page open and no click.
    const first = await runRounds({ budgetMs: FIRST_ROUNDS_BUDGET_MS, scope: { studioId: studio.id, batchId: created.batchId ?? undefined } });
    revalidatePath("/settings/waitlist/over-invite");
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
    return { state: "notice", notice: N.unavailable };
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
    revalidatePath("/settings/waitlist/over-invite");
    if (!r.ok) return { state: "notice", notice: N.unavailable };
    if (r.result === "stopped") return { state: "notice", notice: N.stopped(r.cancelled) };
    if (r.result === "nothing_pending") return { state: "notice", notice: N.nothingToStop };
    return { state: "notice", notice: N.unavailable };
  } catch {
    return { state: "notice", notice: N.unavailable };
  }
}

/**
 * The owner's SEPARATE, explicitly confirmed retry of failed recipients. Nothing is posted but the confirmation: the targets are read here from the
 * batch tables (this studio's items that failed with a REFUSED delivery), so a forged id cannot name anyone. An UNKNOWN outcome is never in this
 * set, a sent item never is, and each retry goes through replace (never admit again).
 */
export async function retryFailedDeliveriesAction(_prev: OverInviteResult, formData: FormData): Promise<OverInviteResult> {
  try {
    if (formData.get("confirmRetry") !== "on") return { state: "notice", notice: N.needRetryConfirm };
    const { practitioner, studio } = await getCurrentPractitionerWithStudio();
    if (practitioner.role !== "owner" || !practitioner.user_id) return { state: "notice", notice: N.ownerOnly };
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("waitlist_invitation_batch_items")
      .select("id,entry_id")
      .eq("studio_id", studio.id)
      .eq("state", "failed")
      .eq("reason_class", "delivery_refused");
    if (error) return { state: "notice", notice: N.unavailable };
    const targets = (data ?? []).map((r) => ({ entryId: String(r.entry_id), itemId: String(r.id) }));
    if (targets.length === 0) return { state: "notice", notice: N.nothingToRetry };
    const out = await retryRefused(studio.id, practitioner.user_id, targets);
    revalidatePath("/settings/waitlist/over-invite");
    return {
      state: "progress",
      quantity: targets.length,
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
