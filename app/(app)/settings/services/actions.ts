"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";

function trimmed(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function nullable(value: FormDataEntryValue | null): string | null {
  const t = trimmed(value);
  return t.length === 0 ? null : t;
}

function parseDuration(value: FormDataEntryValue | null): number | null {
  const t = trimmed(value);
  if (!t) return null;
  const n = parseInt(t, 10);
  if (!Number.isFinite(n)) return null;
  if (n < 5 || n > 480) return null;
  return n;
}

function parsePriceCents(value: FormDataEntryValue | null): number | null {
  const t = trimmed(value);
  if (!t) return null;
  const dollars = Number(t);
  if (!Number.isFinite(dollars) || dollars < 0) return null;
  return Math.round(dollars * 100);
}

// Modality is free text in the DB but we sanitize to a short whitelist of
// shapes: known modalities pass through, an explicit "" or "other" returns
// null (treated as Other in the UI), anything else is stored as-is so future
// custom modalities work without a migration.
function parseModality(value: FormDataEntryValue | null): string | null {
  const t = trimmed(value).toLowerCase();
  if (!t || t === "other") return null;
  return t;
}

function parseSortOrder(value: FormDataEntryValue | null): number | null {
  const t = trimmed(value);
  if (!t) return null;
  const n = parseInt(t, 10);
  if (!Number.isFinite(n) || n < 0 || n > 100000) return null;
  return n;
}

async function nextSortOrderForModality(
  studioId: string,
  modality: string | null,
): Promise<number> {
  const supabase = await createClient();
  let query = supabase
    .from("services")
    .select("sort_order")
    .eq("studio_id", studioId)
    .order("sort_order", { ascending: false })
    .limit(1);
  query = modality == null ? query.is("modality", null) : query.eq("modality", modality);
  const { data, error } = await query.maybeSingle();
  if (error) return 100;
  if (!data) return 100;
  return data.sort_order + 10;
}

async function assertOwner(): Promise<{ studioId: string }> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner") {
    throw new Error("Only studio owners can manage services.");
  }
  return { studioId: studio.id };
}

export async function createServiceAction(formData: FormData): Promise<void> {
  const { studioId } = await assertOwner();
  const name = nullable(formData.get("name"));
  if (!name) throw new Error("Service name is required.");
  const duration = parseDuration(formData.get("default_duration_minutes"));
  if (duration == null) {
    throw new Error("Duration must be between 5 and 480 minutes.");
  }

  const modality = parseModality(formData.get("modality"));
  const explicitSort = parseSortOrder(formData.get("sort_order"));
  const sort_order =
    explicitSort != null
      ? explicitSort
      : await nextSortOrderForModality(studioId, modality);

  const supabase = await createClient();
  const { error } = await supabase.from("services").insert({
    studio_id: studioId,
    name,
    description: nullable(formData.get("description")),
    default_duration_minutes: duration,
    price_cents: parsePriceCents(formData.get("price_dollars")),
    modality,
    sort_order,
    active: true,
    pre_care_instructions: nullable(formData.get("pre_care_instructions")),
  });
  if (error) throw new Error(`Failed to add service: ${error.message}`);
  revalidatePath("/settings/services");
}

export async function updateServiceAction(formData: FormData): Promise<void> {
  const { studioId } = await assertOwner();
  const id = trimmed(formData.get("id"));
  if (!id) throw new Error("Missing service id.");

  const name = nullable(formData.get("name"));
  if (!name) throw new Error("Service name is required.");
  const duration = parseDuration(formData.get("default_duration_minutes"));
  if (duration == null) {
    throw new Error("Duration must be between 5 and 480 minutes.");
  }

  const modality = parseModality(formData.get("modality"));
  const sort_order = parseSortOrder(formData.get("sort_order"));

  const supabase = await createClient();
  const update: Record<string, unknown> = {
    name,
    description: nullable(formData.get("description")),
    default_duration_minutes: duration,
    price_cents: parsePriceCents(formData.get("price_dollars")),
    modality,
    pre_care_instructions: nullable(formData.get("pre_care_instructions")),
    updated_at: new Date().toISOString(),
  };
  if (sort_order != null) update.sort_order = sort_order;

  const { error } = await supabase
    .from("services")
    .update(update)
    .eq("id", id)
    .eq("studio_id", studioId);
  if (error) throw new Error(`Failed to update service: ${error.message}`);
  revalidatePath("/settings/services");
}

export async function toggleServiceActiveAction(
  formData: FormData,
): Promise<void> {
  const { studioId } = await assertOwner();
  const id = trimmed(formData.get("id"));
  const active = trimmed(formData.get("active")) === "true";
  if (!id) throw new Error("Missing service id.");

  const supabase = await createClient();
  const { error } = await supabase
    .from("services")
    .update({ active, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("studio_id", studioId);
  if (error) throw new Error(`Failed to update service: ${error.message}`);
  revalidatePath("/settings/services");
}
