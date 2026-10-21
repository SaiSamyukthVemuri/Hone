import { afterEach, beforeEach } from "vitest";
import { classifyNanpNumber } from "@/lib/sms/nanp";
import type { RecordedCampaignBinding } from "@/lib/sms/campaign-binding";
import type { RecordedStopPreflight } from "@/lib/sms/stop-preflight-record";
import { STOP_PREFLIGHT_CHECKLIST, STOP_PREFLIGHT_CHECKLIST_VERSION } from "@/lib/sms/inbound-stop-preflight";

/** The COMPLETE current STOP checklist, every check passing (Codex P1 4304864063). */
export const PASSING_CHECKLIST = STOP_PREFLIGHT_CHECKLIST.map((id) => ({ id, status: "pass" as const }));

// ===========================================================================
// HON-50 G6/G7 test fixture: a READY studio sender is now one whose STOP path
// was proven (0230) and, for a 10DLC long code, whose US campaign binding was
// verified (0229), both recorded after it was provisioned.
// ===========================================================================
//
// Suites written before G6/G7 (#858's routing, ordering and recovery tests)
// describe a ready sender without those records, and are about OTHER rules.
// These helpers complete such a snapshot, and ONLY where a key is absent: a
// test that sets `stop_preflights` / `campaign_bindings` (or the read's
// `stopPreflights` / `campaignBindings`) keeps full control, which is how the
// G6/G7 refusals are tested (tests/lib/sms/send-time-stop-preflight.test.ts,
// send-time-campaign-binding.test.ts).

export const TEST_WEBHOOK_BASE = "https://hone.test";
export const PROVISIONED_AT = "2026-10-01T10:00:00.000Z";
const CHECKED_AT = "2026-10-02T10:00:00.000Z";

/** The env the proven fixtures were "evaluated" against, set for each test. */
export function withProvenSenderEnv(): void {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.TWILIO_WEBHOOK_BASE_URL;
    process.env.TWILIO_WEBHOOK_BASE_URL = TEST_WEBHOOK_BASE;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.TWILIO_WEBHOOK_BASE_URL;
    else process.env.TWILIO_WEBHOOK_BASE_URL = saved;
  });
}

type AnySender = {
  id?: unknown;
  studio_id?: unknown;
  status?: unknown;
  phone_number?: unknown;
  messaging_service_sid?: unknown;
  provisioned_at?: unknown;
};

const usable = (s: AnySender) =>
  !!s && typeof s === "object" && s.status === "active" && typeof s.phone_number === "string" && typeof s.messaging_service_sid === "string";

const isLongCode = (phone: string) => {
  const c = classifyNanpNumber(phone);
  return c.ok && (c.country === "US" || c.country === "CA");
};

export function provenStopPreflight(s: { id: string; studio_id: string; phone_number: string; messaging_service_sid: string }): RecordedStopPreflight {
  return {
    senderId: s.id,
    studioId: s.studio_id,
    phoneNumber: s.phone_number,
    messagingServiceSid: s.messaging_service_sid,
    ready: true,
    checklistVersion: STOP_PREFLIGHT_CHECKLIST_VERSION,
    checks: PASSING_CHECKLIST.map((c) => ({ ...c })),
    webhookBase: TEST_WEBHOOK_BASE,
    credentialsEpoch: null,
    checkedAt: CHECKED_AT,
  };
}

export function verifiedBinding(s: { id: string; studio_id: string; phone_number: string; messaging_service_sid: string }): RecordedCampaignBinding {
  return {
    senderId: s.id,
    studioId: s.studio_id,
    phoneNumber: s.phone_number,
    messagingServiceSid: s.messaging_service_sid,
    campaignSid: `QE${"c".repeat(32)}`,
    campaignStatus: "verified",
    checkedAt: CHECKED_AT,
    verifiedAt: CHECKED_AT,
  };
}

/** Complete a decided READ (the injected-reader shape). */
export function provenRead<T>(read: T): T {
  const r = read as unknown as { ok?: boolean; senders?: unknown; stopPreflights?: unknown; campaignBindings?: unknown };
  if (!r || r.ok !== true || !Array.isArray(r.senders)) return read;
  const senders = (r.senders as AnySender[]).map((s) =>
    s && typeof s === "object" && s.provisioned_at === undefined ? { ...s, provisioned_at: PROVISIONED_AT } : s,
  );
  const live = senders.filter(usable) as Array<Parameters<typeof provenStopPreflight>[0]>;
  return {
    ...r,
    senders,
    ...(r.stopPreflights === undefined ? { stopPreflights: live.map(provenStopPreflight) } : {}),
    ...(r.campaignBindings === undefined
      ? { campaignBindings: live.filter((s) => isLongCode(s.phone_number)).map(verifiedBinding) }
      : {}),
  } as unknown as T;
}

/** Complete an RPC ANSWER ({ data, error }) of the 0217/0229/0230 snapshot. */
export function provenSnapshot<T>(answer: T): T {
  const a = answer as unknown as { data?: unknown; error?: unknown };
  if (!a || typeof a !== "object" || a.error || !a.data || typeof a.data !== "object") return answer;
  const d = a.data as { senders?: unknown; stop_preflights?: unknown; campaign_bindings?: unknown };
  if (!Array.isArray(d.senders)) return answer;
  const senders = (d.senders as AnySender[]).map((s) =>
    s && typeof s === "object" && s.provisioned_at === undefined ? { ...s, provisioned_at: PROVISIONED_AT } : s,
  );
  const live = senders.filter(usable) as Array<Parameters<typeof provenStopPreflight>[0]>;
  const rawPreflight = (s: Parameters<typeof provenStopPreflight>[0]) => {
    const p = provenStopPreflight(s);
    return {
      sender_id: p.senderId,
      studio_id: p.studioId,
      phone_number: p.phoneNumber,
      messaging_service_sid: p.messagingServiceSid,
      ready: p.ready,
      checklist_version: p.checklistVersion,
      checks: p.checks,
      webhook_base: p.webhookBase,
      credentials_epoch: p.credentialsEpoch,
      checked_at: p.checkedAt,
    };
  };
  const rawBinding = (s: Parameters<typeof verifiedBinding>[0]) => {
    const b = verifiedBinding(s);
    return {
      sender_id: b.senderId,
      studio_id: b.studioId,
      phone_number: b.phoneNumber,
      messaging_service_sid: b.messagingServiceSid,
      campaign_sid: b.campaignSid,
      campaign_status: b.campaignStatus,
      checked_at: b.checkedAt,
      verified_at: b.verifiedAt,
    };
  };
  return {
    ...a,
    data: {
      ...d,
      senders,
      ...("stop_preflights" in d ? {} : { stop_preflights: live.map(rawPreflight) }),
      ...("campaign_bindings" in d ? {} : { campaign_bindings: live.filter((s) => isLongCode(s.phone_number)).map(rawBinding) }),
    },
  } as unknown as T;
}
