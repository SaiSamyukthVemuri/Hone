// HON-48 — check-in (migration 0268). A front-desk fact recorded on the row, not
// derived: appointments.arrived_at. Absent before 0268 is applied, which reads
// as "not checked in" and shows nothing, so the app deploys safely first.

export const ARRIVED_TAG = "Checked in";
export const ARRIVED_GLYPH = "✓";

export function isCheckedIn(appointment: { status: string; arrived_at?: string | null }): boolean {
  return appointment.status === "confirmed" && typeof appointment.arrived_at === "string" && appointment.arrived_at.length > 0;
}

/** Whether the front-desk action is offered: a confirmed appointment only. */
export function canOfferCheckIn(appointment: { status: string }): boolean {
  return appointment.status === "confirmed";
}

export type CheckInOutcome = { ok: true; changed: boolean } | { ok: false; error: string };

/**
 * Maps the command's answer to what the desk sees. Anything unrecognised, and a
 * missing function (the migration is not applied yet), is a plain "not
 * available", never a crash and never a claim that it worked.
 */
export function checkInOutcomeFor(
  arrived: boolean,
  result: unknown,
  error: { code?: string | null; message?: string | null } | null,
): CheckInOutcome {
  if (error) {
    const code = String(error.code ?? "");
    const msg = String(error.message ?? "").toLowerCase();
    if (code === "42883" || code === "PGRST202" || msg.includes("could not find the function") || msg.includes("does not exist")) {
      return { ok: false, error: "Check-in isn't available yet." };
    }
    return { ok: false, error: "Could not update check-in. Please try again." };
  }
  switch (result) {
    case "arrived":
    case "cleared":
      return { ok: true, changed: true };
    case "unchanged":
      return { ok: true, changed: false };
    case "not_authorized":
      return { ok: false, error: "You can't check clients in." };
    case "not_found":
      return { ok: false, error: "That appointment wasn't found." };
    case "wrong_status":
      return { ok: false, error: arrived ? "Only a confirmed appointment can be checked in." : "Could not update check-in." };
    default:
      return { ok: false, error: "Could not update check-in. Please try again." };
  }
}
