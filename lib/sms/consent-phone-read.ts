import type { SupabaseClient } from "@supabase/supabase-js";

/** The marker the database uses for "a consent with no number". It never equals a destination, so the consent gate refuses it. */
export const CONSENT_PHONE_UNKNOWN = "-";

/**
 * The number a client's SMS consent was given for (clients.sms_consent_phone), read fresh for the send that is about to
 * happen. Used where a caller does not already hold the client row (the public booking, whose commands do not return it).
 *
 * FAIL CLOSED. A missing row or a failed read returns the marker, which the gate refuses: an unreadable binding must never read as
 * "legacy consent, allowed". With no consent on record there is nothing to bind, so it returns null and the consent check decides.
 */
export async function readClientConsentPhone(
  admin: SupabaseClient,
  clientId: string | null,
  consentAt: string | null,
): Promise<string | null> {
  if (!consentAt) return null;
  if (!clientId) return CONSENT_PHONE_UNKNOWN;
  try {
    const { data, error } = await admin.from("clients").select("sms_consent_phone").eq("id", clientId).maybeSingle();
    if (error || !data) return CONSENT_PHONE_UNKNOWN;
    const value = (data as { sms_consent_phone: string | null }).sms_consent_phone;
    return value ?? null;
  } catch {
    return CONSENT_PHONE_UNKNOWN;
  }
}
