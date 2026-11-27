"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { isServiceColorKey } from "@/lib/calendar/service-colors";
import { isMissingColumnError } from "@/lib/db/missing-column";
import { isServiceMove, type ServiceMove } from "@/lib/booking/service-order";
import { dbErrorCode } from "@/lib/logging/error-class";
import { userFacingDbFailure } from "@/lib/logging/user-facing-db-failure";
import { ACTION_OK, actionFailed, type ActionResult } from "@/lib/actions/action-result";

function trimmed(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

// Server-side allowlist validation for the calendar color. ONLY the ten allowed
// keys pass; rose/red, arbitrary CSS, or any unknown value is rejected. Absent ->
// the safe default 'sky'. This is the authoritative guard; the DB CHECK
// (0153, widened by 0161) is the backstop.
function parseCalendarColor(value: FormDataEntryValue | null): string | null {
  const v = trimmed(value);
  if (v.length === 0) return "sky";
  if (!isServiceColorKey(v)) return null; // HON-124 item 20: the caller RETURNS a sentence; a thrown message is redacted in production
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

// Position for a NEW service: the END of the studio's visible order.
//
// This was previously scoped PER MODALITY (`max(sort_order) + 10` within one
// modality), which is the root of the tie problem migration 0161 exists to fix:
// each modality ran its own 100/110/120 sequence, so a studio with a
// consultation service and an electrolysis service was GUARANTEED to have two
// rows at 100. Allocating studio-wide means a service added after a reorder
// lands cleanly at the end instead of colliding with the middle of the
// normalized 10/20/30 sequence.
//
// The error path deliberately does NOT fall back to a constant. Returning 100
// on a transient read failure silently re-created a duplicate: the exact
// condition the reorder RPC then had to repair.
async function nextStudioSortOrder(studioId: string): Promise<{ ok: true; value: number } | { ok: false; error: string }> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("services")
    .select("sort_order")
    .eq("studio_id", studioId)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    return { ok: false, error: userFacingDbFailure("place the new service in your menu", error, "service_sort_order_read_failed") };
  }
  return { ok: true, value: (data?.sort_order ?? 0) + 10 };
}

const OWNER_ONLY_MESSAGE = "Only the studio owner can change services.";

// Returns the refusal instead of throwing it: production redacts a thrown message to a generic Next.js string.
async function ownerOrFailure(): Promise<{ ok: true; studioId: string } | { ok: false; error: string }> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner") return { ok: false, error: OWNER_ONLY_MESSAGE };
  return { ok: true, studioId: studio.id };
}

const NAME_REQUIRED = "Enter the service name, then save again.";
const DURATION_INVALID = "Enter a duration between 5 and 480 minutes, then save again.";
const COLOR_INVALID = "Choose a calendar colour from the list, then save again.";

export async function createServiceAction(formData: FormData): Promise<ActionResult> {
  const owner = await ownerOrFailure();
  if (!owner.ok) return owner;
  const { studioId } = owner;
  const name = nullable(formData.get("name"));
  if (!name) return actionFailed(NAME_REQUIRED);
  const duration = parseDuration(formData.get("default_duration_minutes"));
  if (duration == null) return actionFailed(DURATION_INVALID);

  const modality = parseModality(formData.get("modality"));
  const explicitSort = parseSortOrder(formData.get("sort_order"));
  let sort_order: number;
  if (explicitSort != null) sort_order = explicitSort;
  else {
    const next = await nextStudioSortOrder(studioId);
    if (!next.ok) return actionFailed(next.error);
    sort_order = next.value;
  }

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
  if (calendar_color === null) return actionFailed(COLOR_INVALID);
  let { error } = await supabase.from("services").insert({ ...base, calendar_color });
  // Migration-order safety: if calendar_color does not exist YET (app deployed
  // before 0153), insert without it. Any other error is re-thrown.
  if (error && isMissingColumnError(error, "calendar_color")) {
    ({ error } = await supabase.from("services").insert(base));
  }
  if (error) return actionFailed(userFacingDbFailure("add the service", error, "add_service_failed"));
  revalidatePath("/settings/services");
  return ACTION_OK;
}

export async function updateServiceAction(formData: FormData): Promise<ActionResult> {
  const owner = await ownerOrFailure();
  if (!owner.ok) return owner;
  const { studioId } = owner;
  const id = trimmed(formData.get("id"));
  if (!id) return actionFailed("Reload the page and try again.");

  const name = nullable(formData.get("name"));
  if (!name) return actionFailed(NAME_REQUIRED);
  const duration = parseDuration(formData.get("default_duration_minutes"));
  if (duration == null) return actionFailed(DURATION_INVALID);

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
  if (calendar_color === null) return actionFailed(COLOR_INVALID);

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
  if (error) return actionFailed(userFacingDbFailure("save the service", error, "update_service_failed"));
  revalidatePath("/settings/services");
  return ACTION_OK;
}

// Move a service within the studio's VISIBLE service order.
//
// THE DEFECT THIS REPLACES. The old implementation read its own list with
// `order by sort_order` and NO secondary key, then swapped two sort_order values
// with TWO independent, untransacted UPDATEs.
//   * `services.sort_order` is `not null default 100` with no uniqueness and a
//     PER-MODALITY allocator, so ties are the normal state. Tied rows came back
//     in HEAP order, which changes after every UPDATE, so `list[idx]` was
//     routinely NOT the row at screen position idx. When the action happened to
//     find the clicked service at index 0 it returned silently: the arrow did
//     nothing, forever, because nothing changed to break the tie. That is
//     Chloe's "Client Consultation cannot reliably reach the top".
//   * A failure between the two UPDATEs left both rows holding the neighbour's
//     value: a NEW permanent duplicate.
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
//
// It returns the RESULTING ORDER, not just ok/failed. The RPC does not always
// perform the requested move, if the caller's view was stale (the service was
// hidden or removed elsewhere) it normalizes and returns the order it actually
// produced. Reporting a bare `ok` there would let the client keep an optimistic
// order the database never agreed to, until the next full page load.
export async function moveServiceAction(input: {
  id: string;
  move: ServiceMove;
  expectedPosition: number | null;
}): Promise<{ ok: true; order: string[] } | { ok: false; error: string }> {
  // A lookup failure throws; catch it so a stale session surfaces as an in-place
  // message rather than an error boundary that discards the page state.
  let studioId: string;
  try {
    const owner = await ownerOrFailure();
    if (!owner.ok) return { ok: false, error: owner.error };
    studioId = owner.studioId;
  } catch {
    return { ok: false, error: "Your session has expired. Reload the page and try again." };
  }
  if (!input.id) return { ok: false, error: "Missing service id." };
  if (!isServiceMove(input.move)) {
    return { ok: false, error: "Direction must be one of top, up, down, bottom." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("reorder_studio_service", {
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
          "The service order changed while you were tapping. The list has been refreshed: try again.",
      };
    }
    return { ok: false, error: userFacingDbFailure("reorder the services", error, "service_reorder_failed") };
  }

  revalidatePath("/settings/services");
  revalidatePath("/calendar");
  // The authoritative resulting order. The client adopts THIS, not its own
  // optimistic guess, so a move the RPC declined can never stick on screen.
  return { ok: true, order: Array.isArray(data) ? (data as string[]) : [] };
}

export async function toggleServiceActiveAction(
  formData: FormData,
): Promise<ActionResult> {
  const owner = await ownerOrFailure();
  if (!owner.ok) return owner;
  const { studioId } = owner;
  const id = trimmed(formData.get("id"));
  const active = trimmed(formData.get("active")) === "true";
  if (!id) return actionFailed("Reload the page and try again.");

  const supabase = await createClient();
  if (active) {
    // SHOWING. A hidden service keeps whatever sort_order it held when it was
    // hidden: often 100, i.e. right inside the normalized 10/20/30 sequence,
    // or exactly equal to another row. Re-slot it at the END of the visible
    // order and renormalize, atomically (migration 0161).
    const { error } = await supabase.rpc("show_studio_service", {
      p_studio_id: studioId,
      p_service_id: id,
    });
    if (error) return actionFailed(userFacingDbFailure("show the service", error, "show_service_failed"));
  } else {
    const { error } = await supabase
      .from("services")
      .update({ active, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("studio_id", studioId);
    if (error) return actionFailed(userFacingDbFailure("hide the service", error, "hide_service_failed"));
  }
  revalidatePath("/settings/services");
  revalidatePath("/calendar");
  return ACTION_OK;
}
