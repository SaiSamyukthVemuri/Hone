"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { parsePreferredName } from "@/lib/clients/identity";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { captureServerEvent } from "@/lib/analytics/server";
import {
  findPossibleDuplicateClient,
  type PossibleDuplicate,
} from "@/lib/clients/possible-duplicate";
import { dbErrorCode } from "@/lib/logging/error-class";

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
//
// HON-58: `possibleDuplicates` lists EVERY client in the studio with the same
// phone, or the same name and date of birth. Nothing was inserted; the form
// offers "Save as a new client anyway", which resubmits with one
// confirm_possible_duplicate value per listed client.
export type ClientSaveResult = {
  ok: false;
  error: string;
  possibleDuplicates?: PossibleDuplicate[];
};

const ACTIVE_DUPLICATE_ERROR =
  "That email is already used by another active client. Use a different email or archive the duplicate client first.";
const ARCHIVED_DUPLICATE_ERROR =
  "That email belongs to an archived client. Unarchive that client or use a different email.";
const GENERIC_SAVE_ERROR = "Couldn't save the client. Please try again.";

function possibleDuplicatesMessage(duplicates: PossibleDuplicate[]): string {
  const describe = (d: PossibleDuplicate) =>
    `${d.archived ? "an archived client, " : ""}${d.clientName} (${
      d.reason === "phone" ? "same phone number" : "same name and date of birth"
    })`;
  if (duplicates.length === 1) {
    return `This may be the same person as ${describe(duplicates[0])}.`;
  }
  return `This may be the same person as one of ${duplicates.length} existing clients: ${duplicates
    .map(describe)
    .join("; ")}.`;
}

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

  const preferred = parsePreferredName(formData.get("preferred_name"));
  if (!preferred.ok) return { ok: false, error: preferred.error };

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
            code: dbErrorCode(lookupErr),
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

  // HON-58: probable-duplicate warning (same phone, or same name + date of
  // birth). Advisory, so the create proceeds only when EVERY current match
  // was confirmed by id (Team L1: confirming one must not pass another);
  // a confirmation never covers a client it does not name.
  // A failed read refuses the create rather than implying "no duplicate".
  const phone = nullableString(formData.get("phone"));
  const dateOfBirth = nullableString(formData.get("date_of_birth"));
  const duplicateCheck = await findPossibleDuplicateClient(supabase, studio.id, {
    name,
    phone,
    dateOfBirth,
  });
  if (duplicateCheck.kind === "unavailable") {
    console.error(
      JSON.stringify({
        event: "client_create_possible_duplicate_lookup_failed",
        code: duplicateCheck.code,
        timestamp: new Date().toISOString(),
      }),
    );
    return { ok: false, error: GENERIC_SAVE_ERROR };
  }
  if (duplicateCheck.kind === "match") {
    const confirmed = new Set(formData.getAll("confirm_possible_duplicate"));
    const duplicates = duplicateCheck.duplicates;
    if (duplicates.some((d) => !confirmed.has(d.clientId))) {
      return {
        ok: false,
        error: possibleDuplicatesMessage(duplicates),
        possibleDuplicates: duplicates,
      };
    }
  }

  const { data, error } = await supabase
    .from("clients")
    .insert({
      studio_id: studio.id,
      name,
      // HON-58: the name the client goes by, on the SAME client record (null when blank).
      preferred_name: preferred.value,
      pronouns: nullableString(formData.get("pronouns")),
      phone,
      email,
      address: nullableString(formData.get("address")),
      date_of_birth: dateOfBirth,
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
        code: dbErrorCode(error),
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
