"use server";

import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import {
  loadAppointmentPreviewDetail,
  type AppointmentPreviewDetailResult,
} from "@/lib/calendar/appointment-preview-detail";

// Lazy prep load for the calendar's appointment preview drawer.
//
// Called ONLY when a drawer opens, for the one appointment that was clicked.
// The week grid issues nothing; see lib/calendar/appointment-preview-detail.ts
// for why the cost is constant in the size of the week.
//
// The practitioner and studio are re-derived SERVER-SIDE on every call. The
// browser supplies exactly one value — an appointment id — and it is a pointer,
// never authority: no studio id, no role, no status, no client id is trusted
// from the request, and an id belonging to another studio resolves to "not
// found in this studio" rather than to a row.
//
// Read-only. It never cancels, moves, charges, or writes anything; those stay
// with the shared commands the drawer mounts.

export type { AppointmentPreviewDetailResult };

// Same shape the caller sees for a genuinely missing row, so a failure to
// resolve the session cannot be told apart from a bad id.
const DENIED = "This appointment could not be found in this studio.";

export async function loadAppointmentPreviewAction(
  appointmentId: string,
): Promise<AppointmentPreviewDetailResult> {
  let studioId: string;
  try {
    const { studio } = await getCurrentPractitionerWithStudio();
    studioId = studio.id;
  } catch {
    // Fail closed. An unauthenticated caller, a user with no active
    // practitioner row, or an unresolved multi-studio selection all get the
    // same denial and no appointment data.
    return { ok: false, reason: DENIED };
  }

  return loadAppointmentPreviewDetail({
    studioId,
    appointmentId: typeof appointmentId === "string" ? appointmentId : "",
  });
}
