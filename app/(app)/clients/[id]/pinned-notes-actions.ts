"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";

const MAX_PINNED_NOTE_LENGTH = 200;

function trimmedString(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function addClientPinnedNoteAction(
  formData: FormData,
): Promise<void> {
  const clientId = trimmedString(formData.get("client_id"));
  const text = trimmedString(formData.get("text"));
  if (!clientId) throw new Error("Missing client id.");
  if (!text) throw new Error("Note text is required.");
  if (text.length > MAX_PINNED_NOTE_LENGTH) {
    throw new Error(
      `Note must be ${MAX_PINNED_NOTE_LENGTH} characters or fewer.`,
    );
  }

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();

  const supabase = await createClient();
  // Verify the client belongs to this studio. RLS guards this too; double-
  // check here so a tampered form returns a clean error instead of an RLS
  // surprise.
  const { data: client, error: clientErr } = await supabase
    .from("clients")
    .select("id")
    .eq("id", clientId)
    .eq("studio_id", studio.id)
    .maybeSingle();
  if (clientErr) throw new Error(`Failed to load client: ${clientErr.message}`);
  if (!client) throw new Error("Client not found.");

  const { error } = await supabase.from("client_pinned_notes").insert({
    client_id: clientId,
    studio_id: studio.id,
    text,
    created_by_practitioner_id: practitioner.id,
  });
  if (error) throw new Error(`Failed to pin note: ${error.message}`);

  revalidatePath(`/clients/${clientId}`);
  revalidatePath("/dashboard");
}

export async function editClientPinnedNoteAction(
  formData: FormData,
): Promise<void> {
  const noteId = trimmedString(formData.get("note_id"));
  const clientId = trimmedString(formData.get("client_id"));
  const text = trimmedString(formData.get("text"));
  // Optimistic-concurrency token: the text that was on screen when the editor
  // opened. The update only lands if the row STILL holds this text.
  const originalText = trimmedString(formData.get("original_text"));
  if (!noteId) throw new Error("Missing note id.");
  if (!clientId) throw new Error("Missing client id.");
  if (!originalText) throw new Error("Missing original note text.");
  if (!text) throw new Error("Note text is required.");
  if (text.length > MAX_PINNED_NOTE_LENGTH) {
    throw new Error(
      `Note must be ${MAX_PINNED_NOTE_LENGTH} characters or fewer.`,
    );
  }

  // Authorization: an active practitioner of the CURRENT studio (throws /
  // redirects otherwise). The studio is derived from the session, NEVER the form.
  const { studio } = await getCurrentPractitionerWithStudio();

  // client_pinned_notes carries SELECT/INSERT/DELETE RLS policies but no UPDATE
  // policy (0022), so the RLS-scoped user client cannot UPDATE and this PR does
  // not add a migration. Use the service-role client and enforce tenant isolation
  // EXPLICITLY: the update is scoped to (id, studio_id = the authed studio,
  // client_id), plus an OPTIMISTIC-CONCURRENCY guard on the note's current text.
  // A foreign-studio / foreign-client / deleted / concurrently-edited note (its
  // text no longer equals originalText) matches ZERO rows and is rejected — the
  // later save never silently overwrites the earlier one. `text` is the ONLY
  // mutated column; id, pinned state (row existence), studio_id, client_id,
  // created_by_practitioner_id, and created_at are all preserved.
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("client_pinned_notes")
    .update({ text })
    .eq("id", noteId)
    .eq("studio_id", studio.id)
    .eq("client_id", clientId)
    .eq("text", originalText)
    .select("id")
    .maybeSingle();
  if (error) throw new Error("Could not update the note. Please try again.");
  if (!data) {
    throw new Error(
      "That note changed or is no longer available. Refresh and try again.",
    );
  }

  revalidatePath(`/clients/${clientId}`);
  revalidatePath("/dashboard");
}

export async function removeClientPinnedNoteAction(
  formData: FormData,
): Promise<void> {
  const noteId = trimmedString(formData.get("note_id"));
  const clientId = trimmedString(formData.get("client_id"));
  if (!noteId) throw new Error("Missing note id.");
  if (!clientId) throw new Error("Missing client id.");

  const { studio } = await getCurrentPractitionerWithStudio();

  const supabase = await createClient();
  const { error } = await supabase
    .from("client_pinned_notes")
    .delete()
    .eq("id", noteId)
    .eq("studio_id", studio.id)
    .eq("client_id", clientId);
  if (error) throw new Error(`Failed to remove note: ${error.message}`);

  revalidatePath(`/clients/${clientId}`);
  revalidatePath("/dashboard");
}
