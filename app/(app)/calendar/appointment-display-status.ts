// Display-derived appointment status.
//
// The DB row is NEVER mutated here: a `confirmed` appointment whose end time
// has passed is shown as "done" in the UI, but its stored status stays
// `confirmed`. We don't know whether the client actually showed up, so Mark
// no-show must remain available (gated on the DB status, not this value).
// "completed" is reserved for rows whose DB status is genuinely `completed`;
// a derived past-confirmed appointment is "done", never "completed".
//
// Pure and computed at render time with Date.now() — no timers, no polling.
// Status flips on the next render / navigation / refresh / revalidation.
// Absolute UTC comparison on the ISO `ends_at`, never a local-string compare.
export type AppointmentDisplayStatus =
  | "upcoming"
  | "done"
  | "completed"
  | "no_show"
  | "cancelled";

export function appointmentDisplayStatus(
  status: string,
  endsAt: string,
): AppointmentDisplayStatus {
  if (status === "cancelled") return "cancelled";
  if (status === "no_show") return "no_show";
  if (status === "completed") return "completed";
  // confirmed: derive "done" once the end instant has passed.
  const endsMs = new Date(endsAt).getTime();
  if (Number.isFinite(endsMs) && endsMs <= Date.now()) return "done";
  return "upcoming";
}
