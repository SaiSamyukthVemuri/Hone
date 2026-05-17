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
  if (duration == null) throw new Error("Duration must be 5–480 minutes.");

  const supabase = await createClient();
  const { error } = await supabase.from("services").insert({
    studio_id: studioId,
    name,
    description: nullable(formData.get("description")),
    default_duration_minutes: duration,
    price_cents: parsePriceCents(formData.get("price_dollars")),
    active: true,
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
  if (duration == null) throw new Error("Duration must be 5–480 minutes.");

  const supabase = await createClient();
  const { error } = await supabase
    .from("services")
    .update({
      name,
      description: nullable(formData.get("description")),
      default_duration_minutes: duration,
      price_cents: parsePriceCents(formData.get("price_dollars")),
      updated_at: new Date().toISOString(),
    })
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
