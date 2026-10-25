"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { dbErrorCode } from "@/lib/logging/error-class";

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
  if (clientErr) throw new Error(`Failed to load client: ${dbErrorCode(clientErr)}`);
  if (!client) throw new Error("Client not found.");

  const { error } = await supabase.from("client_pinned_notes").insert({
    client_id: clientId,
    studio_id: studio.id,
    text,
    created_by_practitioner_id: practitioner.id,
  });
  if (error) throw new Error(`Failed to pin note: ${dbErrorCode(error)}`);

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

  // 0254 (HON-44, Sam decision 12): the edit is a database COMMAND, not a
  // service-role UPDATE. No UPDATE policy exists on client_pinned_notes (0022), and
  // a service-role write cannot be constrained by one, so the old path could not
  // enforce "a practitioner edits only their own". edit_client_pinned_note derives
  // the caller from auth.uid() and the NAMED studio, lets a practitioner touch only a
  // caution they created and the owner any, keeps the optimistic-concurrency guard
  // on the current text, mutates `text` alone, and writes the audit row. Every
  // refusal (foreign studio, foreign client, deleted, stale, not yours) is the same
  // `false`, so nothing about who wrote a caution is disclosed.
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("edit_client_pinned_note", {
    p_studio_id: studio.id,
    p_client_id: clientId,
    p_note_id: noteId,
    p_original_text: originalText,
    p_text: text,
  });
  if (error) throw new Error("Could not update the note. Please try again.");
  if (data !== true) {
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

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  // HON-44 (Sam decision 12): only the owner deletes a pinned caution. APP half;
  // the client_pinned_notes DELETE policy admits any member until 0254.
  if (practitioner.role !== "owner") {
    throw new Error("Only the studio owner can remove a pinned note.");
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("client_pinned_notes")
    .delete()
    .eq("id", noteId)
    .eq("studio_id", studio.id)
    .eq("client_id", clientId);
  if (error) throw new Error(`Failed to remove note: ${dbErrorCode(error)}`);

  revalidatePath(`/clients/${clientId}`);
  revalidatePath("/dashboard");
}
