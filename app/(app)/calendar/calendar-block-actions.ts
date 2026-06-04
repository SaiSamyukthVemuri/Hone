"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { utcInstantFromLocal } from "@/lib/booking/tz";

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

  const supabase = await createClient();
  const { error } = await supabase.from("studio_timed_blocks").insert({
    studio_id: studio.id,
    starts_at: startsAt,
    ends_at: endsAt,
    category: DEFAULT_CATEGORY,
    private_note: reasonRaw.length > 0 ? reasonRaw : null,
    created_by: practitioner.id,
  });
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
    return {
      ok: false,
      error: `Failed to add block: ${error.message}`,
    };
  }

  revalidatePath("/calendar");
  revalidatePath("/settings/availability");
  return { ok: true };
}
