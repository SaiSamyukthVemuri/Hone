import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isPhoneSuppressedPhoneWide, type SuppressionCandidate } from "./suppression";

// ===========================================================================
// 0208 — PHONE-WIDE STOP, READ AT THE MOMENT IT MATTERS
// ===========================================================================
//
// STOP stamps every matching client and prospect row that exists when it
// arrives. A row created LATER with the same number carries no stamp, so a
// consent recorded or ticked against that number afterwards would otherwise
// look textable. This reads the stamps that already exist, anywhere, and asks
// the one phone-matching law whether this number is among them.
//
// THE CANDIDATE SOURCES ARE THE STOP ROUTE'S OWN: opted-out `clients` (the
// service role reads that table) and `waitlist_prospect_suppression_candidates`
// (0202; prospects are readable only through that command). The match is
// `selectHoneSuppressionTargets`, in TypeScript, as 0202 requires.
//
// FAIL-CLOSED. A read that fails answers `{ ok: false }`: the caller does not
// text, and says so honestly rather than guessing either way.
//
// THE SAME CEILING AS THE STOP ROUTE: both read the prospect candidates through
// one PostgREST call, which is bounded by the API's row limit. At pilot scale
// that is far above the table's size; a normalized-phone index is the
// follow-up both share.
//
// PII. Nothing here logs a number.
// ===========================================================================

export type PhoneSuppressionAnswer = { ok: true; suppressed: boolean } | { ok: false };

export async function lookupPhoneWideSuppression(
  admin: SupabaseClient,
  phone: string,
): Promise<PhoneSuppressionAnswer> {
  try {
    const [clients, prospects] = await Promise.all([
      admin
        .from("clients")
        .select("id, studio_id, phone, sms_opted_out_at")
        .not("phone", "is", null)
        .not("sms_opted_out_at", "is", null),
      admin.rpc("waitlist_prospect_suppression_candidates"),
    ]);
    if (clients.error || prospects.error) return { ok: false };

    const optedOutProspects = ((prospects.data ?? []) as SuppressionCandidate[]).filter(
      (row) => Boolean(row.sms_opted_out_at),
    );
    const candidates: SuppressionCandidate[] = [
      ...((clients.data ?? []) as SuppressionCandidate[]),
      ...optedOutProspects,
    ];
    return { ok: true, suppressed: isPhoneSuppressedPhoneWide({ candidates, phone }) };
  } catch {
    return { ok: false };
  }
}
