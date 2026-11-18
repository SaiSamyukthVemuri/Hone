import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { isBookedManuallyResult, type BookedManuallyResult } from "./booked-manually-notice";

// The owner command "Booked manually": links an appointment to a waiting list entry and moves the entry to Booked (out of the active queue, history
// kept). The database re-derives the owner and decides every refusal; the studio and actor come from the verified session, never a form. Nothing
// is sent. An unreadable result is `unavailable`, never success, and nothing here logs a row, an id or an error body.
export async function markEntryBookedManually(
  studioId: string,
  actorUserId: string,
  entryId: string,
  appointmentId: string,
  confirmEmailMismatch: boolean,
): Promise<BookedManuallyResult> {
  try {
    const { data, error } = await createAdminClient().rpc("mark_waitlist_entry_booked_manually", {
      p_studio_id: studioId,
      p_actor_user_id: actorUserId,
      p_entry_id: entryId,
      p_appointment_id: appointmentId,
      p_confirm_email_mismatch: confirmEmailMismatch === true,
    });
    if (error || !Array.isArray(data) || data.length !== 1) return "unavailable";
    const result = (data[0] as { result?: unknown }).result;
    return isBookedManuallyResult(result) ? result : "unavailable";
  } catch {
    return "unavailable";
  }
}
