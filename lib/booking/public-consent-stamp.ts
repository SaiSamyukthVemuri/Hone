import type { SupabaseClient } from "@supabase/supabase-js";

// ===========================================================================
// G3 / 0211 follow-up: the public booking's consent stamp on an EXISTING
// client, as a first write that cannot lose a race.
// ===========================================================================
//
// 0211 makes consent evidence write-once for every role: once
// sms_consent_at is set it is never re-timed. Two overlapping public bookings
// for the same unconsented client both read consent as null; before this
// helper each issued an unconditional UPDATE, and the second now fails the
// guard (23514). The booking treated that as a soft failure and kept its stale
// null, so that appointment's confirmation SMS was skipped although consent
// was on record (Codex P2 on #827).
//
// Now the stamp is CONDITIONAL (`sms_consent_at is null`, and no opt-out), so
// the losing write matches no row and never reaches the guard. Whoever loses,
// or finds a STOP that landed meanwhile, re-reads the row and adopts what is
// on record: the winner's consent, and any opt-out. Consent evidence stays
// the FIRST write; nothing is re-timed.
//
// Never throws. A database error is reported as `error` for the caller's
// sanitized log; the caller then keeps what it already had, as before.

export type ConsentStampResult =
  /** This booking recorded consent. */
  | { result: "stamped"; smsConsentAt: string; smsOptedOutAt: null }
  /** Another writer got there first, or a STOP landed: what is on record now. */
  | { result: "already_recorded"; smsConsentAt: string | null; smsOptedOutAt: string | null }
  | { result: "error"; code: string | null };

export async function stampPublicBookingConsent(
  admin: SupabaseClient,
  clientId: string,
  nowIso: string,
  /**
   * 0368 FRESH CONSENT. Set when the client already has a consent that was given for a DIFFERENT number (the stored number changed after it):
   * the value is the number that consent is bound to. The write is then a compare-and-set on that bound number, so an overlapping booking
   * that already replaced it matches no row (and is adopted below), and the database accepts it only for a later consent, a different
   * number and no STOP. Omit it for a first consent.
   */
  replacingBoundPhone?: string,
): Promise<ConsentStampResult> {
  try {
    const target = admin
      .from("clients")
      .update({ sms_consent_at: nowIso, sms_consent_source: "public_booking" })
      .eq("id", clientId);
    const { data, error } = await (replacingBoundPhone === undefined
      ? target.is("sms_consent_at", null)
      : target.eq("sms_consent_phone", replacingBoundPhone)
    )
      .is("sms_opted_out_at", null)
      .select("sms_consent_at");
    if (error) return { result: "error", code: error.code ?? null };
    if (Array.isArray(data) && data.length === 1) {
      return { result: "stamped", smsConsentAt: nowIso, smsOptedOutAt: null };
    }

    const { data: current, error: readErr } = await admin
      .from("clients")
      .select("sms_consent_at, sms_opted_out_at")
      .eq("id", clientId)
      .maybeSingle();
    if (readErr || !current) return { result: "error", code: readErr?.code ?? null };
    const row = current as { sms_consent_at: string | null; sms_opted_out_at: string | null };
    return {
      result: "already_recorded",
      smsConsentAt: row.sms_consent_at ?? null,
      smsOptedOutAt: row.sms_opted_out_at ?? null,
    };
  } catch {
    return { result: "error", code: null };
  }
}
