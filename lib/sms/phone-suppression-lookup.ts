import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isPhoneSuppressedPhoneWide } from "./suppression";
import {
  readClientSuppressionCandidates,
  readProspectSuppressionCandidates,
} from "./suppression-candidates";

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
// THE CANDIDATE SOURCES ARE THE STOP ROUTE'S OWN, read through the same
// complete reader (lib/sms/suppression-candidates): opted-out `clients`, and
// opted-out prospects through 0202's `waitlist_prospect_suppression_candidates`
// (prospects are readable only through that command). The match is
// `selectHoneSuppressionTargets`, in TypeScript, as 0202 requires.
//
// COMPLETE OR FAIL-CLOSED (Codex P1 4234615485). Each source is read in keyset
// pages past the API's row limit. A failed, incomplete or bounded-out read
// answers `{ ok: false }`: the caller does not text, and says so honestly
// rather than guessing either way.
//
// PII. Nothing here logs a number.
// ===========================================================================

export type PhoneSuppressionAnswer = { ok: true; suppressed: boolean } | { ok: false };

export async function lookupPhoneWideSuppression(
  admin: SupabaseClient,
  phone: string,
): Promise<PhoneSuppressionAnswer> {
  const [clients, prospects] = await Promise.all([
    readClientSuppressionCandidates(admin, { optedOutOnly: true }),
    readProspectSuppressionCandidates(admin, { optedOutOnly: true }),
  ]);
  if (!clients.ok || !prospects.ok) return { ok: false };
  return {
    ok: true,
    suppressed: isPhoneSuppressedPhoneWide({
      candidates: [...clients.candidates, ...prospects.candidates],
      phone,
    }),
  };
}
