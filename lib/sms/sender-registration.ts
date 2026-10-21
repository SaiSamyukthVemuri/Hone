import type { SupabaseClient } from "@supabase/supabase-js";
import { campaignBindingsFromSnapshot, type BindingSender, type RecordedCampaignBinding } from "./campaign-binding";
import { stopPreflightsFromSnapshot, type RecordedStopPreflight } from "./stop-preflight-record";
import { classifyNanpNumber } from "./nanp";
import type { UsRegistrationEvidence } from "./sender-readiness";

// ===========================================================================
// SMS-SENDER-REG-01 (#824): the US registration evidence recorded for a
// studio's live sender (migration 0217), as the readiness model consumes it.
// ===========================================================================
//
// The OWNER reads their own rows through their ORDINARY session client: 0217's
// owner policy and column grant decide what comes back, and the provider
// reference is not among the granted columns. This module never takes a
// service-role client and never writes.
//
// Which row matters depends on the NUMBER (#841's DESTINATION_RULES): any
// 10-digit long code, Canadian or US, is held to A2P 10DLC registration for
// US recipients; a toll-free number to toll-free verification. A row of the
// other kind says nothing about this number and is ignored.
//
// EVIDENCE IS PER NUMBER (Codex P2 4244484021): each row carries the number
// support verified. A row for any other number -- one the sender held before,
// or recorded before this number was assigned -- says nothing about the
// current number and is ignored, exactly as 0217's snapshot ignores it.
// ===========================================================================

export const REGISTRATION_KINDS = ["us_10dlc", "toll_free_verification"] as const;
export type RegistrationKind = (typeof REGISTRATION_KINDS)[number];

export const REGISTRATION_STATUSES = [
  "pending",
  "requires_information",
  "approved",
  "rejected",
  "suspended",
] as const;
export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

/** Exactly the columns 0217 grants to `authenticated`. */
export const OWNER_READABLE_REGISTRATION_COLUMNS = [
  "id",
  "studio_id",
  "sender_id",
  "phone_number",
  "kind",
  "status",
  "missing_information",
  "recorded_at",
  "updated_at",
] as const;

export type SenderRegistrationRow = {
  id: string;
  studio_id: string;
  sender_id: string;
  phone_number: string;
  kind: RegistrationKind;
  status: RegistrationStatus;
  missing_information: string | null;
  recorded_at: string;
  updated_at: string;
};

/** A failed read is not an absent registration (the same rule as the sender read). */
export type RegistrationRead =
  | { ok: true; rows: SenderRegistrationRow[] }
  | { ok: false };

export async function readOwnSenderRegistrations(
  client: SupabaseClient,
  senderId: string,
): Promise<RegistrationRead> {
  try {
    const { data, error } = await client
      .from("studio_sms_sender_registrations")
      .select(OWNER_READABLE_REGISTRATION_COLUMNS.join(", "))
      .eq("sender_id", senderId);
    if (error || !Array.isArray(data)) return { ok: false };
    return { ok: true, rows: data as unknown as SenderRegistrationRow[] };
  } catch {
    return { ok: false };
  }
}

/** The kind of registration a sender number is held to, if any. */
export function registrationKindFor(phoneNumber: string | null): RegistrationKind | null {
  const n = classifyNanpNumber(phoneNumber);
  if (!n.ok) return null;
  if (n.country === "US" || n.country === "CA") return "us_10dlc";
  if (n.country === "toll_free") return "toll_free_verification";
  return null;
}

/** The evidence the readiness model receives for this sender's number. */
export function registrationEvidenceFor(
  read: RegistrationRead,
  phoneNumber: string | null,
): UsRegistrationEvidence {
  const kind = registrationKindFor(phoneNumber);
  // Another NANP member, or an unclassifiable number, is not a supported sender.
  if (!kind) return { state: "not_recorded" };
  if (!read.ok) return { state: "unreadable" };
  const row = read.rows.find((r) => r.kind === kind && r.phone_number === phoneNumber);
  if (!row) return { state: "not_recorded" };
  switch (row.status) {
    case "requires_information":
      return { state: "requires_information", missing: row.missing_information ?? "details not recorded" };
    case "pending":
    case "approved":
    case "rejected":
    case "suspended":
      return { state: row.status };
  }
}

// ---------------------------------------------------------------------------
// The operator's snapshot (0217 get_live_studio_sms_sender_registration_state,
// extended additively by 0229 with provisioned_at and campaign_bindings)
// ---------------------------------------------------------------------------

export type LiveSenderSnapshot = {
  id: string;
  studio_id: string;
  status: string;
  phone_number: string | null;
  messaging_service_sid: string | null;
  /** 0229. Absent before 0229 is applied; read as unknown (null). */
  provisioned_at?: string | null;
};

export type LiveRegistrationSnapshot = {
  sender_id: string;
  studio_id: string;
  phone_number: string;
  kind: RegistrationKind;
  status: RegistrationStatus;
  missing_information: string | null;
  provider_reference: string | null;
  updated_at: string;
};

/**
 * One statement, one snapshot: the studio's live sender and exactly its
 * registrations. `ok: false` when the read failed OR its answer is not the
 * shape 0217 returns; a caller must then offer no write at all.
 */
export type LiveRegistrationState =
  | {
      ok: true;
      senders: LiveSenderSnapshot[];
      registrations: LiveRegistrationSnapshot[];
      /** 0229: the recorded campaign bindings of the listed senders (HON-50 G4a). */
      campaignBindings: RecordedCampaignBinding[];
      /** 0230: the recorded STOP preflights of the listed senders (HON-50 G6). */
      stopPreflights: RecordedStopPreflight[];
    }
  | { ok: false };

/** The snapshot sender as campaignBindingVerdict takes it. */
export function bindingSenderFrom(sender: LiveSenderSnapshot): BindingSender {
  return {
    id: sender.id,
    studioId: sender.studio_id,
    phoneNumber: sender.phone_number,
    messagingServiceSid: sender.messaging_service_sid,
    provisionedAt: sender.provisioned_at ?? null,
  };
}

/** The recorded binding for ONE sender, or null (the verdict's "missing"). */
export function campaignBindingFor(
  state: Extract<LiveRegistrationState, { ok: true }>,
  senderId: string,
): RecordedCampaignBinding | null {
  return state.campaignBindings.find((b) => b.senderId === senderId) ?? null;
}

/** The recorded STOP preflight for ONE sender, or null (the verdict's "missing"). */
export function stopPreflightFor(
  state: Extract<LiveRegistrationState, { ok: true }>,
  senderId: string,
): RecordedStopPreflight | null {
  return state.stopPreflights.find((p) => p.senderId === senderId) ?? null;
}

export function parseLiveRegistrationState(data: unknown, studioId: string): LiveRegistrationState {
  if (!data || typeof data !== "object") return { ok: false };
  const { senders, registrations } = data as { senders?: unknown; registrations?: unknown };
  if (!Array.isArray(senders) || !Array.isArray(registrations)) return { ok: false };
  const ownSenders = senders as LiveSenderSnapshot[];
  // Anything about another studio is a broken answer, never a row to show.
  if (ownSenders.some((s) => s?.studio_id !== studioId)) return { ok: false };
  const numbers = new Map(ownSenders.map((s) => [s.id, s.phone_number]));
  const rows = registrations as LiveRegistrationSnapshot[];
  // A row must be about a listed sender AND the number that sender holds now.
  if (
    rows.some(
      (r) =>
        r?.studio_id !== studioId ||
        !numbers.has(r.sender_id) ||
        r.phone_number == null ||
        r.phone_number !== numbers.get(r.sender_id),
    )
  ) {
    return { ok: false };
  }
  // 0229: two rows for one sender, a binding for an unlisted sender, or a
  // malformed array make the WHOLE read unreadable; an absent key is [].
  const listed = new Set(ownSenders.map((s) => s.id));
  const campaignBindings = campaignBindingsFromSnapshot(data, studioId, listed);
  if (!campaignBindings) return { ok: false };
  // 0230 (HON-50 G6), same strictness, parsed AFTER the bindings: a failure in
  // either makes the WHOLE read unreadable; an absent key is [].
  const stopPreflights = stopPreflightsFromSnapshot(data, studioId, listed);
  if (!stopPreflights) return { ok: false };
  return { ok: true, senders: ownSenders, registrations: rows, campaignBindings, stopPreflights };
}
