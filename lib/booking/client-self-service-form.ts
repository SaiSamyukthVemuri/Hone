// HON-47. Strict parse of the owner's client self-service form. Pure, so the
// server action and its tests share one definition of "a valid submission".
//
// Both keys must be present and exactly "true" or "false". A missing or odd
// value returns null and nothing is written: an omitted key must never read as
// "turn it off" (or on).

export type ClientSelfServiceForm = { cancellation: boolean; reschedule: boolean };

function strictBool(value: FormDataEntryValue | null): boolean | null {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

export function parseClientSelfServiceForm(formData: FormData): ClientSelfServiceForm | null {
  const cancellation = strictBool(formData.get("client_cancellation_enabled"));
  const reschedule = strictBool(formData.get("client_reschedule_enabled"));
  if (cancellation === null || reschedule === null) return null;
  return { cancellation, reschedule };
}
