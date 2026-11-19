"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { addDays, localDateString } from "@/lib/booking/tz";
import { computeConsultationFit } from "@/lib/waitlist/send-time-fit";
import { WAIT_INVITATION_TTL_HOURS } from "@/lib/waitlist/invitation-window";
import { recheckBeforeSend } from "@/lib/waitlist/over-invite-batch";
import { parseOverInviteForm } from "@/lib/waitlist/over-invite-selection";
import { admitBatchItem, claimItems, createBatch, previewSelection, replaceInvitation, settleItem } from "@/lib/waitlist/over-invite-port";
import { deliverIssued, mayStillSend } from "@/lib/waitlist/over-invite-deliver";
import { retryRefusedDeliveries, runBatchChunk, type ItemOutcome, type WorkerDeps } from "@/lib/waitlist/over-invite-worker";
import { OVER_INVITE_NOTICES as N, type OverInviteResult } from "@/lib/waitlist/over-invite-result";

// The owner's "invite beyond estimated capacity" action. The SERVER is the authority; the form is untrusted:
//  - the studio and the actor come from the session; the fit, the live count and the extra are recomputed here. The posted `shown*` numbers are
//    ONLY compared with the fresh ones to decide whether to ask again.
//  - every posted entry id goes to the database command, which re-validates studio, owner and eligibility. No id is trusted from the form.
//  - `confirmed=on` is required, and with nothing chosen the action says so (a notice, not a disabled button).
//  - nothing here logs a name, an email, a token or an id, and no SMS path is imported anywhere on this route.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHUNK_BUDGET_MS = 40_000;

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

function workerDeps(sleep: (ms: number) => Promise<void>): WorkerDeps {
  const db = createAdminClient();
  return {
    claim: (limits) => claimItems(db, limits),
    admit: (item) => admitBatchItem(db, item, null),
    settle: (id, outcome, reason) => settleItem(db, id, outcome, reason),
    deliver: (issued, entryId, item) => deliverIssued(item.studioId, issued, entryId),
    mayStillSend: (item) => mayStillSend(item.studioId, item.entryId),
    sleep,
  };
}

const sleepFor = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function tally(outcomes: readonly ItemOutcome[]) {
  const t = { sent: 0, skipped: 0, failed: 0 };
  for (const o of outcomes) t[o.status] += 1;
  return t;
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

    // Send until the budget is spent. Anything left stays queued and is finished by the continue action; nothing is dropped.
    const outcomes: ItemOutcome[] = [];
    const t0 = Date.now();
    let claimedAny = true;
    while (claimedAny && Date.now() - t0 < CHUNK_BUDGET_MS) {
      const r = await runBatchChunk(workerDeps(sleepFor));
      if (!r.ok) break;
      outcomes.push(...r.outcomes);
      claimedAny = r.claimed > 0;
    }
    revalidatePath("/settings/waitlist");
    const t = tally(outcomes);
    const quantity = created.quantity ?? sub.entryIds.length;
    return {
      state: "progress",
      quantity,
      // Whatever the chunks did not reach is still queued in the batch, and says so: nothing is dropped and nothing is capped.
      pending: Math.max(0, quantity - outcomes.length),
      extraRequested: created.extraRequested ?? 0,
      ...t,
      refusedDeliveries: outcomes.flatMap((o) => (o.status === "failed" && o.reason === "delivery_refused" ? [{ entryId: o.entryId, itemId: o.itemId }] : [])),
    };
  } catch {
    // A fixed sentence: no name, id, token or provider text.
    return { state: "notice", notice: N.unavailable };
  }
}

/** Finish a confirmed batch: runs more chunks of the SAME queue. It confirms nothing new and adds no recipient. */
export async function continueOverInviteAction(prev: OverInviteResult): Promise<OverInviteResult> {
  try {
    const { practitioner } = await getCurrentPractitionerWithStudio();
    if (practitioner.role !== "owner" || !practitioner.user_id) return { state: "notice", notice: N.ownerOnly };
    const outcomes: ItemOutcome[] = [];
    const t0 = Date.now();
    let claimedAny = true;
    while (claimedAny && Date.now() - t0 < CHUNK_BUDGET_MS) {
      const r = await runBatchChunk(workerDeps(sleepFor));
      if (!r.ok) break;
      outcomes.push(...r.outcomes);
      claimedAny = r.claimed > 0;
    }
    revalidatePath("/settings/waitlist");
    const t = tally(outcomes);
    const base = prev.state === "progress" ? prev : null;
    const settled = outcomes.length;
    return {
      state: "progress",
      quantity: base?.quantity ?? settled,
      extraRequested: base?.extraRequested ?? 0,
      pending: Math.max(0, (base?.pending ?? 0) - settled),
      sent: (base?.sent ?? 0) + t.sent,
      skipped: (base?.skipped ?? 0) + t.skipped,
      failed: (base?.failed ?? 0) + t.failed,
      refusedDeliveries: [
        ...(base?.refusedDeliveries ?? []),
        ...outcomes.flatMap((o) => (o.status === "failed" && o.reason === "delivery_refused" ? [{ entryId: o.entryId, itemId: o.itemId }] : [])),
      ],
    };
  } catch {
    return { state: "notice", notice: N.unavailable };
  }
}

/** Retry only entries whose delivery was REFUSED, through replace. Owner-only; the ids are requests and `replace` re-validates each. */
export async function retryOverInviteDeliveriesAction(_prev: OverInviteResult, formData: FormData): Promise<OverInviteResult> {
  try {
    const { practitioner, studio } = await getCurrentPractitionerWithStudio();
    if (practitioner.role !== "owner" || !practitioner.user_id) return { state: "notice", notice: N.ownerOnly };
    // Each retry target posts as "entryId:itemId". Both must be well-formed ids; `replace` re-validates the entry in this studio.
    const seen = new Set<string>();
    const targets: { entryId: string; itemId: string }[] = [];
    for (const v of formData.getAll("retry")) {
      if (typeof v !== "string") continue;
      const [entryId, itemId, extra] = v.split(":");
      if (extra !== undefined || !entryId || !itemId || !UUID.test(entryId) || !UUID.test(itemId) || seen.has(entryId)) continue;
      seen.add(entryId);
      targets.push({ entryId, itemId });
    }
    if (targets.length === 0) return { state: "notice", notice: N.nobody };
    const db = createAdminClient();
    const actorUserId = practitioner.user_id;
    const out = await retryRefusedDeliveries(
      {
        replace: (entryId) => replaceInvitation(db, { studioId: studio.id, actorUserId, entryId }),
        deliver: (issued, entryId) => deliverIssued(studio.id, issued, entryId),
        settle: (id, outcome, reason) => settleItem(db, id, outcome, reason),
        sleep: sleepFor,
      },
      targets,
    );
    revalidatePath("/settings/waitlist");
    return {
      state: "progress",
      quantity: targets.length,
      extraRequested: 0,
      pending: 0,
      sent: out.filter((o) => o.status === "sent").length,
      skipped: out.filter((o) => o.status === "skipped").length,
      failed: out.filter((o) => o.status === "failed").length,
      refusedDeliveries: out.flatMap((o) =>
        o.status === "failed" && o.reason === "delivery_refused" ? [{ entryId: o.entryId, itemId: targets.find((t) => t.entryId === o.entryId)?.itemId ?? "" }] : [],
      ),
    };
  } catch {
    return { state: "notice", notice: N.unavailable };
  }
}
