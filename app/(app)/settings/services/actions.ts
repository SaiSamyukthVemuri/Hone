"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { isServiceColorKey } from "@/lib/calendar/service-colors";
import { isMissingColumnError } from "@/lib/db/missing-column";
import {
  compareServicePosition,
  isServiceMove,
  type ServiceMove,
} from "@/lib/booking/service-order";

function trimmed(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

// Server-side allowlist validation for the calendar color. ONLY the ten allowed
// keys pass; rose/red, arbitrary CSS, or any unknown value is rejected. Absent ->
// the safe default 'sky'. This is the authoritative guard; the DB CHECK
// (0153, widened by 0161) is the backstop.
function parseCalendarColor(value: FormDataEntryValue | null): string {
  const v = trimmed(value);
  if (v.length === 0) return "sky";
  if (!isServiceColorKey(v)) {
    throw new Error("Please choose a valid calendar color.");
  }
  return v;
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
  const base = {
    studio_id: studioId,
    name,
    description: nullable(formData.get("description")),
    default_duration_minutes: duration,
    price_cents: parsePriceCents(formData.get("price_dollars")),
    modality,
    sort_order,
    active: true,
    pre_care_instructions: nullable(formData.get("pre_care_instructions")),
  };
  const calendar_color = parseCalendarColor(formData.get("calendar_color"));
  let { error } = await supabase.from("services").insert({ ...base, calendar_color });
  // Migration-order safety: if calendar_color does not exist YET (app deployed
  // before 0153), insert without it. Any other error is re-thrown.
  if (error && isMissingColumnError(error, "calendar_color")) {
    ({ error } = await supabase.from("services").insert(base));
  }
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
  const calendar_color = parseCalendarColor(formData.get("calendar_color"));

  let { error } = await supabase
    .from("services")
    .update({ ...update, calendar_color })
    .eq("id", id)
    .eq("studio_id", studioId);
  // Migration-order safety: pre-0153, update without calendar_color. Other errors re-throw.
  if (error && isMissingColumnError(error, "calendar_color")) {
    ({ error } = await supabase
      .from("services")
      .update(update)
      .eq("id", id)
      .eq("studio_id", studioId));
  }
  if (error) throw new Error(`Failed to update service: ${error.message}`);
  revalidatePath("/settings/services");
}

// Move a service within the studio's VISIBLE service order.
//
// THE DEFECT THIS REPLACES. The old implementation read its own list with
// `order by sort_order` and NO secondary key, then swapped two sort_order values
// with TWO independent, untransacted UPDATEs.
//   * `services.sort_order` is `not null default 100` with no uniqueness and a
//     PER-MODALITY allocator, so ties are the normal state. Tied rows came back
//     in HEAP order, which changes after every UPDATE — so `list[idx]` was
//     routinely NOT the row at screen position idx. When the action happened to
//     find the clicked service at index 0 it returned silently: the arrow did
//     nothing, forever, because nothing changed to break the tie. That is
//     Chloe's "Client Consultation cannot reliably reach the top".
//   * A failure between the two UPDATEs left both rows holding the neighbour's
//     value — a NEW permanent duplicate.
//
// NOW: one atomic, owner-authorized RPC (migration 0161) normalizes the visible
// order to 10, 20, 30 … and applies the move in the same transaction, using the
// SAME total ordering the UI renders (sort_order, name, id). One tap = exactly
// one position, every time. `expected_position` is an optimistic-concurrency
// token: if the order changed underneath the practitioner, the move is refused
// rather than applied to the wrong row.
//
// Hidden services never participate: they are not in the visible set, so they
// cannot be swapped with and cannot shift the public order. Re-showing one goes
// through showServiceAction, which re-slots it at the end.
// The typed entry point the settings list calls. Returns a RESULT rather than
// throwing so the client can roll its optimistic move back and show the reason
// in place, instead of tripping an error boundary and losing scroll position.
export async function moveServiceAction(input: {
  id: string;
  move: ServiceMove;
  expectedPosition: number | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const { studioId } = await assertOwner();
  if (!input.id) return { ok: false, error: "Missing service id." };
  if (!isServiceMove(input.move)) {
    return { ok: false, error: "Direction must be one of top, up, down, bottom." };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("reorder_studio_service", {
    p_studio_id: studioId,
    p_service_id: input.id,
    p_move: input.move,
    p_expected_position:
      Number.isInteger(input.expectedPosition) && (input.expectedPosition as number) >= 0
        ? input.expectedPosition
        : null,
  });
  if (error) {
    revalidatePath("/settings/services");
    // 40001 is the RPC's stale-position signal, not a database fault.
    if (error.code === "40001" || /changed elsewhere/i.test(error.message ?? "")) {
      return {
        ok: false,
        error:
          "The service order changed while you were tapping. The list has been refreshed — try again.",
      };
    }
    return { ok: false, error: `Failed to reorder: ${error.message}` };
  }

  revalidatePath("/settings/services");
  revalidatePath("/calendar");
  return { ok: true };
}

// Progressive-enhancement fallback: the same move driven by a plain <form> post,
// so the controls still work with JavaScript unavailable. Delegates to the one
// implementation above; throwing here is correct because there is no client
// state to roll back on this path.
export async function reorderServiceAction(
  formData: FormData,
): Promise<void> {
  const id = trimmed(formData.get("id"));
  const moveRaw = trimmed(formData.get("direction"));
  if (!isServiceMove(moveRaw)) {
    throw new Error("Direction must be one of top, up, down, bottom.");
  }
  const expectedRaw = trimmed(formData.get("expected_position"));
  const result = await moveServiceAction({
    id,
    move: moveRaw as ServiceMove,
    expectedPosition:
      expectedRaw.length > 0 && /^\d+$/.test(expectedRaw) ? parseInt(expectedRaw, 10) : null,
  });
  if (!result.ok) throw new Error(result.error);
}

// One-off repair for a studio whose stored positions are still the legacy
// duplicate-heavy values: normalize the visible order WITHOUT moving anything.
// Same RPC, and a no-op move keeps it a single atomic command.
export async function normalizeServiceOrderAction(): Promise<void> {
  const { studioId } = await assertOwner();
  const supabase = await createClient();
  const { data: rows, error: listErr } = await supabase
    .from("services")
    .select("id, name, sort_order, active")
    .eq("studio_id", studioId)
    .eq("active", true);
  if (listErr) throw new Error(`Failed to read services: ${listErr.message}`);
  // Sort in JS from the same data the page uses, so the client collation and
  // the Postgres collation can never disagree about the canonical order.
  const ordered = [...(rows ?? [])].sort(compareServicePosition);
  const first = ordered[0];
  if (!first) {
    revalidatePath("/settings/services");
    return;
  }
  // "Move the first item to the top" is a positional no-op that still triggers
  // the RPC's full normalization pass.
  const { error } = await supabase.rpc("reorder_studio_service", {
    p_studio_id: studioId,
    p_service_id: first.id,
    p_move: "top",
    p_expected_position: null,
  });
  if (error) throw new Error(`Failed to normalize service order: ${error.message}`);
  revalidatePath("/settings/services");
  revalidatePath("/calendar");
}

export async function toggleServiceActiveAction(
  formData: FormData,
): Promise<void> {
  const { studioId } = await assertOwner();
  const id = trimmed(formData.get("id"));
  const active = trimmed(formData.get("active")) === "true";
  if (!id) throw new Error("Missing service id.");

  const supabase = await createClient();
  if (active) {
    // SHOWING. A hidden service keeps whatever sort_order it held when it was
    // hidden — often 100, i.e. right inside the normalized 10/20/30 sequence,
    // or exactly equal to another row. Re-slot it at the END of the visible
    // order and renormalize, atomically (migration 0161).
    const { error } = await supabase.rpc("show_studio_service", {
      p_studio_id: studioId,
      p_service_id: id,
    });
    if (error) throw new Error(`Failed to update service: ${error.message}`);
  } else {
    const { error } = await supabase
      .from("services")
      .update({ active, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("studio_id", studioId);
    if (error) throw new Error(`Failed to update service: ${error.message}`);
  }
  revalidatePath("/settings/services");
  revalidatePath("/calendar");
}
