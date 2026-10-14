// ===========================================================================
// LEAD-ALERT-01 (#826): the alert's states and failure codes, as migration
// 0213 stores them, and the words the operator console uses for them.
//
// Pure: no I/O, no env. The console renders from this, and the tests pin it
// against 0213's own vocabulary so the two cannot drift.
//
// HONESTY: "accepted" means the email provider accepted the message. Nothing
// here, or anywhere in this feature, claims it reached an inbox.
// ===========================================================================

export const LEAD_ALERT_MAX_ATTEMPTS = 5;

export const LEAD_ALERT_STATUSES = ["pending", "sending", "accepted", "failed"] as const;
export type LeadAlertStatus = (typeof LEAD_ALERT_STATUSES)[number];

/** No attempt could be made: server configuration is missing. */
export const LEAD_ALERT_CONFIG_CODES = [
  "recipient_not_configured",
  "recipient_not_allowlisted",
  "transport_not_configured",
  "app_origin_not_configured",
] as const;
export type LeadAlertConfigCode = (typeof LEAD_ALERT_CONFIG_CODES)[number];

/** Every code 0213's platform_lead_alerts_error_code_ck admits. */
export const LEAD_ALERT_ERROR_CODES = [
  ...LEAD_ALERT_CONFIG_CODES,
  "provider_rejected",
  "provider_unavailable",
  "provider_timeout",
  "provider_exception",
  "render_failed",
  "recipient_changed",
  "lease_expired",
  "expired",
] as const;
export type LeadAlertErrorCode = (typeof LEAD_ALERT_ERROR_CODES)[number];

const REASON: Record<LeadAlertErrorCode, string> = {
  recipient_not_configured: "No alert recipient is configured (LEAD_ALERT_EMAIL).",
  recipient_not_allowlisted:
    "LEAD_ALERT_EMAIL is not exactly one address on the admin allowlist (ADMIN_EMAILS).",
  transport_not_configured: "The email provider is not configured (RESEND_API_KEY).",
  app_origin_not_configured:
    "The console link cannot be built: NEXT_PUBLIC_APP_ORIGIN is not set.",
  provider_rejected: "The email provider refused the message.",
  provider_unavailable: "The email provider was unavailable.",
  provider_timeout: "The email provider did not answer in time.",
  provider_exception: "The email provider gave no usable answer.",
  render_failed: "The alert email could not be composed.",
  recipient_changed:
    "The alert recipient (LEAD_ALERT_EMAIL) changed after the first attempt, so a retry could not repeat it. Use Retry to send it to the current recipient under a new key.",
  lease_expired: "A send attempt stopped before it finished.",
  expired: "It was not sent within its automatic retry window. Use Retry to send it under a new key.",
};

export function isLeadAlertConfigCode(code: unknown): code is LeadAlertConfigCode {
  return (
    typeof code === "string" &&
    (LEAD_ALERT_CONFIG_CODES as readonly string[]).includes(code)
  );
}

/** The operator-facing reason for a stored code; null for none or an unknown one. */
export function leadAlertReason(code: string | null | undefined): string | null {
  if (typeof code !== "string") return null;
  return (REASON as Record<string, string | undefined>)[code] ?? null;
}

export type PlatformLeadKind = "demo_request" | "early_access";

/**
 * The one-lead console page the alert email links to (Codex P2 4248920469):
 * it loads the named lead whatever its age, unlike the /admin tables, which
 * show the latest 20 of each kind.
 */
export function leadDetailPath(kind: PlatformLeadKind, leadId: string): string {
  return `/admin/leads/${kind === "demo_request" ? "demo-request" : "early-access"}/${leadId}`;
}

/** The console row's anchor on /admin. */
export function leadAnchorId(kind: PlatformLeadKind, leadId: string): string {
  return kind === "demo_request"
    ? `lead-demo-request-${leadId}`
    : `lead-early-access-${leadId}`;
}

export type LeadAlertSummary = {
  status: LeadAlertStatus;
  attempt_count: number;
  last_error_code: string | null;
};

export type LeadAlertBadge = {
  tone: "ok" | "waiting" | "problem" | "none";
  label: string;
  detail: string | null;
};

/** What the console says about one lead's alert. `null` = the lead has none. */
export function describeLeadAlert(alert: LeadAlertSummary | null): LeadAlertBadge {
  if (!alert) {
    return {
      tone: "none",
      label: "No alert",
      detail: "Saved before lead alerts existed, or not through the form.",
    };
  }
  const reason = leadAlertReason(alert.last_error_code);
  switch (alert.status) {
    case "accepted":
      return {
        tone: "ok",
        label: "Alert accepted",
        detail: "The email provider accepted it. Inbox delivery is not confirmed.",
      };
    case "sending":
      return {
        tone: "waiting",
        label: `Sending (attempt ${alert.attempt_count} of ${LEAD_ALERT_MAX_ATTEMPTS})`,
        detail: null,
      };
    case "failed":
      return { tone: "problem", label: "Alert failed", detail: reason };
    case "pending":
      if (isLeadAlertConfigCode(alert.last_error_code)) {
        return { tone: "problem", label: "Alert not sent", detail: reason };
      }
      if (alert.attempt_count > 0) {
        return {
          tone: "waiting",
          label: `Retrying (${alert.attempt_count} of ${LEAD_ALERT_MAX_ATTEMPTS} attempts used)`,
          detail: reason,
        };
      }
      return { tone: "waiting", label: "Alert waiting to send", detail: null };
  }
}

/**
 * Failure codes KNOWN not to have reached the provider as an accepted send
 * (0213 requeue_platform_lead_alert's list, pinned by test). Only these, and
 * an expiry before any attempt, may be retried under a new idempotency key
 * without the operator's confirmation (Codex P2 4276616247).
 */
export const LEAD_ALERT_KNOWN_UNSENT_CODES = ["provider_rejected", "recipient_changed", "render_failed"] as const;

/**
 * True when a FAILED alert may already have been accepted by the provider: a
 * timeout, provider exception or unavailability, an abandoned lease, or an
 * expiry after an attempt. Retrying it mints a new key the provider cannot
 * match to the earlier request, so it may send a duplicate.
 */
export function leadAlertMayHaveBeenSent(code: string | null | undefined, attempts: number): boolean {
  if (code && (LEAD_ALERT_KNOWN_UNSENT_CODES as readonly string[]).includes(code)) return false;
  if (code === "expired" && attempts === 0) return false;
  return true;
}
