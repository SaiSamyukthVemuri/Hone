import type { SupabaseClient } from "@supabase/supabase-js";
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
  const row = read.rows.find((r) => r.kind === kind);
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
// The operator's snapshot (0217 get_live_studio_sms_sender_registration_state)
// ---------------------------------------------------------------------------

export type LiveSenderSnapshot = {
  id: string;
  studio_id: string;
  status: string;
  phone_number: string | null;
  messaging_service_sid: string | null;
};

export type LiveRegistrationSnapshot = {
  sender_id: string;
  studio_id: string;
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
  | { ok: true; senders: LiveSenderSnapshot[]; registrations: LiveRegistrationSnapshot[] }
  | { ok: false };

export function parseLiveRegistrationState(data: unknown, studioId: string): LiveRegistrationState {
  if (!data || typeof data !== "object") return { ok: false };
  const { senders, registrations } = data as { senders?: unknown; registrations?: unknown };
  if (!Array.isArray(senders) || !Array.isArray(registrations)) return { ok: false };
  const ownSenders = senders as LiveSenderSnapshot[];
  // Anything about another studio is a broken answer, never a row to show.
  if (ownSenders.some((s) => s?.studio_id !== studioId)) return { ok: false };
  const ids = new Set(ownSenders.map((s) => s.id));
  const rows = registrations as LiveRegistrationSnapshot[];
  if (rows.some((r) => r?.studio_id !== studioId || !ids.has(r.sender_id))) return { ok: false };
  return { ok: true, senders: ownSenders, registrations: rows };
}

export async function readLiveRegistrationState(
  admin: SupabaseClient,
  studioId: string,
): Promise<LiveRegistrationState> {
  try {
    const { data, error } = await admin.rpc("get_live_studio_sms_sender_registration_state", {
      p_studio_id: studioId,
    });
    if (error) return { ok: false };
    return parseLiveRegistrationState(data, studioId);
  } catch {
    return { ok: false };
  }
}
