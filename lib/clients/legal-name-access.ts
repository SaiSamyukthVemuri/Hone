// HON-58 Q1 — the owner's per-studio switch for receptionist access to client
// legal names (migration 0266). OFF unless a row says otherwise.
//
// This module only reads and parses the SETTING for the owner's Settings card.
// It does NOT decide who may see a legal name: that is the database predicate
// public.can_read_client_legal_identity, evaluated on every read of
// client_legal_identities. So a receptionist's request gets no row (and the
// field is never sent) whenever the switch is OFF, with nothing cached here.
//
// Before 0266 exists the table is absent: that reads as `available: false`
// (the card is not shown), never as ON.

export type LegalNameAccessSetting =
  | { available: true; receptionistAccess: boolean }
  | { available: false };

type Reader = { from: (table: string) => unknown };
type Builder = {
  select: (columns: string) => {
    eq: (column: string, value: string) => { maybeSingle: () => PromiseLike<{ data: unknown; error: { code?: string | null; message?: string | null } | null }> };
  };
};

/** The switch for one studio. A failed read is reported as unavailable (card hidden), never as ON. */
export async function readLegalNameAccessSetting(supabase: Reader, studioId: string): Promise<LegalNameAccessSetting> {
  const { data, error } = await (supabase.from("studio_legal_name_access") as Builder)
    .select("receptionist_access")
    .eq("studio_id", studioId)
    .maybeSingle();
  if (error) return { available: false };
  const on = (data as { receptionist_access?: unknown } | null)?.receptionist_access === true;
  return { available: true, receptionistAccess: on };
}

/** Strict parse: only the literal "true" or "false" (never coerced). */
export function parseLegalNameAccessForm(formData: FormData): boolean | null {
  const v = formData.get("receptionist_legal_name_access");
  return v === "true" ? true : v === "false" ? false : null;
}
