import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { liveProvisioningArmed } from "./provider";
import { twilioCampaignReader } from "./provider/twilio-provider";
import type { SmsCampaignReader } from "./provider/campaign-read";
import { senderControlsFakeProvider, senderControlsGate } from "./sender-controls";
import { readLiveRegistrationState } from "./sender-registration-admin";

// ===========================================================================
// SMS-CAMPAIGN-CHECK-01 (HON-50 G4b): support checks a studio sender's US A2P
// campaign with the provider and RECORDS what it observed through 0229.
// ===========================================================================
//
// Which reader:
//   * live provisioning ARMED (HONE_SMS_PROVISIONING_LIVE + credentials): the
//     real, GET-only Twilio read. Not tied to the controls' live allowlist:
//     support checks a campaign BEFORE a studio is cut over;
//   * otherwise, where the sender controls' FAKE mode is open (local only):
//     that studio's fake;
//   * otherwise: not available. Nothing is read and nothing is recorded.
//
// The Messaging Service checked is the one the snapshot says the sender holds
// NOW, never a value from the browser. The 0229 command then refuses a sender
// that changed in between.
// ===========================================================================

export type CampaignCheckContext = "evidence" | "cutover";

export function campaignReaderFor(
  studioId: string,
  appOrigin: string,
  env: NodeJS.ProcessEnv = process.env,
  armed: () => boolean = liveProvisioningArmed,
): SmsCampaignReader | null {
  if (armed()) return twilioCampaignReader;
  if (senderControlsGate(env, armed).open) return senderControlsFakeProvider(appOrigin, studioId, env);
  return null;
}

export type CampaignCheckOutcome =
  | { result: "recorded"; status: string; campaignSid: string | null }
  | { result: "not_available" | "unreadable" | "sender_changed" | "no_service" }
  | { result: "provider_error"; code: string }
  | { result: "record_refused"; code: string }
  | { result: "outcome_unknown" };

export async function runCampaignCheck(
  deps: { admin: SupabaseClient; reader: SmsCampaignReader | null },
  input: { studioId: string; expectedSenderId: string; expectedPhone: string; context: CampaignCheckContext },
  progress: { dispatched: boolean } = { dispatched: false },
): Promise<CampaignCheckOutcome> {
  if (!deps.reader) return { result: "not_available" };

  const state = await readLiveRegistrationState(deps.admin, input.studioId);
  if (!state.ok) return { result: "unreadable" };
  const sender = state.senders.find((s) => s.id === input.expectedSenderId);
  if (!sender || sender.phone_number !== input.expectedPhone) return { result: "sender_changed" };
  if (!sender.messaging_service_sid) return { result: "no_service" };

  const read = await deps.reader.readUsA2pCampaign({ messagingServiceSid: sender.messaging_service_sid });
  if (!read.ok) return { result: "provider_error", code: read.code };

  progress.dispatched = true;
  let data: unknown;
  let error: unknown;
  try {
    ({ data, error } = await deps.admin.rpc("record_studio_sms_campaign_binding", {
      p_studio_id: input.studioId,
      p_expected_sender_id: input.expectedSenderId,
      p_expected_phone: input.expectedPhone,
      p_messaging_service_sid: sender.messaging_service_sid,
      p_campaign_sid: read.campaign.campaignSid,
      p_campaign_status: read.campaign.status,
      p_context: input.context,
    }));
  } catch {
    return { result: "outcome_unknown" };
  }
  const row = (Array.isArray(data) ? data[0] : null) as { result?: string } | null;
  // No readable answer is not a refusal: the write may have committed.
  if (error || !row?.result) return { result: "outcome_unknown" };
  if (row.result !== "recorded") return { result: "record_refused", code: row.result };
  return { result: "recorded", status: read.campaign.status, campaignSid: read.campaign.campaignSid };
}
