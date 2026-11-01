// Decision 6 (Sam, 1 Nov): a practitioner may change their own working hours. The database half is
// migration 0278 (held; applied before this control ships, Insurance W-5). The app cannot see whether
// 0278 is applied, so the control ships DEFAULT-OFF behind this flag (G4) and is switched on only after
// 0278 is applied and read back. Off: the nav entry is hidden for a practitioner, the page says it is
// not available yet, and the actions refuse with a plain sentence. The owner is never affected.
export function practitionerOwnHoursEnabled(): boolean {
  return process.env.HONE_PRACTITIONER_OWN_HOURS_ENABLED === "true";
}

export const OWN_HOURS_NOT_AVAILABLE_MESSAGE =
  "Changing your own working hours is not available yet. Ask the studio owner.";
