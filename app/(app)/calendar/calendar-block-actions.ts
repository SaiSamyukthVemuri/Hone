"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { utcInstantFromLocal } from "@/lib/booking/tz";
import { ALL_PRACTITIONERS_SCOPE_VALUE } from "@/lib/calendar/block-scope";

// PR #139. Calendar-drag block creation. Sits parallel to the
// owner-gated createTimedBlockAction in
// app/(app)/settings/availability/actions.ts: this surface is
// available to every ACTIVE PRACTITIONER (not owner-only) so the
// calendar drag-to-block UX can write a studio_timed_blocks row
// directly. studio_id is server-resolved via
// getCurrentPractitionerWithStudio() and never trusted from form
// data.
//
// Same insert shape as the Settings owner-gated action so the
// underlying row, the exclusion-constraint check, and the public
// availability impact are identical. The category defaults to
// 'other' because the calendar drag does not currently expose a
// picker; the practitioner can re-categorise the row in
// Settings -> Breaks & blocks later.
//
// HON-48 F1 (held for Sam's rule). Who the block applies to:
//   * capacity OFF: studio-wide (practitioner_id NULL), as before. Any
//     submitted scope is ignored; the 0137 guard refuses a scoped row there.
//   * capacity ON, non-owner: the block closes only the caller's own time
//     (practitioner_id = self, server-derived). The browser cannot widen it to
//     the whole studio or point it at a colleague.
//   * capacity ON, owner: an explicit choice is required. `block_scope` is
//     "all" (studio-wide) or a practitioner id; the database validates the id
//     (same-studio FK 23503, active target 23514, capacity 42501).

const TIME_RE = /^\d{2}:\d{2}$/;
const REASON_MAX = 200;
const DEFAULT_CATEGORY = "other";

export type CalendarBlockResult =
  | { ok: true }
  | { ok: false; error: string };

export async function createCalendarTimedBlockAction(
  formData: FormData,
): Promise<CalendarBlockResult> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (!practitioner.active) {
    return {
      ok: false,
      error: "Inactive practitioners cannot block time.",
    };
  }

  const dateStr = (formData.get("date") ?? "").toString().trim();
  const startLocal = (formData.get("start_local") ?? "").toString().trim();
  const endLocal = (formData.get("end_local") ?? "").toString().trim();
  const reasonRaw = (formData.get("reason") ?? "").toString().trim();

  if (!dateStr || !startLocal || !endLocal) {
    return { ok: false, error: "Date and start / end times are required." };
  }
  if (!TIME_RE.test(startLocal) || !TIME_RE.test(endLocal)) {
    return { ok: false, error: "Times must be in HH:MM format." };
  }
  if (startLocal >= endLocal) {
    return { ok: false, error: "End time must be after start time." };
  }
  if (reasonRaw.length > REASON_MAX) {
    return {
      ok: false,
      error: `Reason must be ${REASON_MAX} characters or fewer.`,
    };
  }

  const startsAt = utcInstantFromLocal(
    dateStr,
    startLocal,
    studio.timezone,
  ).toISOString();
  const endsAt = utcInstantFromLocal(
    dateStr,
    endLocal,
    studio.timezone,
  ).toISOString();
  if (new Date(endsAt).getTime() <= Date.now()) {
    return { ok: false, error: "Blocked time must end in the future." };
  }

  let practitionerId: string | null = null;
  if (studio.practitioner_capacity_enabled) {
    if (practitioner.role !== "owner") {
      practitionerId = practitioner.id;
    } else {
      const scopeRaw = (formData.get("block_scope") ?? "").toString().trim();
      if (!scopeRaw) {
        return { ok: false, error: "Choose who this block applies to." };
      }
      practitionerId = scopeRaw === ALL_PRACTITIONERS_SCOPE_VALUE ? null : scopeRaw;
    }
  }

  const supabase = await createClient();
  const row: Record<string, unknown> = {
    studio_id: studio.id,
    starts_at: startsAt,
    ends_at: endsAt,
    category: DEFAULT_CATEGORY,
    private_note: reasonRaw.length > 0 ? reasonRaw : null,
    created_by: practitioner.id,
  };
  // Capacity OFF and the owner's "All practitioners" keep the exact pre-F1
  // insert (no practitioner_id key at all).
  if (practitionerId) row.practitioner_id = practitionerId;
  const { error } = await supabase.from("studio_timed_blocks").insert(row);
  if (error) {
    // 23P01 is the exclusion-constraint code surfaced by the
    // existing exclusion rule against appointments / other timed
    // blocks / full-day blockouts. Surface a friendly message; the
    // owner-gated Settings action does the same.
    if (error.code === "23P01") {
      return {
        ok: false,
        error: "That time overlaps an existing block or appointment.",
      };
    }
    const scoped = scopedBlockErrorMessage(error.code, practitioner.role === "owner", practitionerId !== null);
    if (scoped) return { ok: false, error: scoped };
    return {
      ok: false,
      error: `Failed to add block: ${error.message}`,
    };
  }

  revalidatePath("/calendar");
  revalidatePath("/settings/availability");
  return { ok: true };
}

// Codes only, never the database message.
function scopedBlockErrorMessage(
  code: string | undefined,
  isOwner: boolean,
  scoped: boolean,
): string | null {
  if (!scoped) return null;
  switch (code) {
    case "42501":
      // A non-owner's own-time block is refused by row security until the
      // member insert policy allows practitioner_id = self.
      return isOwner
        ? "Per-practitioner scheduling is not enabled for this studio, so this block must apply to all practitioners."
        : "This block could not be saved for you only. Ask the studio owner to add it.";
    case "23514":
      return "That practitioner is no longer active. Choose an active practitioner, or make this block apply to all practitioners.";
    case "23503":
      return "That practitioner does not belong to this studio.";
    default:
      return null;
  }
}
