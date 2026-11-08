import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendWaitlistEmailIdempotent, type IdempotentEmailTransport } from "@/lib/email/new-client-waitlist-send";
import { buildWaitlistDeclineOwnerEmail } from "@/lib/email/templates/waitlist-decline-owner";
import { getRequiredAppOrigin } from "@/lib/app-origin";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { readFollowUpStatuses } from "./followups-owner";
import { waitlistDeclineAnswersEnabled } from "./decline-answers-gate";
import { emptyOutboxCounts, type OutboxCounts } from "./decline-status-lines";
import {
  DECLINE_OWNER_EMAIL_MAX_ATTEMPTS,
  DECLINE_OWNER_EMAIL_FAILED_NOTICE_CAP,
  DECLINE_OWNER_EMAIL_FAILED_NOTICE_DAYS,
  DECLINE_OWNER_EMAIL_BATCH_SIZE,
  DECLINE_OWNER_EMAIL_SWEEP_BUDGET_MS,
  DECLINE_OWNER_EMAIL_RETRY_WINDOW_HOURS,
  DECLINE_OWNER_EMAIL_STALE_CLAIM_MINUTES,
  declineOwnerEmailActivation,
  declineOwnerEmailEarliestEligible,
  declineOwnerEmailRowEligible,
} from "./decline-owner-email-gate";

// The owner email on a waitlist decline (HON-7 item 4): the sender. The decline transaction (migration 0325, Willow) inserts ONE
// outbox row per verified owner, held; this module claims a row, re-checks the recipient at send time, sends, and records the outcome.
//
// What is true of every path here:
//   * It NEVER throws. The decline has already committed; an email problem must not surface as a decline problem.
//   * It reads and writes ids, statuses, counts and dates only. No invitee name, contact, answer, body or raw provider error is read,
//     stored or logged. The only text that leaves is the fixed template, to an address resolved here and never stored.
//   * One row, one recipient, one idempotency scope (invitation id + recipient id). A retry replays at the provider rather than sending twice.


export type ErrorCode =
  | "provider_rejected"
  | "provider_unavailable"
  | "timeout"
  | "not_owner"
  | "unverified"
  | "no_recipient"
  | "unknown";

type Row = {
  id: string;
  studio_id: string;
  invitation_id: string;
  recipient_practitioner_id: string;
  status: "held" | "sending" | "sent" | "failed" | "cancelled";
  attempt_count: number;
  claimed_at: string | null;
};

export type RowResult = "sent" | "failed" | "cancelled" | "skipped";

/** `remaining`: eligible rows this run did not reach because its time budget ran out (0 when it finished, -1 if they could not be counted). A count only. */
export type DispatchSummary = { sent: number; failed: number; cancelled: number; skipped: number; remaining: number };

type Deps = {
  admin: SupabaseClient;
  transport?: IdempotentEmailTransport | null;
  now?: () => Date;
  /** Monotonic milliseconds for the time budget; a test seam. */
  clock?: () => number;
  /** Time budget for one run; a test seam. */
  budgetMs?: number;
  appOrigin?: () => string;
};

// The ONLY log record: a fixed event name, a closed code and counts.
function log(event: string, fields: Record<string, string | number>): void {
  try {
    console.error(JSON.stringify({ event, ...fields, timestamp: new Date().toISOString() }));
  } catch {
    // best effort
  }
}

const COLUMNS = "id,studio_id,invitation_id,recipient_practitioner_id,status,attempt_count,claimed_at";

/** Compare-and-swap claim: only one invocation can move a row to `sending`. */
async function claim(admin: SupabaseClient, row: Row, now: Date): Promise<Row | null> {
  let q = admin
    .from("waitlist_decline_owner_emails")
    .update({ status: "sending", attempt_count: row.attempt_count + 1, claimed_at: now.toISOString(), updated_at: now.toISOString() })
    .eq("id", row.id)
    .eq("status", row.status)
    .eq("attempt_count", row.attempt_count);
  if (row.status === "sending") q = row.claimed_at ? q.eq("claimed_at", row.claimed_at) : q.is("claimed_at", null);
  const { data, error } = await q.select(COLUMNS);
  if (error || !Array.isArray(data) || data.length !== 1) return null;
  return data[0] as Row;
}

async function settle(
  admin: SupabaseClient,
  row: Row,
  patch: { status: "sent" | "failed" | "cancelled"; last_error_code?: ErrorCode; provider_message_id?: string; sent_at?: string; attempt_count?: number },
  now: Date,
): Promise<void> {
  // Guarded by the claim we hold: attempt_count identifies this invocation's claim.
  await admin
    .from("waitlist_decline_owner_emails")
    .update({ ...patch, updated_at: now.toISOString() })
    .eq("id", row.id)
    .eq("status", "sending")
    .eq("attempt_count", row.attempt_count);
}

type Recipient = { ok: true; email: string } | { ok: false; code: "not_owner" | "unverified" | "no_recipient" | "unknown" };

/** Still an ACTIVE OWNER of THIS studio with a CONFIRMED email, resolved now. The address is read here and never stored. */
async function resolveRecipient(admin: SupabaseClient, row: Row): Promise<Recipient> {
  try {
    const { data, error } = await admin
      .from("practitioners")
      .select("id,studio_id,role,active,user_id")
      .eq("id", row.recipient_practitioner_id)
      .maybeSingle();
    if (error) return { ok: false, code: "unknown" };
    if (!data) return { ok: false, code: "no_recipient" };
    const p = data as { studio_id: string; role: string; active: boolean; user_id: string | null };
    if (p.studio_id !== row.studio_id || p.role !== "owner" || p.active !== true) return { ok: false, code: "not_owner" };
    if (!p.user_id) return { ok: false, code: "unverified" };
    const got = await admin.auth.admin.getUserById(p.user_id);
    if (got.error || !got.data?.user) return { ok: false, code: "unknown" };
    const u = got.data.user;
    if (!u.email_confirmed_at || !u.email) return { ok: false, code: "unverified" };
    return { ok: true, email: u.email };
  } catch {
    return { ok: false, code: "unknown" };
  }
}

async function sendOne(deps: Deps, row: Row, now: Date): Promise<RowResult> {
  const claimed = await claim(deps.admin, row, now);
  if (!claimed) return "skipped";

  const recipient = await resolveRecipient(deps.admin, claimed);
  if (!recipient.ok) {
    // not_owner / unverified / no_recipient are final. `unknown` is a read problem and stays retryable.
    if (recipient.code === "unknown") {
      await settle(deps.admin, claimed, { status: "failed", last_error_code: "unknown" }, now);
      return "failed";
    }
    await settle(deps.admin, claimed, { status: "cancelled", last_error_code: recipient.code }, now);
    return "cancelled";
  }

  let origin: string;
  try {
    origin = (deps.appOrigin ?? getRequiredAppOrigin)();
  } catch {
    await settle(deps.admin, claimed, { status: "failed", last_error_code: "unknown" }, now);
    return "failed";
  }
  const mail = buildWaitlistDeclineOwnerEmail({ appOrigin: origin });
  const outcome = await sendWaitlistEmailIdempotent({
    namespace: "studio",
    studioId: claimed.studio_id,
    eventScope: `decline-owner/${claimed.invitation_id}/${claimed.recipient_practitioner_id}`,
    to: recipient.email,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    // EVENT-ONLY KEY. The default key hashes the payload, so an address or origin change between an ambiguous send and its retry would mint
    // a new key and the provider could deliver twice. The key is the outbox row's identity (invitation + recipient) and nothing else.
    eventOnlyKey: true,
    ...(deps.transport !== undefined ? { transport: deps.transport } : {}),
  });

  if (outcome.status === "accepted") {
    await settle(deps.admin, claimed, { status: "sent", provider_message_id: outcome.messageId, sent_at: now.toISOString() }, now);
    return "sent";
  }
  // The provider refused THIS payload under a key it already holds for different bytes: the first attempt was taken, and may have been
  // delivered. It is a closed outcome, never a new send, and never retried (the budget is spent so the sweep leaves the row alone).
  if (outcome.status === "rejected" && outcome.code === "invalid_idempotent_request") {
    await settle(deps.admin, claimed, { status: "failed", last_error_code: "provider_rejected", attempt_count: DECLINE_OWNER_EMAIL_MAX_ATTEMPTS }, now);
    return "failed";
  }
  // `ambiguous` may have been delivered: it is retryable under the SAME key, which replays instead of sending twice.
  const code: ErrorCode = outcome.status === "ambiguous" ? "timeout" : "provider_rejected";
  await settle(deps.admin, claimed, { status: "failed", last_error_code: code }, now);
  return "failed";
}

/** After the window: held rows, and rows abandoned mid-send, that were never delivered become `failed`. Rows before activation are untouched. */
async function expireUnsent(admin: SupabaseClient, since: Date, windowStart: Date, staleBefore: string, now: Date): Promise<void> {
  const patch = { status: "failed", last_error_code: "unknown" satisfies ErrorCode, updated_at: now.toISOString() };
  try {
    await admin
      .from("waitlist_decline_owner_emails")
      .update(patch)
      .eq("status", "held")
      .gte("created_at", since.toISOString())
      .lt("created_at", windowStart.toISOString());
    await admin
      .from("waitlist_decline_owner_emails")
      .update(patch)
      .eq("status", "sending")
      .lt("claimed_at", staleBefore)
      .gte("created_at", since.toISOString())
      .lt("created_at", windowStart.toISOString());
    // A row abandoned mid-send on its LAST attempt can never be claimed again (the ceiling), so it must not stay `sending` forever.
    await admin
      .from("waitlist_decline_owner_emails")
      .update(patch)
      .eq("status", "sending")
      .lt("claimed_at", staleBefore)
      .gte("created_at", since.toISOString())
      .gte("attempt_count", DECLINE_OWNER_EMAIL_MAX_ATTEMPTS);
  } catch {
    log("decline_owner_email_expire_failed", { code: "unknown" });
  }
}

/**
 * Send what is owed. With `invitationId` it handles that decline's rows (called after the decline commits); without, it sweeps
 * recent rows (the cron backstop). Rows created before the activation instant are never touched.
 */
export async function dispatchDeclineOwnerEmail(deps: Deps, scope: { invitationId?: string } = {}): Promise<DispatchSummary> {
  const summary: DispatchSummary = { sent: 0, failed: 0, cancelled: 0, skipped: 0, remaining: 0 };
  try {
    const activation = declineOwnerEmailActivation();
    if (!activation.enabled) return summary;
    const now = (deps.now ?? (() => new Date()))();
    const staleBefore = new Date(now.getTime() - DECLINE_OWNER_EMAIL_STALE_CLAIM_MINUTES * 60_000).toISOString();

    // Nothing is attempted after the window, and a row that never got its turn inside it becomes `failed` (shown in Hone) rather than
    // lingering `held`. The window is measured from the row's own creation, so it holds whatever the cron cadence.
    const windowStart = new Date(now.getTime() - DECLINE_OWNER_EMAIL_RETRY_WINDOW_HOURS * 3_600_000);
    const earliest = declineOwnerEmailEarliestEligible(activation.since, now);
    await expireUnsent(deps.admin, activation.since, windowStart, staleBefore, now);

    // Batches are walked by a KEYSET on `id` so every row is visited at most once per run. Without it a row that just failed would still be
    // eligible and be picked again in the next batch, spending its whole retry budget in one sweep. Per-row compare-and-swap claims are unchanged,
    // so an overlapping post-commit send and this sweep cannot both send the same row.
    const clock = deps.clock ?? (() => Date.now());
    const budget = deps.budgetMs ?? DECLINE_OWNER_EMAIL_SWEEP_BUDGET_MS;
    const startedAt = clock();
    const eligible = (after: string | null, head: boolean) => {
      let q = deps.admin
        .from("waitlist_decline_owner_emails")
        .select(COLUMNS, head ? { count: "exact", head: true } : undefined)
        .gte("created_at", earliest.toISOString())
        .lt("attempt_count", DECLINE_OWNER_EMAIL_MAX_ATTEMPTS)
        .or(`status.in.(held,failed),and(status.eq.sending,claimed_at.lt.${staleBefore})`);
      if (scope.invitationId) q = q.eq("invitation_id", scope.invitationId);
      if (after) q = q.gt("id", after);
      return q;
    };
    let after: string | null = null;
    for (;;) {
      const { data, error } = await eligible(after, false).order("id", { ascending: true }).limit(DECLINE_OWNER_EMAIL_BATCH_SIZE);
      if (error || !Array.isArray(data)) {
        log("decline_owner_email_read_failed", { code: "read_error" });
        break;
      }
      if (data.length === 0) break;
      let stoppedEarly = false;
      for (const row of data as Row[]) {
        if (clock() - startedAt >= budget) {
          stoppedEarly = true;
          break;
        }
        after = row.id;
        try {
          summary[await sendOne(deps, row, now)] += 1;
        } catch {
          summary.failed += 1;
        }
      }
      if (stoppedEarly) {
        const rest = await eligible(after, true);
        summary.remaining = !rest.error && typeof rest.count === "number" ? rest.count : -1;
        log("decline_owner_email_budget_spent", { remaining: summary.remaining });
        break;
      }
      if (data.length < DECLINE_OWNER_EMAIL_BATCH_SIZE) break;
    }
    if (summary.failed > 0) log("decline_owner_email_failures", { failed: summary.failed });
  } catch {
    log("decline_owner_email_dispatch_threw", { code: "unknown" });
  }
  return summary;
}

export type DeclineEmailStatus = { kind: "unknown" } | { kind: "ok"; failed: number; atLeast?: boolean };

/**
 * Owners see a failure in Hone. A count only: no recipient, no error text.
 *
 * Two modes, chosen by the answers flag so the 0325 function is never called (and never required) while the flag is off:
 *   * OFF: exactly as shipped in #1407. Failed rows since activation and within the last DECLINE_OWNER_EMAIL_FAILED_NOTICE_DAYS days; the outbox
 *     cannot say a response was handled, so the notice ages out.
 *   * ON: failed rows since activation whose follow-up is still OPEN, read in ONE status-only call (no name, no answer). Past the cap it says
 *     "at least" rather than truncating silently.
 */
export async function getDeclineEmailStatus(admin: SupabaseClient, studioId: string, actorUserId: string | null, now: Date = new Date()): Promise<DeclineEmailStatus> {
  try {
    const activation = declineOwnerEmailActivation();
    if (!activation.enabled) return { kind: "ok", failed: 0 };
    if (!waitlistDeclineAnswersEnabled()) {
      const recent = new Date(now.getTime() - DECLINE_OWNER_EMAIL_FAILED_NOTICE_DAYS * 86_400_000);
      const from = recent > activation.since ? recent : activation.since;
      const { count, error } = await admin
        .from("waitlist_decline_owner_emails")
        .select("id", { count: "exact", head: true })
        .eq("studio_id", studioId)
        .eq("status", "failed")
        .gte("created_at", from.toISOString());
      if (error || typeof count !== "number") return { kind: "unknown" };
      return { kind: "ok", failed: count };
    }
    if (!actorUserId) return { kind: "unknown" };
    const { data, error } = await admin
      .from("waitlist_decline_owner_emails")
      .select("invitation_id")
      .eq("studio_id", studioId)
      .eq("status", "failed")
      .gte("created_at", activation.since.toISOString())
      .order("id", { ascending: true })
      .limit(DECLINE_OWNER_EMAIL_FAILED_NOTICE_CAP + 1);
    if (error || !Array.isArray(data)) return { kind: "unknown" };
    // More rows than the cap means we cannot know the distinct count: say so below instead of counting a silent prefix.
    const rowsTruncated = data.length > DECLINE_OWNER_EMAIL_FAILED_NOTICE_CAP;
    const all = [...new Set((data as Array<{ invitation_id?: unknown }>).flatMap((r) => (typeof r.invitation_id === "string" ? [r.invitation_id] : [])))];
    const invitations = all.slice(0, DECLINE_OWNER_EMAIL_FAILED_NOTICE_CAP);
    const truncated = rowsTruncated || all.length > invitations.length;
    if (invitations.length === 0) return { kind: "ok", failed: 0 };
    const st = await readFollowUpStatuses(studioId, actorUserId, invitations);
    if (st.kind !== "ok") return { kind: "unknown" };
    let open = 0;
    for (const id of invitations) if (st.byInvitation.get(id) === "open") open += 1;
    return truncated ? { kind: "ok", failed: open, atLeast: true } : { kind: "ok", failed: open };
  } catch {
    return { kind: "unknown" };
  }
}

/** For the owner page, after its role check. The service-role client stays inside this module; an unbuildable client is `unknown`. */
export async function loadDeclineEmailStatus(studioId: string, actorUserId: string | null): Promise<DeclineEmailStatus> {
  try {
    return await getDeclineEmailStatus(createAdminClient(), studioId, actorUserId);
  } catch {
    return { kind: "unknown" };
  }
}

/** Outbox counts per invitation, for the follow-up card's email line. Ids and counts only. null = could not be read. */
export async function loadOutboxCounts(studioId: string, invitationIds: string[], now: Date = new Date()): Promise<Map<string, OutboxCounts> | null> {
  const out = new Map<string, OutboxCounts>();
  if (invitationIds.length === 0) return out;
  try {
    const activation = declineOwnerEmailActivation();
    const { data, error } = await createAdminClient()
      .from("waitlist_decline_owner_emails")
      .select("invitation_id,status,created_at")
      .eq("studio_id", studioId)
      .in("invitation_id", invitationIds.slice(0, 200));
    if (error || !Array.isArray(data)) return null;
    for (const r of data as Array<{ invitation_id?: unknown; status?: unknown; created_at?: unknown }>) {
      if (typeof r.invitation_id !== "string" || typeof r.status !== "string") continue;
      const c = out.get(r.invitation_id) ?? emptyOutboxCounts();
      // A held row the sweep will never claim (created before activation, or past its window) is "not sent", never "sending".
      if (r.status === "held" && activation.enabled && !(typeof r.created_at === "string" && declineOwnerEmailRowEligible(r.created_at, activation.since, now))) {
        c.notSent += 1;
      } else if (r.status in c && r.status !== "notSent") {
        c[r.status as keyof OutboxCounts] += 1;
      }
      out.set(r.invitation_id, c);
    }
    return out;
  } catch {
    return null;
  }
}
