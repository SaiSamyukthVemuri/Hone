import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeName } from "@/lib/import/quick-import";
import { normalizePhoneForSms } from "@/lib/sms/phone";

// HON-58: a probable-duplicate check for staff client create, on existing
// fields only (no schema). It mirrors the CSV import's CONFIDENT duplicate
// rules (lib/import/quick-import.ts matchExisting) apart from email, which
// staff create already enforces through the unique index:
//
//   * same phone: compared as E.164 through public.clients.sms_phone, the
//     stored SQL twin of normalizePhoneForSms (parity-proven in
//     tests/db/sms-phone-parity.db.test.ts), so "604.555.0199" matches
//     "(604) 555-0199";
//   * same name and same date of birth: the import's normalizeName (trim,
//     collapse spaces, lowercase) and an exact YYYY-MM-DD date.
//
// Same name alone stays a non-match, as it is only a weak warning in the
// import. EVERY match is returned, once per client (a client matching both
// rules is reported once, as a phone match), so the form can show them all
// and a confirmation can cover each one (Team review of #1084, L1). Archived clients are included, so a returning client is found.
// Studio scope is on every read. Only id, name and archived_at are read: the
// warning names the existing client, never their phone or date of birth.

export type PossibleDuplicateReason = "phone" | "name_dob";

export type PossibleDuplicate = {
  reason: PossibleDuplicateReason;
  clientId: string;
  clientName: string;
  archived: boolean;
};

export type PossibleDuplicateCheck =
  | { kind: "none" }
  | { kind: "match"; duplicates: PossibleDuplicate[] }
  | { kind: "unavailable"; code: string | null };

type Candidate = { id: string; name: string; archived_at: string | null };

const CANDIDATE_COLUMNS = "id, name, archived_at";
// A studio rarely holds more than a handful of people sharing one date of
// birth or one phone; this bounds the read, not the rule.
const CANDIDATE_LIMIT = 50;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function asDuplicate(reason: PossibleDuplicateReason, c: Candidate): PossibleDuplicate {
  return { reason, clientId: c.id, clientName: c.name, archived: c.archived_at != null };
}

export async function findPossibleDuplicateClient(
  supabase: SupabaseClient,
  studioId: string,
  input: { name: string; phone: string | null; dateOfBirth: string | null },
): Promise<PossibleDuplicateCheck> {
  const found = new Map<string, PossibleDuplicate>();
  const smsPhone = normalizePhoneForSms(input.phone);
  if (smsPhone) {
    const { data, error } = await supabase
      .from("clients")
      .select(CANDIDATE_COLUMNS)
      .eq("studio_id", studioId)
      .eq("sms_phone", smsPhone)
      .limit(CANDIDATE_LIMIT);
    if (error) return { kind: "unavailable", code: error.code ?? null };
    for (const c of (data ?? []) as Candidate[]) {
      if (!found.has(c.id)) found.set(c.id, asDuplicate("phone", c));
    }
  }

  const name = normalizeName(input.name);
  const dob = input.dateOfBirth?.trim() ?? "";
  if (name && ISO_DATE_RE.test(dob)) {
    const { data, error } = await supabase
      .from("clients")
      .select(CANDIDATE_COLUMNS)
      .eq("studio_id", studioId)
      .eq("date_of_birth", dob)
      .limit(CANDIDATE_LIMIT);
    if (error) return { kind: "unavailable", code: error.code ?? null };
    for (const c of (data ?? []) as Candidate[]) {
      if (normalizeName(c.name) === name && !found.has(c.id)) {
        found.set(c.id, asDuplicate("name_dob", c));
      }
    }
  }

  return found.size === 0 ? { kind: "none" } : { kind: "match", duplicates: [...found.values()] };
}
