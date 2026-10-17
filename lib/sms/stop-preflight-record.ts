import { classifyNanpNumber } from "./nanp";
import type { BindingSender } from "./campaign-binding";
import { configuredTwilioWebhookBase } from "./webhook-base";

// ===========================================================================
// SMS-STOP-PREFLIGHT-RECORD-01 (HON-50 G6): was the inbound STOP path of THIS
// sender proven, according to the RECORDED preflight (0230)?
// ===========================================================================
//
// PURE. No I/O, no provider call: the send path reads the record inside the
// same snapshot as the sender (readLiveRegistrationState) and asks this.
// Anything other than { ok: true } must refuse before the claim, for EVERY
// destination: STOP is phone-wide, so a studio whose STOP path is unproven
// sends nothing from its own number, whoever the recipient is.
//
//   missing       no record for this sender
//   mismatch      the record is another studio's or sender's, or was gathered
//                 for another number or Messaging Service than the sender
//                 holds now (numbers as canonical E.164; unparseable never
//                 matches)
//   not_ready     the preflight did not pass: `ready` false, no checks, or any
//                 check not `pass` (re-derived here, never trusted alone)
//   stale         the sender was provisioned or adopted AFTER the preflight,
//                 its provisioning time is unknown, or a timestamp does not
//                 parse
//   base_changed  TWILIO_WEBHOOK_BASE_URL is not the base the preflight was
//                 evaluated against (unset counts as changed): the URL the
//                 route verifies signatures against has moved
//
// There is NO wall-clock expiry, for the same reason as the campaign binding.
// A rotated TWILIO_AUTH_TOKEN cannot be detected here without the secret; the
// non-secret `credentialsEpoch` is recorded so either rotation option can be
// enforced later without a schema change (HON-50 open question, Sam).
// ===========================================================================

export type PreflightCheckStatus = "pass" | "fail" | "unknown";

export type RecordedStopPreflight = {
  senderId: string;
  studioId: string;
  phoneNumber: string;
  messagingServiceSid: string;
  ready: boolean;
  checks: Array<{ id: string; status: PreflightCheckStatus }>;
  webhookBase: string;
  credentialsEpoch: string | null;
  checkedAt: string;
};

export type StopPreflightVerdict =
  | { ok: true }
  | { ok: false; reason: "missing" | "mismatch" | "not_ready" | "stale" | "base_changed" };

const CHECK_STATUSES: ReadonlySet<string> = new Set<PreflightCheckStatus>(["pass", "fail", "unknown"]);

function canonicalPhone(value: string | null | undefined): string | null {
  const c = classifyNanpNumber(value);
  return c.ok ? c.e164 : null;
}

function instant(value: string | null | undefined): number {
  return typeof value === "string" && value.trim() !== "" ? Date.parse(value) : Number.NaN;
}

export function stopPreflightVerdict(
  recorded: RecordedStopPreflight | null,
  sender: BindingSender,
  env: Readonly<Record<string, string | undefined>> = process.env,
): StopPreflightVerdict {
  if (!recorded) return { ok: false, reason: "missing" };

  const recordedPhone = canonicalPhone(recorded.phoneNumber);
  const senderPhone = canonicalPhone(sender.phoneNumber);
  if (
    recorded.studioId !== sender.studioId ||
    recorded.senderId !== sender.id ||
    recordedPhone === null ||
    senderPhone === null ||
    recordedPhone !== senderPhone ||
    !sender.messagingServiceSid ||
    recorded.messagingServiceSid !== sender.messagingServiceSid
  ) {
    return { ok: false, reason: "mismatch" };
  }

  if (
    recorded.ready !== true ||
    recorded.checks.length === 0 ||
    recorded.checks.some((c) => c.status !== "pass")
  ) {
    return { ok: false, reason: "not_ready" };
  }

  const checked = instant(recorded.checkedAt);
  const provisioned = instant(sender.provisionedAt);
  if (Number.isNaN(checked) || Number.isNaN(provisioned) || checked < provisioned) {
    return { ok: false, reason: "stale" };
  }

  const base = configuredTwilioWebhookBase(env);
  if (!base || base !== recorded.webhookBase.replace(/\/+$/, "")) {
    return { ok: false, reason: "base_changed" };
  }
  return { ok: true };
}

type RawPreflight = {
  sender_id?: unknown;
  studio_id?: unknown;
  phone_number?: unknown;
  messaging_service_sid?: unknown;
  ready?: unknown;
  checks?: unknown;
  webhook_base?: unknown;
  credentials_epoch?: unknown;
  checked_at?: unknown;
};

const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

function parseChecks(raw: unknown): RecordedStopPreflight["checks"] | null {
  if (!Array.isArray(raw)) return null;
  const out: RecordedStopPreflight["checks"] = [];
  const ids = new Set<string>();
  for (const c of raw as Array<{ id?: unknown; status?: unknown }>) {
    if (!c || typeof c !== "object" || !isString(c.id) || ids.has(c.id)) return null;
    if (typeof c.status !== "string" || !CHECK_STATUSES.has(c.status)) return null;
    ids.add(c.id);
    out.push({ id: c.id, status: c.status as PreflightCheckStatus });
  }
  return out;
}

/**
 * The snapshot's `stop_preflights`, as strictly as campaignBindingsFromSnapshot.
 *   * ABSENT key (0230 unapplied): [] -- every verdict is then "missing",
 *     which still fails closed.
 *   * Anything else that is not a well-formed array of rows for the LISTED
 *     senders of THIS studio, one row per sender at most: null, which the
 *     caller turns into an unreadable snapshot.
 */
export function stopPreflightsFromSnapshot(
  snapshot: unknown,
  studioId: string,
  listedSenderIds: ReadonlySet<string>,
): RecordedStopPreflight[] | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  if (!("stop_preflights" in snapshot)) return [];
  const raw = (snapshot as { stop_preflights?: unknown }).stop_preflights;
  if (!Array.isArray(raw)) return null;

  const out: RecordedStopPreflight[] = [];
  const seen = new Set<string>();
  for (const item of raw as RawPreflight[]) {
    if (!item || typeof item !== "object") return null;
    const { sender_id, studio_id, phone_number, messaging_service_sid, ready, webhook_base, credentials_epoch, checked_at } =
      item;
    const checks = parseChecks(item.checks);
    if (
      !isString(sender_id) ||
      studio_id !== studioId ||
      !listedSenderIds.has(sender_id) ||
      seen.has(sender_id) ||
      !isString(phone_number) ||
      !isString(messaging_service_sid) ||
      typeof ready !== "boolean" ||
      checks === null ||
      !isString(webhook_base) ||
      !(credentials_epoch === null || isString(credentials_epoch)) ||
      !isString(checked_at)
    ) {
      return null;
    }
    seen.add(sender_id);
    out.push({
      senderId: sender_id,
      studioId,
      phoneNumber: phone_number,
      messagingServiceSid: messaging_service_sid,
      ready,
      checks,
      webhookBase: webhook_base,
      credentialsEpoch: credentials_epoch,
      checkedAt: checked_at,
    });
  }
  return out;
}
