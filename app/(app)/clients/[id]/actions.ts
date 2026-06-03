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
      address: nullableString(formData.get("address")),
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

// Soft-archive a client. Stamps clients.archived_at + archived_by.
// The row stays in the table so every foreign-key reference
// (appointments, sessions, intake forms, treatment plans, audit) keeps
// working; the active client list, calendar quick-book picker, and
// birthday surface filter on archived_at IS NULL. The detail page
// still resolves so the practitioner can un-archive later.
//
// Hard delete is intentionally NOT supported: destroying a client row
// while the clinical history graph references it is data loss with no
// operational upside for the actual use cases (test clients during
// pilot setup and duplicate-entry rows from a typo).
//
// One audit_logs row is inserted so there is a durable trace of who
// archived which client; audit failure logs but does not block the
// archive itself (the archive is the safety action, an audit row
// missing later is recoverable).
export async function archiveClientAction(formData: FormData): Promise<void> {
  const clientId = formData.get("client_id");
  if (typeof clientId !== "string" || !clientId) {
    throw new Error("Missing client id.");
  }

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  await assertClientVisible(studio.id, clientId);

  const supabase = await createClient();
  const nowIso = new Date().toISOString();
  const { error } = await supabase
    .from("clients")
    .update({
      archived_at: nowIso,
      archived_by: practitioner.id,
    })
    .eq("id", clientId)
    .eq("studio_id", studio.id)
    .is("archived_at", null);
  if (error) {
    throw new Error(`Failed to archive client: ${error.message}`);
  }

  const { error: auditErr } = await supabase.from("audit_logs").insert({
    studio_id: studio.id,
    actor_id: practitioner.id,
    action: "client_archived",
    entity_type: "client",
    entity_id: clientId,
    metadata: { archived_at: nowIso },
  });
  if (auditErr) {
    console.error(
      JSON.stringify({
        event: "client_archive_audit_failed",
        clientId,
        code: auditErr.code,
        message: auditErr.message,
        timestamp: new Date().toISOString(),
      }),
    );
  }

  revalidatePath(`/clients/${clientId}`);
  revalidatePath("/clients");
  redirect("/clients");
}

// Reverse of archiveClientAction. Clears archived_at + archived_by so
// the client returns to the active list. Safe to call any number of
// times; the conditional WHERE in archiveClientAction prevents a
// no-op archive from advancing the timestamp once it is already set.
export async function unarchiveClientAction(formData: FormData): Promise<void> {
  const clientId = formData.get("client_id");
  if (typeof clientId !== "string" || !clientId) {
    throw new Error("Missing client id.");
  }

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  await assertClientVisible(studio.id, clientId);

  const supabase = await createClient();
  const { error } = await supabase
    .from("clients")
    .update({
      archived_at: null,
      archived_by: null,
    })
    .eq("id", clientId)
    .eq("studio_id", studio.id)
    .not("archived_at", "is", null);
  if (error) {
    throw new Error(`Failed to unarchive client: ${error.message}`);
  }

  const { error: auditErr } = await supabase.from("audit_logs").insert({
    studio_id: studio.id,
    actor_id: practitioner.id,
    action: "client_unarchived",
    entity_type: "client",
    entity_id: clientId,
    metadata: {},
  });
  if (auditErr) {
    console.error(
      JSON.stringify({
        event: "client_unarchive_audit_failed",
        clientId,
        code: auditErr.code,
        message: auditErr.message,
        timestamp: new Date().toISOString(),
      }),
    );
  }

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
