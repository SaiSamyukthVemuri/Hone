import "server-only";
import { buildEventMarker } from "./event-id";
import type { GoogleEventPayload } from "./google-rest-client";

// Google Calendar: Phase B2.3-c1: the fixed, minimal appointment event
// serializer. It is a PURE function over the frozen v1 allow-list (approved
// 2026-07-14) plus the machine-only private correlation marker. It exports ZERO
// client identity / clinical / payment / location / description / token data.
//
// Timestamps: `dateTime` is the UTC instant in offset-bearing RFC3339 (…Z) and
// `timeZone` carries the studio's IANA zone. An absolute instant + an IANA zone
// is unambiguous and DST-correct: Google stores the exact instant and displays it
// in the studio zone (recurrence is never used: Hone appointments are one-off).
// The end is EXCLUSIVE and is the human end (`ends_at`), never a buffered end.

export type SerializerInput = {
  startsAt: string; // appointment starts_at (ISO / timestamptz)
  endsAt: string; // appointment ends_at (the human end; NEVER blocked_ends_at)
  studioTimezone: string; // studios.timezone (IANA)
  linkId: string; // calendar_event_links.id (for the private marker)
};

export type SerializerResult =
  | { ok: true; payload: GoogleEventPayload }
  | { ok: false; reason: string };

const SUMMARY_CONSTANT = "Hone appointment";

function toUtcRfc3339(iso: string): string | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString(); // canonical …Z RFC3339 (offset-bearing)
}

// Build the core event payload (WITHOUT the event id: the create op supplies the
// caller-chosen id in the insert body; patch addresses by id in the URL and sends
// this same body, which preserves the private marker on every update).
export function buildAppointmentEventPayload(input: SerializerInput): SerializerResult {
  const tz = typeof input.studioTimezone === "string" ? input.studioTimezone.trim() : "";
  if (!tz) return { ok: false, reason: "missing_studio_timezone" };

  const startMs = Date.parse(input.startsAt);
  const endMs = Date.parse(input.endsAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return { ok: false, reason: "invalid_datetime" };
  }
  if (endMs <= startMs) {
    return { ok: false, reason: "end_not_after_start" };
  }
  const start = toUtcRfc3339(input.startsAt);
  const end = toUtcRfc3339(input.endsAt);
  if (!start || !end) return { ok: false, reason: "invalid_datetime" };

  const payload: GoogleEventPayload = {
    summary: SUMMARY_CONSTANT,
    start: { dateTime: start, timeZone: tz },
    end: { dateTime: end, timeZone: tz },
    visibility: "private",
    transparency: "opaque",
    extendedProperties: { private: buildEventMarker(input.linkId) },
    // Deliberately omitted: reminders (inherit calendar defaults), attendees,
    // recurrence, description, location, and every excluded/PHI field.
  };
  return { ok: true, payload };
}
