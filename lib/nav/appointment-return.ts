// Safe "back to appointment" return-target validation. Mirrors the
// calendar-return.ts posture: NEVER echo an untrusted URL. The only accepted
// value is an internal appointment route "/calendar/<uuid>", a single segment
// that is a valid UUID. Anything external, malformed, cross-route, multi-segment,
// or carrying a query/fragment is rejected and returns null (no back link shown).
const APPOINTMENT_RETURN_RE =
  /^\/calendar\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function sanitizeAppointmentReturnTo(
  value: string | string[] | null | undefined,
): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  if (typeof v !== "string") return null;
  return APPOINTMENT_RETURN_RE.test(v) ? v : null;
}
