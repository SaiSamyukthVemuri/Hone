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

export type LegalIdentitySaveResult = { ok: true } | { ok: false; error: string };

const GENERIC = "Couldn't save the legal name. Please try again.";

export async function saveLegalIdentityAction(formData: FormData): Promise<LegalIdentitySaveResult> {
  const clientId = formData.get("client_id");
  if (typeof clientId !== "string" || !clientId) return { ok: false, error: "Missing client id." };

  const parsed = parseLegalIdentity({
    given: formData.get("legal_given_name"),
    middle: formData.get("legal_middle_name"),
    family: formData.get("legal_family_name"),
  });
  if (!parsed.ok) return { ok: false, error: parsed.error };

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

  const { error } = await supabase.from("client_legal_identities").upsert(
    {
      client_id: clientId,
      studio_id: studio.id,
      ...parsed.value,
      source: "staff_entry",
      updated_by: practitioner.id,
    },
    { onConflict: "client_id" },
  );
  if (error) {
    console.error(JSON.stringify({ event: "legal_identity_save_failed", code: dbErrorCode(error), timestamp: new Date().toISOString() }));
    return { ok: false, error: GENERIC };
  }

  revalidatePath(`/clients/${clientId}`);
  revalidatePath(`/clients/${clientId}/edit`);
  return { ok: true };
}
