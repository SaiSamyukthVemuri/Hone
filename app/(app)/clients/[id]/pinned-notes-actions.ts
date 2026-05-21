"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
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
