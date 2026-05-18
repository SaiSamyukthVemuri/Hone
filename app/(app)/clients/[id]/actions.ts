"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";

async function assertClientVisible(
  studioId: string,
  clientId: string,
): Promise<void> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("clients")
    .select("id")
    .eq("id", clientId)
    .eq("studio_id", studioId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load client: ${error.message}`);
  if (!data) throw new Error("Client not found.");
}

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

// Converts a dollar string like "150" or "150.50" to integer cents.
function dollarsToCents(value: FormDataEntryValue | null): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

export async function updateClientAction(formData: FormData): Promise<void> {
  const clientId = formData.get("client_id");
  if (typeof clientId !== "string" || !clientId)
    throw new Error("Missing client id.");

  const name = nullableString(formData.get("name"));
  if (!name) throw new Error("Name is required.");

  const { studio } = await getCurrentPractitionerWithStudio();
  await assertClientVisible(studio.id, clientId);

  const supabase = await createClient();
  const { error } = await supabase
    .from("clients")
    .update({
      name,
      pronouns: nullableString(formData.get("pronouns")),
      phone: nullableString(formData.get("phone")),
      email: nullableString(formData.get("email")),
      date_of_birth: nullableString(formData.get("date_of_birth")),
      fitzpatrick_type: nullableInt(formData.get("fitzpatrick_type")),
      skin_notes: nullableString(formData.get("skin_notes")),
      allergies: nullableString(formData.get("allergies")),
      emergency_contact_name: nullableString(
        formData.get("emergency_contact_name"),
      ),
      emergency_contact_phone: nullableString(
        formData.get("emergency_contact_phone"),
      ),
    })
    .eq("id", clientId)
    .eq("studio_id", studio.id);

  if (error) throw new Error(`Failed to update client: ${error.message}`);
  revalidatePath(`/clients/${clientId}`);
  revalidatePath("/clients");
  redirect(`/clients/${clientId}`);
}

export async function addClientPricingAction(formData: FormData): Promise<void> {
  const clientId = formData.get("client_id");
  if (typeof clientId !== "string" || !clientId)
    throw new Error("Missing client id.");

  const serviceName = nullableString(formData.get("service_name"));
  if (!serviceName) throw new Error("Service is required.");

  const priceCents = dollarsToCents(formData.get("price"));
  if (priceCents == null) throw new Error("Price must be a non-negative number.");

  const { studio } = await getCurrentPractitionerWithStudio();
  await assertClientVisible(studio.id, clientId);

  const supabase = await createClient();
  const { error } = await supabase.from("client_pricing").insert({
    studio_id: studio.id,
    client_id: clientId,
    service_name: serviceName,
    price_cents: priceCents,
    notes: nullableString(formData.get("notes")),
  });

  if (error) throw new Error(`Failed to add pricing: ${error.message}`);
  revalidatePath(`/clients/${clientId}`);
}

export async function deleteClientPricingAction(formData: FormData): Promise<void> {
  const id = formData.get("id");
  const clientId = formData.get("client_id");
  if (typeof id !== "string" || !id) throw new Error("Missing pricing id.");
  if (typeof clientId !== "string" || !clientId)
    throw new Error("Missing client id.");

  const { studio } = await getCurrentPractitionerWithStudio();
  await assertClientVisible(studio.id, clientId);

  const supabase = await createClient();
  const { error } = await supabase
    .from("client_pricing")
    .delete()
    .eq("id", id)
    .eq("studio_id", studio.id)
    .eq("client_id", clientId);
  if (error) throw new Error(`Failed to delete pricing: ${error.message}`);
  revalidatePath(`/clients/${clientId}`);
}

export async function addClientTagAction(formData: FormData): Promise<void> {
  const clientId = formData.get("client_id");
  const label = nullableString(formData.get("label"));
  if (typeof clientId !== "string" || !clientId) {
    throw new Error("Missing client id.");
  }
  if (!label) throw new Error("Tag label is required.");
  if (label.length > 60) throw new Error("Tag label must be 60 characters or fewer.");

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  await assertClientVisible(studio.id, clientId);

  const supabase = await createClient();
  const { error } = await supabase.from("client_tags").insert({
    studio_id: studio.id,
    client_id: clientId,
    label,
    created_by: practitioner.id,
  });
  if (error) throw new Error(`Failed to add tag: ${error.message}`);
  revalidatePath(`/clients/${clientId}`);
}

export async function removeClientTagAction(formData: FormData): Promise<void> {
  const tagId = formData.get("tag_id");
  const clientId = formData.get("client_id");
  if (typeof tagId !== "string" || !tagId) throw new Error("Missing tag id.");
  if (typeof clientId !== "string" || !clientId) {
    throw new Error("Missing client id.");
  }

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  await assertClientVisible(studio.id, clientId);

  const supabase = await createClient();
  const { error } = await supabase
    .from("client_tags")
    .update({
      deleted_at: new Date().toISOString(),
      deleted_by: practitioner.id,
    })
    .eq("id", tagId)
    .eq("studio_id", studio.id)
    .eq("client_id", clientId)
    .is("deleted_at", null);
  if (error) throw new Error(`Failed to remove tag: ${error.message}`);
  revalidatePath(`/clients/${clientId}`);
}
