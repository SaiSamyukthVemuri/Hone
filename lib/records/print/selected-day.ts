// HON-46 — which treatments belong on a one-client, one-day print packet.
//
// Pure selection logic. No I/O: the caller reads sessions (paged, see
// ./paging.ts) and hands them here. Keeping the rule here means the "which day
// is it" and "whose record is it" decisions are testable without a database,
// and a page cannot quietly re-derive them differently.
//
// The day is a STUDIO-LOCAL calendar date. It is converted to a half-open UTC
// interval [00:00 that day, 00:00 next day) in the studio's IANA timezone, the
// same convention as the Records print view (utcInstantsForLocalDayRange), so a
// 23-hour spring-forward day and a 25-hour fall-back day are each one whole day.

import { addDays, utcInstantFromLocal } from "@/lib/booking/tz";

export type DayParse =
  | { ok: true; day: string }
  | { ok: false; reason: "missing" | "invalid" };

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date in YYYY-MM-DD form (rejects 2026-02-30, 2026-13-01). */
export function parseSelectedDay(raw: string | undefined | null): DayParse {
  if (!raw) return { ok: false, reason: "missing" };
  if (!DAY.test(raw)) return { ok: false, reason: "invalid" };
  const d = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) {
    return { ok: false, reason: "invalid" };
  }
  return { ok: true, day: raw };
}

export type DayBounds = { fromUtc: string; toUtcExclusive: string };

/** UTC instants bounding one studio-local day: inclusive start, exclusive end. */
export function selectedDayBounds(day: string, timezone: string): DayBounds {
  return {
    fromUtc: utcInstantFromLocal(day, "00:00", timezone).toISOString(),
    toUtcExclusive: utcInstantFromLocal(addDays(day, 1), "00:00", timezone).toISOString(),
  };
}

/** The columns selection needs. A page may carry more; selection reads only these. */
export type SelectableSession = {
  id: string;
  client_id: string;
  studio_id: string;
  started_at: string;
  deleted_at: string | null;
};

export type SelectedDay<T extends SelectableSession> =
  | { kind: "empty"; day: string; clientId: string }
  | { kind: "sessions"; day: string; clientId: string; sessions: T[] };

/**
 * Keep exactly this client's live sessions in this studio that started inside
 * the studio-local day, oldest first (ties broken by id so output is stable).
 *
 * An empty result is an explicit "empty" value, never an empty list that a
 * caller could render as, or widen into, "all records".
 */
export function selectSessionsForDay<T extends SelectableSession>(
  sessions: readonly T[],
  scope: { studioId: string; clientId: string; day: string; timezone: string },
): SelectedDay<T> {
  const { fromUtc, toUtcExclusive } = selectedDayBounds(scope.day, scope.timezone);
  const from = Date.parse(fromUtc);
  const to = Date.parse(toUtcExclusive);
  const kept = sessions
    .filter((s) => {
      if (s.studio_id !== scope.studioId) return false;
      if (s.client_id !== scope.clientId) return false;
      if (s.deleted_at !== null) return false;
      const t = Date.parse(s.started_at);
      return Number.isFinite(t) && t >= from && t < to;
    })
    .sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return kept.length === 0
    ? { kind: "empty", day: scope.day, clientId: scope.clientId }
    : { kind: "sessions", day: scope.day, clientId: scope.clientId, sessions: kept };
}
