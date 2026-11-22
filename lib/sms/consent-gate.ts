import type { Client, Studio, SmsType } from "@/lib/types/database";
import { normalizePhoneForSms } from "./twilio";

// ---------------------------------------------------------------------------
// Shared consent gate
// ---------------------------------------------------------------------------

export type ConsentGateInput = {
  studio: Pick<
    Studio,
    // PR #155: "id" is included on the studio Pick so the SMS failure
    // path can stamp studio_id on the ops_alerts row without a second
    // DB roundtrip. The consent-gate logic itself only consults the
    // three send_*_sms toggles; "id" is metadata for downstream
    // logSmsFailure / recordOpsAlert calls.
    | "id"
    | "send_confirmation_sms"
    | "send_24h_sms_reminders"
    | "send_2h_sms_reminders"
  >;
  client: Pick<Client, "phone" | "sms_consent_at" | "sms_consent_phone" | "sms_opted_out_at">;
  smsType: SmsType;
};

type ConsentGateResult =
  | { ok: true; normalizedPhone: string }
  | { ok: false; reason: string };

/**
 * Centralizes the gate every SMS send must clear before we even
 * attempt to claim. Returns the normalized phone on success so the
 * caller does not have to re-normalize.
 */
export function passesConsentGate(input: ConsentGateInput): ConsentGateResult {
  const { studio, client, smsType } = input;

  const toggleOn =
    smsType === "confirmation"
      ? studio.send_confirmation_sms
      : smsType === "reminder_24h"
        ? studio.send_24h_sms_reminders
        : studio.send_2h_sms_reminders;
  if (!toggleOn) return { ok: false, reason: "studio_toggle_off" };

  if (client.sms_opted_out_at) {
    return { ok: false, reason: "client_opted_out" };
  }
  if (!client.sms_consent_at) {
    return { ok: false, reason: "client_no_consent" };
  }
  const normalized = normalizePhoneForSms(client.phone ?? null);
  if (!normalized) return { ok: false, reason: "invalid_phone" };
  // Migration 0368: a consent is for the number it was given for. A bound consent that does not match the number the client holds now does not
  // authorize this destination. A legacy consent (no bound number, null) is allowed as before, until its number is first changed. The caller
  // MUST pass the stored value: the field is required, so a caller that forgets it does not compile instead of reading as "legacy".
  if (client.sms_consent_phone !== null && client.sms_consent_phone !== normalized) {
    return { ok: false, reason: "consent_for_other_number" };
  }

  return { ok: true, normalizedPhone: normalized };
}

/** True when a confirmation SMS to this client would clear the full gate. */
export function confirmationSmsWillPass(
  studio: ConsentGateInput["studio"] | Record<string, unknown>,
  client: ConsentGateInput["client"],
): boolean {
  return passesConsentGate({
    studio: studio as ConsentGateInput["studio"],
    client,
    smsType: "confirmation",
  }).ok;
}
