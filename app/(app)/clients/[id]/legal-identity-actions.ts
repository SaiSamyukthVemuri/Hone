"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { parseLegalIdentity } from "@/lib/clients/identity";
import { dbErrorCode } from "@/lib/logging/error-class";

// HON-58: staff record a client's LEGAL identity (clinical and insurer output).
// It is stored beside, never instead of, the client's stored and preferred
// names, on the same client. Never inferred from an insurer response; there is
// no import and no backfill.
//
// Who may: an active owner or practitioner (getCurrentPractitionerWithStudio
// only resolves a practitioners row, so a receptionist, who is not one, never
// reaches the write), and the database enforces the same rule on its own
// (client_legal_identities RLS through can_use_client_legal_identity). This
// action uses the signed-in client only, never an admin client. Nothing here
// logs a name.

export type LegalNameParts = { given: string; middle: string; family: string };
/** What the page loaded from the database: each part as stored (null when blank), or null when there was no row. */
export type LegalStoredBaseline = { given: string | null; middle: string | null; family: string | null } | null;

export type LegalIdentitySaveResult =
  | { ok: true; /** The normalised values now stored: the form adopts them as its new baseline. */ value: LegalNameParts }
  | { ok: false; error: string; /** Set when someone else changed the legal name after this page loaded. */ current?: LegalNameParts | null };

const GENERIC = "Couldn't save the legal name. Please try again.";
const STALE = "This page is out of date. Reload it and make your change again; nothing was saved.";
const CHANGED =
  "Someone else changed this legal name after you opened this page. Nothing was saved. Review it below.";

const part = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** The loaded values, strictly: "none" (no row at load) or {given, middle, family} of string|null. */
function parseLegalBaseline(raw: unknown): LegalStoredBaseline | undefined {
  if (raw === "none") return null;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2_000) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const r = v as Record<string, unknown>;
  for (const k of ["given", "middle", "family"]) {
    if (!(k in r) || (r[k] !== null && typeof r[k] !== "string")) return undefined;
  }
  return { given: part(r.given), middle: part(r.middle), family: part(r.family) };
}

type StoredRow = { legal_given_name: string | null; legal_middle_name: string | null; legal_family_name: string | null };
const toParts = (r: StoredRow): LegalNameParts => ({
  given: r.legal_given_name ?? "",
  middle: r.legal_middle_name ?? "",
  family: r.legal_family_name ?? "",
});

export async function saveLegalIdentityAction(formData: FormData): Promise<LegalIdentitySaveResult> {
  const clientId = formData.get("client_id");
  if (typeof clientId !== "string" || !clientId) return { ok: false, error: "Missing client id." };

  const parsed = parseLegalIdentity({
    given: formData.get("legal_given_name"),
    middle: formData.get("legal_middle_name"),
    family: formData.get("legal_family_name"),
  });
  if (!parsed.ok) return { ok: false, error: parsed.error };

  // What this page loaded. Without it the form is an older or foreign one: refuse before reading or writing.
  const baseline = parseLegalBaseline(formData.get("legal_baseline"));
  if (baseline === undefined) return { ok: false, error: STALE };

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  const supabase = await createClient();

  // The client must be this studio's. (The composite foreign key refuses a
  // mismatch too; this gives the practitioner a clean message first.)
  const { data: client, error: clientErr } = await supabase
    .from("clients")
    .select("id")
    .eq("id", clientId)
    .eq("studio_id", studio.id)
    .maybeSingle();
  if (clientErr) {
    console.error(JSON.stringify({ event: "legal_identity_client_read_failed", code: dbErrorCode(clientErr), timestamp: new Date().toISOString() }));
    return { ok: false, error: GENERIC };
  }
  if (!client) return { ok: false, error: "Client not found." };

  // Conditional write, never a blind upsert: insert only when there was no row at load (a row that appeared
  // meanwhile refuses the insert), update only while every part still holds what the page loaded. Zero rows or a
  // unique violation is "changed by someone else"; nothing is claimed saved.
  const writeError = async (): Promise<{ conflict: boolean; failed: boolean; code?: string }> => {
    if (baseline === null) {
      const { error } = await supabase.from("client_legal_identities").insert({
        client_id: clientId,
        studio_id: studio.id,
        ...parsed.value,
        source: "staff_entry",
        updated_by: practitioner.id,
      });
      if (error) return error.code === "23505" ? { conflict: true, failed: false } : { conflict: false, failed: true, code: dbErrorCode(error) };
      return { conflict: false, failed: false };
    }
    let update = supabase
      .from("client_legal_identities")
      .update({ ...parsed.value, updated_by: practitioner.id })
      .eq("client_id", clientId)
      .eq("studio_id", studio.id);
    const cond: Array<[string, string | null]> = [
      ["legal_given_name", baseline.given],
      ["legal_middle_name", baseline.middle],
      ["legal_family_name", baseline.family],
    ];
    for (const [col, value] of cond) update = value === null ? update.is(col, null) : update.eq(col, value);
    const { data, error } = await update.select("client_id");
    if (error) return { conflict: false, failed: true, code: dbErrorCode(error) };
    return { conflict: !data || data.length === 0, failed: false };
  };

  const outcome = await writeError();
  if (outcome.failed) {
    console.error(JSON.stringify({ event: "legal_identity_save_failed", code: outcome.code, timestamp: new Date().toISOString() }));
    return { ok: false, error: GENERIC };
  }
  if (outcome.conflict) {
    const { data: now, error: readErr } = await supabase
      .from("client_legal_identities")
      .select("legal_given_name, legal_middle_name, legal_family_name")
      .eq("client_id", clientId)
      .eq("studio_id", studio.id)
      .maybeSingle();
    if (readErr || !now) return { ok: false, error: GENERIC };
    return { ok: false, error: CHANGED, current: toParts(now as StoredRow) };
  }

  revalidatePath(`/clients/${clientId}`);
  revalidatePath(`/clients/${clientId}/edit`);
  return {
    ok: true,
    value: {
      given: parsed.value.legal_given_name ?? "",
      middle: parsed.value.legal_middle_name ?? "",
      family: parsed.value.legal_family_name ?? "",
    },
  };
}
