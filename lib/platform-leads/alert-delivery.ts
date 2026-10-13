import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { FROM_ADDRESS, getResendTransport } from "@/lib/email/client";
import {
  sendOnceWithIdempotencyKey,
  type IdempotentEmailTransport,
  type WaitlistSendOutcome,
} from "@/lib/email/new-client-waitlist-send";
import { getRequiredAppOrigin } from "@/lib/app-origin";
import { recordOpsAlert } from "@/lib/ops/alerts";
import {
  maskRecipient,
  resolveLeadAlertRecipient,
} from "./alert-config";
import {
  leadConsoleUrl,
  renderPlatformLeadAlert,
  type PlatformLeadAlertContent,
} from "./alert-email";
import type {
  LeadAlertConfigCode,
  LeadAlertErrorCode,
  PlatformLeadKind,
} from "./alert-status";

// ===========================================================================
// LEAD-ALERT-01 (#826): deliver the operator alert for a saved Hone lead
// ===========================================================================
//
// The lead and its alert row were committed together (migration 0213). This
// module only ever acts on the ALERT: it never writes, re-creates or hides a
// lead, and nothing it does is reported to the person who submitted the form.
//
//   CLAIM -> SEND -> SETTLE, one alert at a time.
//
// * CLAIM leases one due alert to this worker (SKIP LOCKED in the database), or
//   re-leases one whose earlier worker died mid-attempt. Two workers never hold
//   one alert, and each claim is one counted attempt (at most five).
// * SEND is ONE provider request through the existing keyed Resend attempt
//   (lib/email/new-client-waitlist-send.ts), under the alert's own idempotency
//   key: identical on every retry of the alert, so a retry after an attempt
//   whose answer was lost asks the provider to replay rather than send again.
// * ONE KEY, ONE REQUEST (Codex P2 4244387544): the first attempt of a
//   generation FREEZES the message it sends (0213 freeze_platform_lead_alert_
//   message) and every later attempt sends those bytes, whatever has changed
//   in the renderer, origin or sender since. The recipient is still resolved
//   from configuration at send time; only its digest is frozen, and a retry
//   whose recipient has changed is not sent (recipient_changed, final: the
//   operator's Retry renders afresh under a new key).
// * SETTLE records what the provider said, for the current claim only:
//   accepted (NOT a delivery receipt), retry later, or failed.
//
// Configuration is checked BEFORE claiming. With no allowlisted recipient, no
// email transport or no console origin, nothing is claimed, no attempt is
// spent, and the alert records why it is still waiting -- visible in /admin,
// never success.
//
// Two callers: the server action that saved the lead (after its response is
// sent, for that one alert) and the cron sweep (every due alert, within a time
// budget). Neither ever throws.
//
// PII: the prospect's details go into the email and nowhere else. Every log
// line and ops alert written here carries ids, codes and counts only.
// ===========================================================================

/** Long enough for the send's own 15 s ceiling plus the database round trips. */
export const LEAD_ALERT_LEASE_SECONDS = 120;
/** No claim (one counted attempt) starts with less time than this left in a sweep's budget. */
export const LEAD_ALERT_MIN_SEND_WINDOW_MS = 2_000;
/**
 * Kept back from a sweep's deadline so the settle after a cut-off send still
 * lands inside the invocation (Codex decision on #831).
 */
export const LEAD_ALERT_SETTLE_RESERVE_MS = 1_500;
/** One sweep's ceilings: a bounded batch, finishing well inside the route's 60 s. */
export const LEAD_ALERT_SWEEP_MAX = 20;
export const LEAD_ALERT_SWEEP_BUDGET_MS = 40_000;

type Env = Readonly<Record<string, string | undefined>>;

/** Test seams. Production passes nothing. */
export type LeadAlertDeps = {
  admin?: SupabaseClient;
  /** `null` simulates an unconfigured provider. Defaults to the shared Resend transport. */
  transport?: IdempotentEmailTransport | null;
  env?: Env;
  appOrigin?: () => string;
};

export type LeadAlertReadiness =
  | {
      ready: true;
      recipient: string;
      transport: IdempotentEmailTransport;
      appOrigin: string;
    }
  | { ready: false; code: LeadAlertConfigCode };

/** Everything a send needs, from server configuration alone. */
export function resolveLeadAlertReadiness(deps: LeadAlertDeps = {}): LeadAlertReadiness {
  const recipient = resolveLeadAlertRecipient(deps.env ?? process.env);
  if (!recipient.ok) return { ready: false, code: recipient.code };

  const transport =
    deps.transport !== undefined
      ? deps.transport
      : (getResendTransport() as unknown as IdempotentEmailTransport | null);
  if (!transport) return { ready: false, code: "transport_not_configured" };

  let appOrigin: string;
  try {
    appOrigin = (deps.appOrigin ?? getRequiredAppOrigin)();
  } catch {
    return { ready: false, code: "app_origin_not_configured" };
  }
  return { ready: true, recipient: recipient.recipient, transport, appOrigin };
}

/** The console's view of the configuration: masked, never the address itself. */
export type LeadAlertConfigurationStatus =
  | { state: "ready"; maskedRecipient: string }
  | { state: "blocked"; code: LeadAlertConfigCode };

export function leadAlertConfigurationStatus(
  deps: LeadAlertDeps = {},
): LeadAlertConfigurationStatus {
  const r = resolveLeadAlertReadiness(deps);
  return r.ready
    ? { state: "ready", maskedRecipient: maskRecipient(r.recipient) }
    : { state: "blocked", code: r.code };
}

// ---------------------------------------------------------------------------
// The provider's answer, as the alert's next state
// ---------------------------------------------------------------------------

type Settlement = {
  outcome: "accepted" | "retry" | "fail";
  messageId?: string;
  errorCode?: Exclude<LeadAlertErrorCode, "lease_expired" | "expired">;
  providerError?: string;
};

// Provider refusals that the same request would meet again: final.
const TERMINAL_PROVIDER_REFUSALS: ReadonlySet<string> = new Set([
  "validation_error",
  "invalid_to_address",
  "missing_required_field",
  "invalid_idempotency_key",
  // The same key with a different payload. The message is frozen per
  // generation, so this is not expected; the operator's retry starts a new key.
  "invalid_idempotent_request",
]);

export function settlementFor(outcome: WaitlistSendOutcome): Settlement {
  if (outcome.status === "accepted") {
    return { outcome: "accepted", messageId: outcome.messageId };
  }
  if (outcome.status === "ambiguous") {
    // The request may or may not have been taken. A retry under the SAME key
    // is exactly what resolves that, so retry.
    if (outcome.reason === "concurrent") {
      return {
        outcome: "retry",
        errorCode: "provider_unavailable",
        providerError: "concurrent_idempotent_requests",
      };
    }
    return {
      outcome: "retry",
      errorCode: outcome.reason === "timeout" ? "provider_timeout" : "provider_exception",
    };
  }
  // Refused. A local refusal means no request was made.
  switch (outcome.code) {
    case "not_configured":
      return { outcome: "retry", errorCode: "transport_not_configured" };
    case "invalid_recipient":
      return { outcome: "retry", errorCode: "recipient_not_allowlisted" };
    case "missing_tenant_scope":
    case "missing_event_scope":
    case null:
      return { outcome: "retry", errorCode: "provider_exception" };
    default:
      return TERMINAL_PROVIDER_REFUSALS.has(outcome.code)
        ? { outcome: "fail", errorCode: "provider_rejected", providerError: outcome.code }
        : // Rate limits and anything unrecognised (a provider 5xx, an exhausted
          // quota) may pass: retry within the attempt budget.
          { outcome: "retry", errorCode: "provider_unavailable", providerError: outcome.code };
  }
}

// ---------------------------------------------------------------------------
// One alert: claim, send, settle
// ---------------------------------------------------------------------------

type ClaimRow = {
  result: string;
  alert_id: string;
  claim_token: string;
  attempt: number;
  idempotency_key: string;
  lead_kind: PlatformLeadKind;
  lead_id: string;
  event_at: string;
  lead_name: string | null;
  lead_email: string | null;
  practice_name: string | null;
  location: string | null;
  practice_type: string | null;
  practitioner_count: string | null;
  current_tool: string | null;
  has_notes: boolean | null;
  frozen_message: FrozenMessage | null;
  frozen_recipient_sha256: string | null;
};

/** What one generation sends, byte for byte, on every attempt. */
export type FrozenMessage = { from: string; subject: string; html: string; text: string };

export function recipientDigest(recipient: string): string {
  return createHash("sha256").update(recipient, "utf8").digest("hex");
}

function isFrozenMessage(v: unknown): v is FrozenMessage {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return (
    Object.keys(m).length === 4 &&
    typeof m.from === "string" &&
    typeof m.subject === "string" &&
    typeof m.html === "string" &&
    typeof m.text === "string"
  );
}

export type LeadAlertAttemptResult =
  | "accepted"
  | "retry_scheduled"
  | "failed"
  | "stale_claim"
  | "not_found"
  | "invalid_input"
  | "none"
  | "claim_error"
  | "freeze_error"
  | "settle_error";

function log(level: "info" | "error", payload: Record<string, unknown>): void {
  const line = JSON.stringify({ ...payload, timestamp: new Date().toISOString() });
  if (level === "error") console.error(line);
  else console.info(line);
}

function contentFromClaim(row: ClaimRow): PlatformLeadAlertContent {
  return {
    kind: row.lead_kind,
    leadId: row.lead_id,
    eventAt: row.event_at,
    name: row.lead_name,
    email: row.lead_email,
    practiceName: row.practice_name,
    location: row.location,
    practiceType: row.practice_type,
    practitionerCount: row.practitioner_count,
    currentTool: row.current_tool,
    hasNotes: row.has_notes === true,
  };
}

async function settle(
  admin: SupabaseClient,
  row: ClaimRow,
  s: Settlement,
): Promise<LeadAlertAttemptResult> {
  const { data, error } = await admin.rpc("settle_platform_lead_alert", {
    p_alert_id: row.alert_id,
    p_claim_token: row.claim_token,
    p_outcome: s.outcome,
    p_provider_message_id: s.messageId ?? null,
    p_error_code: s.errorCode ?? null,
    p_provider_error: s.providerError ?? null,
  });
  if (error) {
    // Not recorded. The lease expires and the alert is claimed again under
    // the SAME key, so an accepted send is replayed, not repeated.
    log("error", {
      event: "platform_lead_alert_settle_failed",
      alert_id: row.alert_id,
      attempt: row.attempt,
      outcome: s.outcome,
      code: error.code ?? null,
    });
    return "settle_error";
  }
  const result = String(data) as LeadAlertAttemptResult;
  log(result === "failed" ? "error" : "info", {
    event: "platform_lead_alert_attempt",
    alert_id: row.alert_id,
    lead_kind: row.lead_kind,
    attempt: row.attempt,
    result,
    error_code: s.errorCode ?? null,
    provider_error: s.providerError ?? null,
  });
  if (result === "failed") {
    await recordOpsAlert({
      severity: "warning",
      event: "platform_lead_alert_failed",
      message:
        "A new-lead alert email could not be sent. The lead is saved; see Lead alerts in /admin.",
      route: "lead-alerts",
      safeDetails: {
        alert_id: row.alert_id,
        lead_kind: row.lead_kind,
        attempt: row.attempt,
        error_code: s.errorCode ?? null,
        provider_error: s.providerError ?? null,
      },
    });
  }
  return result;
}

async function claimAndSend(
  admin: SupabaseClient,
  ready: Extract<LeadAlertReadiness, { ready: true }>,
  alertId: string | null,
  /** Epoch ms by which this attempt must finish: a sweep's budget. */
  deadline: number | null = null,
): Promise<LeadAlertAttemptResult> {
  const { data, error } = await admin.rpc("claim_platform_lead_alert", {
    p_alert_id: alertId,
    p_lease_seconds: LEAD_ALERT_LEASE_SECONDS,
  });
  if (error) {
    log("error", {
      event: "platform_lead_alert_claim_failed",
      alert_id: alertId,
      code: error.code ?? null,
    });
    return "claim_error";
  }
  const row = (Array.isArray(data) ? data[0] : null) as ClaimRow | null;
  if (!row || row.result !== "claimed") return "none";

  const digest = recipientDigest(ready.recipient);
  let message: FrozenMessage;
  if (row.frozen_message !== null && row.frozen_message !== undefined) {
    // A later attempt of this generation: the frozen bytes, or nothing.
    if (!isFrozenMessage(row.frozen_message) || row.frozen_recipient_sha256 !== digest) {
      return settle(admin, row, { outcome: "fail", errorCode: "recipient_changed" });
    }
    message = row.frozen_message;
  } else {
    let rendered: ReturnType<typeof renderPlatformLeadAlert>;
    try {
      rendered = renderPlatformLeadAlert(
        contentFromClaim(row),
        leadConsoleUrl(ready.appOrigin, row.lead_kind, row.lead_id),
      );
    } catch {
      return settle(admin, row, { outcome: "fail", errorCode: "render_failed" });
    }
    // Hone speaking to its own operator: Hone's From and no Reply-To. Nothing
    // submitted reaches a header.
    const frozen = await admin.rpc("freeze_platform_lead_alert_message", {
      p_alert_id: row.alert_id,
      p_claim_token: row.claim_token,
      p_message: { from: FROM_ADDRESS, subject: rendered.subject, html: rendered.html, text: rendered.text },
      p_recipient_sha256: digest,
    });
    const answer = (Array.isArray(frozen.data) ? frozen.data[0] : null) as
      | { result?: string; message?: unknown; recipient_sha256?: string | null }
      | null;
    if (frozen.error || !answer) {
      // Nothing is sent without a frozen message: the lease expires and the
      // next claim freezes it. No request has been made under the key.
      log("error", {
        event: "platform_lead_alert_freeze_failed",
        alert_id: row.alert_id,
        attempt: row.attempt,
        code: frozen.error?.code ?? null,
      });
      return "freeze_error";
    }
    if (answer.result === "stale_claim") return "stale_claim";
    if (answer.result !== "frozen" && answer.result !== "existing") return "freeze_error";
    // First writer wins: send what the database holds, never our own render.
    if (!isFrozenMessage(answer.message) || answer.recipient_sha256 !== digest) {
      return settle(admin, row, { outcome: "fail", errorCode: "recipient_changed" });
    }
    message = answer.message;
  }

  // The ONE configured recipient, and exactly the frozen bytes.
  const sending = sendOnceWithIdempotencyKey(
    ready.transport,
    { from: message.from, to: ready.recipient, subject: message.subject, html: message.html, text: message.text },
    row.idempotency_key,
  );
  // THE SWEEP'S DEADLINE HOLDS DURING THE SEND (Codex P2 4253569253). The keyed
  // attempt has its own fixed 15 s ceiling; a sweep with a shorter budget (the
  // reminders trigger's) stops waiting at its deadline. That is the ambiguous
  // outcome a timeout already is -- the request may still be accepted -- so the
  // alert is retried later under the SAME key and frozen message, and the
  // provider replays rather than sends twice.
  let outcome: WaitlistSendOutcome;
  if (deadline === null) {
    outcome = await sending;
  } else {
    // Stop waiting early enough to SETTLE inside the deadline.
    const sendDeadline = deadline - LEAD_ALERT_SETTLE_RESERVE_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cutOff = false;
    const late = new Promise<WaitlistSendOutcome>((resolve) => {
      timer = setTimeout(() => {
        cutOff = true;
        resolve({ status: "ambiguous", reason: "timeout" });
      }, Math.max(0, sendDeadline - Date.now()));
    });
    try {
      outcome = await Promise.race([sending, late]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (cutOff) {
      // NEVER ABANDONED: the request the provider may still be processing is
      // kept alive past this response (after()), so the platform does not
      // freeze it mid-flight. Its answer needs no record: the retry under the
      // same key replays whatever the provider decided.
      keepAlive(sending);
    }
  }
  return settle(admin, row, settlementFor(outcome));
}

/**
 * Record a configuration blocker. A database failure here is a FAILED write,
 * reported as one: it is never folded into "no alerts were blocked"
 * (Codex P2 4244064458).
 */
async function recordBlocked(
  admin: SupabaseClient,
  code: LeadAlertConfigCode,
  alertId: string | null,
): Promise<{ ok: true; count: number } | { ok: false }> {
  const { data, error } = await admin.rpc("record_platform_lead_alerts_unconfigured", {
    p_error_code: code,
    p_alert_id: alertId,
  });
  if (error) {
    log("error", {
      event: "platform_lead_alert_blocked_record_failed",
      alert_id: alertId,
      blocked: code,
      code: error.code ?? null,
    });
    return { ok: false };
  }
  const count = Number(data) || 0;
  log("error", {
    event: "platform_lead_alert_blocked",
    alert_id: alertId,
    blocked: code,
    alerts: count,
  });
  return { ok: true, count };
}

export type LeadAlertDeliveryResult =
  | { result: LeadAlertAttemptResult }
  /** `recorded: false`: the blocker could not be written either. */
  | { result: "blocked"; code: LeadAlertConfigCode; recorded: boolean }
  | { result: "threw" };

/**
 * Send the alert for ONE lead that was just saved. Called after the response,
 * so nothing here can change what the submitter was told. Never throws.
 */
export async function deliverPlatformLeadAlert(
  alertId: string,
  deps: LeadAlertDeps = {},
): Promise<LeadAlertDeliveryResult> {
  try {
    const admin = deps.admin ?? createAdminClient();
    const ready = resolveLeadAlertReadiness(deps);
    if (!ready.ready) {
      const record = await recordBlocked(admin, ready.code, alertId);
      return { result: "blocked", code: ready.code, recorded: record.ok };
    }
    return { result: await claimAndSend(admin, ready, alertId) };
  } catch (err) {
    log("error", {
      event: "platform_lead_alert_threw",
      alert_id: alertId,
      err_name: err instanceof Error ? err.name : typeof err,
    });
    return { result: "threw" };
  }
}

/** Keep an in-flight provider call alive past the response; fire-and-forget out of scope. */
function keepAlive(work: Promise<unknown>): void {
  const settled = work.then(
    () => undefined,
    () => undefined,
  );
  try {
    after(settled);
  } catch {
    // Out of request scope: the promise already runs on its own.
  }
}

/**
 * Send ONE just-saved lead's alert AFTER the response (Codex P2 4249961225).
 *
 * The work is handed to `after()` as a STARTED PROMISE, never a callback: in
 * Next 15.5 a callback enrols the request's shared work-unit store, and a
 * client that goes away mid-render flips that store to the "after" phase, so
 * later cookies()/headers() calls in the same render throw. A lead that WAS
 * saved would then look like a failed submission and invite a duplicate. This
 * is the repository's SENTRY-AFTER-01 rule (lib/analytics/server.ts
 * `schedule()`), applied here; the work starts on a later macrotask, so the
 * response never waits for it. Delivery itself is leased and keyed, so when it
 * runs changes nothing about what is sent. Never throws.
 */
export function schedulePlatformLeadAlert(
  alertId: string,
  deliver: (id: string) => Promise<unknown> = deliverPlatformLeadAlert,
): Promise<void> {
  const task = new Promise<void>((resolve) => setTimeout(resolve, 0))
    .then(() => deliver(alertId))
    .then(
      () => undefined,
      () => undefined,
    );
  try {
    after(task);
  } catch {
    // Out of request scope: the task is already queued and runs on its own.
  }
  return task;
}

export type LeadAlertSweepSummary = {
  ok: boolean;
  /**
   * True only when the run found nothing more due. False means it stopped at
   * its cap or budget with work possibly left: the honest backpressure signal.
   */
  drained: boolean;
  expired: number;
  blocked: LeadAlertConfigCode | null;
  blockedAlerts: number;
  attempted: number;
  accepted: number;
  retryScheduled: number;
  failed: number;
  other: number;
};

/**
 * The recovery path: retire what can no longer be sent, then send every due or
 * abandoned alert, one claim at a time, within a bounded batch and time
 * budget. Never throws; `ok: false` means a database call failed.
 */
export async function sweepPlatformLeadAlerts(
  opts: LeadAlertDeps & { maxAlerts?: number; budgetMs?: number } = {},
): Promise<LeadAlertSweepSummary> {
  const summary: LeadAlertSweepSummary = {
    ok: true,
    drained: false,
    expired: 0,
    blocked: null,
    blockedAlerts: 0,
    attempted: 0,
    accepted: 0,
    retryScheduled: 0,
    failed: 0,
    other: 0,
  };
  try {
    const admin = opts.admin ?? createAdminClient();

    // Whatever the configuration, an alert past its window becomes a visible
    // failure rather than waiting forever (and is never mailed late).
    const expired = await admin.rpc("expire_platform_lead_alerts");
    if (expired.error) {
      summary.ok = false;
      log("error", { event: "platform_lead_alert_expire_failed", code: expired.error.code ?? null });
    } else {
      summary.expired = Number(expired.data) || 0;
      if (summary.expired > 0) {
        await recordOpsAlert({
          severity: "warning",
          event: "platform_lead_alerts_expired",
          message: `${summary.expired} new-lead alert email(s) were never sent and have expired. The leads are saved; see Lead alerts in /admin.`,
          route: "lead-alerts",
          safeDetails: { count: summary.expired },
        });
      }
    }

    const ready = resolveLeadAlertReadiness(opts);
    if (!ready.ready) {
      summary.blocked = ready.code;
      const record = await recordBlocked(admin, ready.code, null);
      if (record.ok) {
        summary.blockedAlerts = record.count;
      } else {
        // The blocker was not persisted: the run FAILED (the route answers 500).
        summary.ok = false;
      }
      return summary;
    }

    const max = opts.maxAlerts ?? LEAD_ALERT_SWEEP_MAX;
    const budget = opts.budgetMs ?? LEAD_ALERT_SWEEP_BUDGET_MS;
    const started = Date.now();
    const deadline = started + budget;
    // A claim is one counted attempt: never start one without time for a fair
    // send AND its settle. The loop drains until the queue is empty, the
    // batch cap or the budget: backpressure is the budget, not a fixed count.
    for (let i = 0; i < max && deadline - Date.now() >= LEAD_ALERT_MIN_SEND_WINDOW_MS + LEAD_ALERT_SETTLE_RESERVE_MS; i += 1) {
      const result = await claimAndSend(admin, ready, null, deadline);
      if (result === "none") {
        summary.drained = true;
        break;
      }
      if (result === "claim_error" || result === "settle_error" || result === "freeze_error") {
        // The database did not record this run's work (a lost settle leaves
        // the alert leased until its lease expires): the run FAILED, and the
        // route answers 500 so the scheduler sees it. Stop rather than keep
        // claiming against a database that is not answering.
        if (result === "settle_error") summary.attempted += 1;
        summary.ok = false;
        break;
      }
      summary.attempted += 1;
      if (result === "accepted") summary.accepted += 1;
      else if (result === "retry_scheduled") summary.retryScheduled += 1;
      else if (result === "failed") summary.failed += 1;
      else summary.other += 1;
    }
    return summary;
  } catch (err) {
    log("error", {
      event: "platform_lead_alert_sweep_threw",
      err_name: err instanceof Error ? err.name : typeof err,
    });
    return { ...summary, ok: false };
  }
}

// ---------------------------------------------------------------------------
// RECOVERY ON THE REMINDERS TRIGGER (Codex P2 4253278108; decision on #831/#843)
// ---------------------------------------------------------------------------
// The production plan caps Vercel Cron at once a day, and the daily
// /api/cron/lead-alerts run alone cannot reach the retry schedule inside the
// 20-hour replay cutoff. The appointment-reminders route is already fired
// every 15 minutes by the existing external scheduler, so it also runs this:
// a SMALL, bounded sweep through the SAME worker (one retry authority: the
// same claim -> send -> settle, lease and fencing, the same idempotency key
// and frozen message per generation, the same 20-hour cutoff and five-attempt
// cap). The daily cron stays as a backstop.
//
// GATED BEFORE ANY DATABASE OR PROVIDER CALL. Until lead alerts are configured
// (an allowlisted LEAD_ALERT_EMAIL, the email transport and the console
// origin), this makes NO RPC and NO provider call, so a production reminders
// run is untouched while 0213 is unapplied or lead alerts are unactivated. It
// never throws: whatever happens, the reminders run's result is its own.

/** Small enough that a reminders run is never meaningfully delayed. */
/**
 * Sized by TIME, not by a tiny count (Codex P2 4253669922): up to 25 alerts
 * per 15-minute trigger within an 8-second budget, the settle reserve
 * included. tests/lib/platform-leads/retry-capacity.test.ts proves what this
 * sustains and where it honestly runs out.
 */
export const REMINDER_TRIGGER_LEAD_ALERT_MAX = 25;
export const REMINDER_TRIGGER_LEAD_ALERT_BUDGET_MS = 8_000;

export type ReminderTriggerLeadAlertResult =
  | { ran: false; reason: LeadAlertConfigCode | "threw" }
  | { ran: true; summary: LeadAlertSweepSummary };

export async function recoverLeadAlertsOnReminderTrigger(
  deps: LeadAlertDeps = {},
): Promise<ReminderTriggerLeadAlertResult> {
  try {
    const ready = resolveLeadAlertReadiness(deps);
    if (!ready.ready) return { ran: false, reason: ready.code };
    const summary = await sweepPlatformLeadAlerts({
      ...deps,
      maxAlerts: REMINDER_TRIGGER_LEAD_ALERT_MAX,
      budgetMs: REMINDER_TRIGGER_LEAD_ALERT_BUDGET_MS,
    });
    return { ran: true, summary };
  } catch (err) {
    log("error", {
      event: "platform_lead_alert_reminder_trigger_threw",
      err_name: err instanceof Error ? err.name : typeof err,
    });
    return { ran: false, reason: "threw" };
  }
}
