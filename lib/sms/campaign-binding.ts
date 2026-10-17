import { classifyNanpNumber } from "./nanp";

// ===========================================================================
// SMS-CAMPAIGN-BINDING-01 (HON-50 G4a): is this sender's Messaging Service
// bound to a VERIFIED US A2P campaign, according to the RECORDED check (0229)?
// ===========================================================================
//
// PURE. No I/O, no provider call: the send path reads the record inside the
// same snapshot as the sender (readLiveRegistrationState) and asks this.
// Anything other than { ok: true } must refuse before the claim. US-bound
// traffic only: A2P 10DLC governs messages to the US, so the caller applies
// this for US destinations (#858, decideStudioRoute).
//
//   missing     no record for this sender
//   mismatch    the record is another studio's or sender's, or was checked for
//               another number or Messaging Service than the sender holds now
//               (numbers compared as canonical E.164; unparseable never matches)
//   unverified  the campaign was not observed verified (or no campaign at all)
//   stale       the sender was provisioned or adopted AFTER the check, or its
//               provisioning time is unknown, or a timestamp does not parse
//
// There is NO wall-clock expiry: a time-based "stale" would silently stop a
// studio's texts after N days. The check is re-run when evidence is recorded
// and at cutover instead.
// ===========================================================================

/**
 * The recorded campaign status. `suspended` and `unrecognized` (a provider
 * status Hone does not know yet) are recorded as non-verified, never dropped,
 * so a campaign that stops being verified replaces a verified record.
 */
export type CampaignStatus = "verified" | "pending" | "in_progress" | "failed" | "suspended" | "unrecognized" | "none";

export type RecordedCampaignBinding = {
  senderId: string;
  studioId: string;
  phoneNumber: string;
  messagingServiceSid: string;
  campaignSid: string | null;
  campaignStatus: CampaignStatus;
  checkedAt: string;
  verifiedAt: string | null;
};

export type BindingSender = {
  id: string;
  studioId: string;
  phoneNumber: string | null;
  messagingServiceSid: string | null;
  provisionedAt: string | null;
};

export type CampaignBindingVerdict =
  | { ok: true }
  | { ok: false; reason: "missing" | "mismatch" | "unverified" | "stale" };

const CAMPAIGN_STATUSES: ReadonlySet<string> = new Set<CampaignStatus>([
  "verified",
  "pending",
  "in_progress",
  "failed",
  "suspended",
  "unrecognized",
  "none",
]);

/** Canonical E.164 for a +1 NANP number, or null. Two nulls never match. */
function canonicalPhone(value: string | null | undefined): string | null {
  const c = classifyNanpNumber(value);
  return c.ok ? c.e164 : null;
}

/** An instant, or NaN for anything unparseable. */
function instant(value: string | null | undefined): number {
  return typeof value === "string" && value.trim() !== "" ? Date.parse(value) : Number.NaN;
}

export function campaignBindingVerdict(
  recorded: RecordedCampaignBinding | null,
  sender: BindingSender,
): CampaignBindingVerdict {
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

  if (recorded.campaignStatus !== "verified" || !recorded.campaignSid || !recorded.verifiedAt) {
    return { ok: false, reason: "unverified" };
  }

  const checked = instant(recorded.checkedAt);
  const verified = instant(recorded.verifiedAt);
  const provisioned = instant(sender.provisionedAt);
  if (Number.isNaN(checked) || Number.isNaN(verified) || Number.isNaN(provisioned) || checked < provisioned) {
    return { ok: false, reason: "stale" };
  }
  return { ok: true };
}

/** The snapshot's raw binding row (0229, get_live_studio_sms_sender_registration_state). */
type RawBinding = {
  sender_id?: unknown;
  studio_id?: unknown;
  phone_number?: unknown;
  messaging_service_sid?: unknown;
  campaign_sid?: unknown;
  campaign_status?: unknown;
  checked_at?: unknown;
  verified_at?: unknown;
};

const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/**
 * The snapshot's `campaign_bindings`, strictly.
 *   * ABSENT key (0217 applied without 0229): [] -- every verdict is then
 *     "missing", which still fails closed.
 *   * Anything else that is not a well-formed array of rows for the LISTED
 *     senders of THIS studio, one row per sender at most: null, which the
 *     caller turns into an unreadable snapshot.
 */
export function campaignBindingsFromSnapshot(
  snapshot: unknown,
  studioId: string,
  listedSenderIds: ReadonlySet<string>,
): RecordedCampaignBinding[] | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  if (!("campaign_bindings" in snapshot)) return [];
  const raw = (snapshot as { campaign_bindings?: unknown }).campaign_bindings;
  if (!Array.isArray(raw)) return null;

  const out: RecordedCampaignBinding[] = [];
  const seen = new Set<string>();
  for (const item of raw as RawBinding[]) {
    if (!item || typeof item !== "object") return null;
    const {
      sender_id,
      studio_id,
      phone_number,
      messaging_service_sid,
      campaign_sid,
      campaign_status,
      checked_at,
      verified_at,
    } = item;
    if (
      !isString(sender_id) ||
      studio_id !== studioId ||
      !listedSenderIds.has(sender_id) ||
      seen.has(sender_id) ||
      !isString(phone_number) ||
      !isString(messaging_service_sid) ||
      !(campaign_sid === null || isString(campaign_sid)) ||
      typeof campaign_status !== "string" ||
      !CAMPAIGN_STATUSES.has(campaign_status) ||
      !isString(checked_at) ||
      !(verified_at === null || isString(verified_at))
    ) {
      return null;
    }
    seen.add(sender_id);
    out.push({
      senderId: sender_id,
      studioId,
      phoneNumber: phone_number,
      messagingServiceSid: messaging_service_sid,
      campaignSid: campaign_sid,
      campaignStatus: campaign_status as CampaignStatus,
      checkedAt: checked_at,
      verifiedAt: verified_at,
    });
  }
  return out;
}
