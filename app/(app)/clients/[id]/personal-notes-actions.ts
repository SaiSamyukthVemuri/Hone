"use server";

// Practitioner-only relationship-memory + sensitive-warning notes for
// a client. One row per client in public.client_personal_notes
// (migration 0035). The row is created lazily on first save via an
// upsert keyed on client_id; the UI shows an empty state until then.
//
// Privacy contract (the DB migration has the same comment; this file
// is the only authenticated write surface):
//   * The action runs server-side under the user-scoped Supabase
//     client (RLS-enforced). No createAdminClient.
//   * client_id is read from the form; the row's studio_id is derived
//     by the BEFORE INSERT/UPDATE trigger from the parent clients row,
//     so a tampered form cannot attach notes to a foreign studio.
//   * The action does NOT send emails, NOT touch intake, NOT touch
//     bookings or appointments, NOT touch Stripe/payments, NOT touch
//     require_card_on_file. It only writes the two text columns +
//     updated_by_practitioner_id.
//
// Import audit (enforced by safety greps in PR #27): nothing under
// app/book, lib/email, app/intake, app/cancel, app/reschedule,
// app/api/cron, or app/api/stripe imports this action.

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";

const MAX_NOTE_LENGTH = 20000;

export type PersonalNotesActionResult =
  | { ok: true }
  | { ok: false; error: string };

function readText(value: FormDataEntryValue | null): string {
  // Do NOT trim — practitioners may use leading whitespace to structure
  // their notes (sections, indented sub-points). The length cap is the
  // safeguard against runaway input.
  return typeof value === "string" ? value : "";
}

export async function updateClientPersonalNotesAction(
  formData: FormData,
): Promise<PersonalNotesActionResult> {
  const clientIdRaw = formData.get("client_id");
  const clientId =
    typeof clientIdRaw === "string" ? clientIdRaw.trim() : "";
  if (!clientId) return { ok: false, error: "Missing client id." };

  const personalNotes = readText(formData.get("personal_notes"));
  const privateWarnings = readText(formData.get("private_warnings"));

  if (personalNotes.length > MAX_NOTE_LENGTH) {
    return {
      ok: false,
      error: `Personal notes must be ${MAX_NOTE_LENGTH} characters or fewer.`,
    };
  }
  if (privateWarnings.length > MAX_NOTE_LENGTH) {
    return {
      ok: false,
      error: `Private warnings must be ${MAX_NOTE_LENGTH} characters or fewer.`,
    };
  }

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  const supabase = await createClient();

  // Verify client belongs to this studio. RLS would refuse a write
  // anyway, but this gives a cleaner error than an opaque RLS message
  // and confirms the client exists before we attempt the upsert.
  const { data: client, error: clientErr } = await supabase
    .from("clients")
    .select("id")
    .eq("id", clientId)
    .eq("studio_id", studio.id)
    .maybeSingle();
  if (clientErr) return { ok: false, error: clientErr.message };
  if (!client) return { ok: false, error: "Client not found." };

  // Upsert keyed on the unique(client_id) constraint from migration
  // 0035. studio_id is passed for documentation; the BEFORE trigger
  // overwrites it from the parent client row so callers can't drift it.
  const { error } = await supabase
    .from("client_personal_notes")
    .upsert(
      {
        client_id: clientId,
        studio_id: studio.id,
        personal_notes: personalNotes,
        private_warnings: privateWarnings,
        updated_by_practitioner_id: practitioner.id,
      },
      { onConflict: "client_id" },
    );
  if (error) {
    return { ok: false, error: `Failed to save notes: ${error.message}` };
  }

  revalidatePath(`/clients/${clientId}`);
  return { ok: true };
}
