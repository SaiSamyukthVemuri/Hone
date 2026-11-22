/**
 * Shared recipient-facing deadline. The database still owns the expiry instant.
 * The send path renders once per newly issued invitation; its bounded provider
 * retry reuses that payload. Reading the studio timezone therefore does not
 * change bytes between attempts under one key (the same rule as studio names).
 * This adds no resend operation or relative countdown.
 *
 * WHY THE ZONE IS SAFE HERE, AND WHEN IT WOULD NOT BE. `studios.timezone` is
 * mutable operator state: a studio can correct it at any time. The email's
 * delivery key names the invitation alone, so if the same invitation were
 * rendered a second time after the zone changed, the provider would see
 * different content under an unchanged key and answer `invalid_idempotent_request`
 * (a refusal, never a second email). That cannot happen today because nothing
 * sends one invitation twice. If a "resend the same invitation" operation is
 * ever added, it must snapshot the rendered label at first send and reuse it,
 * rather than read the studio's zone again.
 */
export const INVITATION_EXPIRY_TIMEZONE = "UTC";

export function invitationExpiryLabel(
  expiresAt: Date,
  studioTimezone?: string | null,
): string {
  // Never inherit the server/browser timezone or silently assume Toronto.
  // Missing or invalid studio configuration is explicitly labelled UTC.
  let timezone = studioTimezone?.trim() || INVITATION_EXPIRY_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    timezone = INVITATION_EXPIRY_TIMEZONE;
  }
  const label = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(expiresAt);
  return timezone === INVITATION_EXPIRY_TIMEZONE ? label : `${label} (${timezone})`;
}
