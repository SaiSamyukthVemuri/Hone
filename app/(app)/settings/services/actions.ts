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

// Move a service one position up or down in the list. The list is
// ordered by sort_order (ascending); "up" means a smaller sort_order
// (earlier on the booking page). Implementation swaps sort_order
// values with the neighbour in the direction requested. Scoped to
// active services only (active = true) because the public booking
// menu only shows active services; hidden services should not affect
// ordering controls the practitioner sees.
//
// Storage: a two-step swap (write each row's new sort_order
// separately) is safe here because services.sort_order is not subject
// to a uniqueness constraint and the second update overrides the
// first if the order is the same. Both rows belong to the same studio
// and the same modality grouping has no impact on the public order
// because services are sorted purely by sort_order on the booking
// page.
export async function reorderServiceAction(
  formData: FormData,
): Promise<void> {
  const { studioId } = await assertOwner();
  const id = trimmed(formData.get("id"));
  const dirRaw = trimmed(formData.get("direction"));
  if (!id) throw new Error("Missing service id.");
  if (dirRaw !== "up" && dirRaw !== "down") {
    throw new Error("Direction must be 'up' or 'down'.");
  }

  const supabase = await createClient();
  const { data: rows, error: listErr } = await supabase
    .from("services")
    .select("id, sort_order, active")
    .eq("studio_id", studioId)
    .eq("active", true)
    .order("sort_order", { ascending: true });
  if (listErr) {
    throw new Error(`Failed to read services: ${listErr.message}`);
  }
  const list = rows ?? [];
  const idx = list.findIndex((r) => r.id === id);
  if (idx === -1) {
    // Service is hidden or does not belong to this studio; nothing to
    // reorder. Revalidate so the UI re-renders if the assumption was
    // stale.
    revalidatePath("/settings/services");
    return;
  }
  const neighbourIdx = dirRaw === "up" ? idx - 1 : idx + 1;
  if (neighbourIdx < 0 || neighbourIdx >= list.length) {
    // Already at the top or bottom. No-op.
    revalidatePath("/settings/services");
    return;
  }

  const me = list[idx];
  const neighbour = list[neighbourIdx];
  const mySort = me.sort_order;
  const neighbourSort = neighbour.sort_order;

  // If two rows happen to share a sort_order, force the moved row to
  // straddle the neighbour by one to guarantee a visible change.
  const [newMine, newTheirs] =
    mySort === neighbourSort
      ? dirRaw === "up"
        ? [neighbourSort - 1, neighbourSort]
        : [neighbourSort + 1, neighbourSort]
      : [neighbourSort, mySort];

  const { error: e1 } = await supabase
    .from("services")
    .update({ sort_order: newMine, updated_at: new Date().toISOString() })
    .eq("id", me.id)
    .eq("studio_id", studioId);
  if (e1) throw new Error(`Failed to reorder: ${e1.message}`);
  const { error: e2 } = await supabase
    .from("services")
    .update({ sort_order: newTheirs, updated_at: new Date().toISOString() })
    .eq("id", neighbour.id)
    .eq("studio_id", studioId);
  if (e2) throw new Error(`Failed to reorder: ${e2.message}`);

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
