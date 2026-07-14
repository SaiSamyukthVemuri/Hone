// Google Calendar — Phase B2.4 destination-aware event-scope contract (app side).
//
// This is the application mirror of the DB seam
// `public.calendar_required_event_scopes(p_destination_mode text)` (migration
// 0131). The required outbound event scope DERIVES from the connection's chosen
// destination:
//   dedicated_app_created -> calendar.app.created  (manage events on a calendar
//                            Hone created)
//   existing_owned        -> calendar.events.owned (manage events on a calendar
//                            the connected user owns)
// Broad `calendar.events` is NOT part of this contract — it satisfies nothing.
//
// EXACT SET MEMBERSHIP ONLY. `calendar.events` is a literal PREFIX of
// `calendar.events.owned`, so membership is checked by exact, normalized string
// equality in a Set — never substring / prefix / startsWith / one-string
// `includes`. An unset/unknown destination yields NULL required scopes and is
// FAIL-CLOSED (mirrors the DB returning NULL, never an empty array).

export type CalendarDestinationMode = "dedicated_app_created" | "existing_owned";

export const CALENDAR_DESTINATION_MODES: readonly CalendarDestinationMode[] = [
  "dedicated_app_created",
  "existing_owned",
] as const;

// The two destination event scopes (the ONLY event scopes B2.4 ever requests).
export const CALENDAR_APP_CREATED_SCOPE =
  "https://www.googleapis.com/auth/calendar.app.created";
export const CALENDAR_EVENTS_OWNED_SCOPE =
  "https://www.googleapis.com/auth/calendar.events.owned";

export function isCalendarDestinationMode(
  mode: unknown,
): mode is CalendarDestinationMode {
  return mode === "dedicated_app_created" || mode === "existing_owned";
}

// The EXACT required event scope(s) for a destination mode. Returns null (never
// an empty array) for null/unknown/malformed — the caller must treat null as
// NOT-ready (fail-closed), exactly like the DB function.
export function requiredEventScopesForDestination(
  mode: string | null | undefined,
): string[] | null {
  switch (mode) {
    case "dedicated_app_created":
      return [CALENDAR_APP_CREATED_SCOPE];
    case "existing_owned":
      return [CALENDAR_EVENTS_OWNED_SCOPE];
    default:
      return null;
  }
}

// The SINGLE exact required event scope for a destination mode, as a string (each
// mode maps to exactly one scope). Returns null for null/unknown/malformed — the
// caller treats null as "no destination bound / fail-closed". Used to BIND the
// exact scope onto the OAuth state at upgrade-start and to re-derive+compare it in
// the callback (a tampered single-column state value cannot pass).
export function requiredEventScopeFor(
  mode: string | null | undefined,
): string | null {
  const scopes = requiredEventScopesForDestination(mode);
  return scopes && scopes.length === 1 ? scopes[0] : null;
}

// Normalize a provider granted-scope value (either a whitespace-delimited string,
// as Google's token response returns, or an array) into a de-duplicated array of
// exact, trimmed, non-empty scope strings. No prefix/substring transformation.
export function normalizeGrantedScopes(
  providerScopes: string | readonly string[] | null | undefined,
): string[] {
  if (providerScopes == null) return [];
  const parts = Array.isArray(providerScopes)
    ? providerScopes
    : String(providerScopes).split(/\s+/);
  const seen = new Set<string>();
  for (const raw of parts) {
    const s = typeof raw === "string" ? raw.trim() : "";
    if (s.length > 0) seen.add(s);
  }
  return [...seen];
}

// True iff EVERY exact required scope for the mode is present (exact Set
// membership) in the normalized granted scopes. Fail-closed when the mode is
// invalid (required === null) or the required set is empty.
export function hasRequiredEventScopes(
  mode: string | null | undefined,
  grantedScopes: string | readonly string[] | null | undefined,
): boolean {
  const required = requiredEventScopesForDestination(mode);
  if (required == null || required.length === 0) return false; // fail-closed
  const granted = new Set(normalizeGrantedScopes(grantedScopes));
  return required.every((scope) => granted.has(scope));
}

// The required scopes for the mode that are NOT present (exact membership).
// Empty array = all present (or, defensively, an invalid mode returns [] here but
// hasRequiredEventScopes() is the readiness authority and fails closed on invalid).
export function missingRequiredEventScopes(
  mode: string | null | undefined,
  grantedScopes: string | readonly string[] | null | undefined,
): string[] {
  const required = requiredEventScopesForDestination(mode);
  if (required == null) return []; // invalid mode: not "missing"; readiness fails closed elsewhere
  const granted = new Set(normalizeGrantedScopes(grantedScopes));
  return required.filter((scope) => !granted.has(scope));
}
