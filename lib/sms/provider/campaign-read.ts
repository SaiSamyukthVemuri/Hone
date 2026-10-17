import type { CampaignStatus } from "../campaign-binding";
import type { ProviderResult } from "./types";

// ===========================================================================
// SMS-CAMPAIGN-CHECK-01 (HON-50 G4b): READ-ONLY. Which US A2P campaign is a
// Messaging Service linked to, and what is that campaign's status?
// ===========================================================================
//
// Its own small port, deliberately NOT a member of SmsProvisioningProvider:
// this read never runs inside a provisioning attempt (no claim, no lease), so
// it does not belong in the fenced provisioning port (provider/fenced.ts) and
// adding it there would change #863's contract for no gain. Support runs it
// when recording evidence and again at cutover; the RESULT is recorded through
// 0229 (record_studio_sms_campaign_binding). The send path never calls it.
//
// The observation is normalised by one pure function, so the Twilio adapter
// and the fake cannot disagree about what a response means:
//   * no campaign on the service              -> { campaignSid: null, status: "none" }
//   * exactly one campaign, QE sid, known status -> that campaign
//   * anything else (several campaigns, a malformed SID or an unknown status,
//     a missing list)                          -> null: unreadable, NOTHING is recorded
// ===========================================================================

export type ObservedCampaign = { campaignSid: string | null; status: CampaignStatus };

export interface SmsCampaignReader {
  readUsA2pCampaign(input: { messagingServiceSid: string }): Promise<ProviderResult<{ campaign: ObservedCampaign }>>;
}

const QE_SID = /^QE[0-9a-fA-F]{32}$/;

/** Twilio's campaign_status values, and the 0229 status each records as. */
const STATUS: Readonly<Record<string, Exclude<CampaignStatus, "none">>> = {
  VERIFIED: "verified",
  PENDING: "pending",
  IN_PROGRESS: "in_progress",
  FAILED: "failed",
};

/**
 * The Usa2p list for one service (`{ compliance: [...] }`), normalised.
 * Pure; null means "do not record anything".
 */
export function normalizeUsA2pCampaigns(json: unknown): ObservedCampaign | null {
  if (!json || typeof json !== "object") return null;
  const list = (json as { compliance?: unknown }).compliance;
  if (!Array.isArray(list)) return null;
  if (list.length === 0) return { campaignSid: null, status: "none" };
  // A service carries at most one US A2P campaign. More than one is not a
  // state Hone can reason about, so it is unreadable rather than "the first".
  if (list.length !== 1) return null;
  const item = list[0] as { sid?: unknown; campaign_status?: unknown } | null;
  if (!item || typeof item !== "object") return null;
  if (typeof item.sid !== "string" || !QE_SID.test(item.sid)) return null;
  if (typeof item.campaign_status !== "string") return null;
  const status = STATUS[item.campaign_status];
  if (!status) return null;
  return { campaignSid: item.sid, status };
}
