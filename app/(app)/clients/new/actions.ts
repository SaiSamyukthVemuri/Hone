"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { captureServerEvent } from "@/lib/analytics/server";

function nullableString(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function nullableInt(value: FormDataEntryValue | null): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

// Result type for the new-client save action. Validation errors,
// duplicate-email collisions, and unexpected DB failures all return
// { ok: false, error } so the practitioner form can render a clean
// banner instead of crashing on the production server-action error
// redaction. Successful saves call redirect() and never return; the
// `void` half of the union covers that path for TypeScript. See the
// matching update action in app/(app)/clients/[id]/actions.ts for
// the explanation of why this isn't a throw.
export type ClientSaveResult = { ok: false; error: string };

const ACTIVE_DUPLICATE_ERROR =
  "That email is already used by another active client. Use a different email or archive the duplicate client first.";
const ARCHIVED_DUPLICATE_ERROR =
  "That email belongs to an archived client. Unarchive that client or use a different email.";
const GENERIC_SAVE_ERROR = "Couldn't save the client. Please try again.";

function isClientDuplicateEmailDbError(
  error: { code?: string | null; message?: string | null } | null | undefined,
): boolean {
  if (!error) return false;
  if (error.code !== "23505") return false;
  const msg = (error.message ?? "").toLowerCase();
  return (
    msg.includes("clients_studio_normalized_email_uniq") ||
    msg.includes("normalized_email")
  );
}

export async function createClientAction(
  formData: FormData,
): Promise<ClientSaveResult | void> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();

  const name = nullableString(formData.get("name"));
  if (!name) {
    return { ok: false, error: "Name is required." };
  }

  const email = nullableString(formData.get("email"));

  const supabase = await createClient();

  // Pre-flight duplicate-email check. Same studio-scoped lookup
  // pattern as the update action; no client id to exclude here
  // because the row is being created. Surfaces "active" vs
  // "archived" copy separately so the practitioner can act on the
  // right client (the unique index does not distinguish).
  if (email) {
    const normalized = email.trim().toLowerCase();
    if (normalized.length > 0) {
      const { data: dup, error: lookupErr } = await supabase
        .from("clients")
        .select("id, archived_at")
        .eq("studio_id", studio.id)
        .eq("normalized_email", normalized)
        .limit(1);
      if (lookupErr) {
        console.error(
          JSON.stringify({
            event: "client_create_duplicate_lookup_failed",
            code: lookupErr.code,
            message: lookupErr.message,
            timestamp: new Date().toISOString(),
          }),
        );
        return { ok: false, error: GENERIC_SAVE_ERROR };
      }
      if (dup && dup.length > 0) {
        const found = dup[0];
        return {
          ok: false,
          error: found.archived_at != null
            ? ARCHIVED_DUPLICATE_ERROR
            : ACTIVE_DUPLICATE_ERROR,
        };
      }
    }
  }

  const { data, error } = await supabase
    .from("clients")
    .insert({
      studio_id: studio.id,
      name,
      pronouns: nullableString(formData.get("pronouns")),
      phone: nullableString(formData.get("phone")),
      email,
      address: nullableString(formData.get("address")),
      date_of_birth: nullableString(formData.get("date_of_birth")),
      fitzpatrick_type: nullableInt(formData.get("fitzpatrick_type")),
      // Chloe Session 1A: `clients.skin_notes` is RETIRED as a practitioner
      // editor. It is no longer submitted by the client form and is no longer
      // written here, so an ordinary client edit can never overwrite historical
      // clinical text that carries no author, date or revision lineage. The
      // column and its data are untouched; new skin/hair observations are
      // recorded as append-only client_clinical_notes (kind=skin_hair_analysis).
      allergies: nullableString(formData.get("allergies")),
      emergency_contact_name: nullableString(
        formData.get("emergency_contact_name"),
      ),
      emergency_contact_phone: nullableString(
        formData.get("emergency_contact_phone"),
      ),
      created_by: practitioner.id,
    })
    .select("id")
    .single();

  if (error || !data) {
    if (isClientDuplicateEmailDbError(error)) {
      // Race fallback: a concurrent insert tripped the unique index
      // between the pre-flight check and our insert. Re-look up the
      // winner without the archived filter to surface the correct
      // copy; if the row vanished mid-flight (extremely unlikely)
      // fall back to the active-duplicate message which is the
      // safer assumption.
      if (email) {
        const normalized = email.trim().toLowerCase();
        const { data: winner } = await supabase
          .from("clients")
          .select("id, archived_at")
          .eq("studio_id", studio.id)
          .eq("normalized_email", normalized)
          .limit(1);
        if (winner && winner.length > 0 && winner[0].archived_at != null) {
          return { ok: false, error: ARCHIVED_DUPLICATE_ERROR };
        }
      }
      return { ok: false, error: ACTIVE_DUPLICATE_ERROR };
    }
    console.error(
      JSON.stringify({
        event: "client_create_failed",
        code: error?.code,
        message: error?.message,
        timestamp: new Date().toISOString(),
      }),
    );
    return { ok: false, error: GENERIC_SAVE_ERROR };
  }

  // Post-response, bounded, never blocks or fails the committed create.
  captureServerEvent({
    actor: { kind: "user", id: practitioner.id },
    event: "client_created",
    properties: { studio_id: studio.id },
  });

  revalidatePath("/clients");
  revalidatePath("/dashboard");
  redirect(`/clients/${data.id}`);
}
