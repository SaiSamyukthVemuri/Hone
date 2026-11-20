import { known, unknown, type Fact } from "@/lib/dashboard/owner-capacity-model";

import { daysBetween, inWindow, isRealLocalDate, type LocalDate, type PeriodWindow } from "./period";

// ===========================================================================
// Business → Analytics: VISIT AND CLIENT METRICS. PURE. No I/O, no clock.
// ===========================================================================
//
// Nothing here knows about money. These are counts and dates over appointments the caller already read, each already placed on its
// STUDIO-LOCAL date. The one visit rule is lib/finance/statement-document.ts `classifyEligibility`: a completed treatment is a VISIT, and the
// date of a visit is the day it was booked for (there is no completed-at column). A cancelled or no-show booking is never a visit.
//
// UNKNOWN IS NOT ZERO. A figure that cannot be computed is `{ known: false, reason }` (the `Fact` of lib/dashboard/owner-capacity-model.ts),
// never 0 and never a guess: a client with fewer than two visit dates has no interval, an empty denominator has no average.
// Every ordering is total and stable (ties break by name, then id), so a screen, a CSV and a print list clients in the same order.

/**
 * One appointment, already placed on the studio-local date it starts on. `status` is the appointment's own status, unchanged.
 * `clientId` is null for an appointment that has no client: it is still a VISIT (and its money is kept), but it is never an ACTIVE CLIENT
 * and appears in no per-client figure. The schema says `client_id NOT NULL`, so this path is a FAIL-SAFE ONLY with no UI of its own: it exists so a corrupt read can neither crash a figure nor be counted as a client.
 */
export type VisitFact = {
  appointmentId: string;
  clientId: string | null;
  localDate: LocalDate;
  practitionerId: string | null;
  status: string;
};

export type PractitionerFilter = { kind: "all" } | { kind: "one"; practitionerId: string } | { kind: "unattributed" };
export const ALL_PRACTITIONERS: PractitionerFilter = { kind: "all" };

export function matchesPractitioner(v: Pick<VisitFact, "practitionerId">, f: PractitionerFilter): boolean {
  if (f.kind === "all") return true;
  if (f.kind === "unattributed") return v.practitionerId === null;
  return v.practitionerId === f.practitionerId;
}

/** The visit rule: a completed appointment, on a real local date. Anything else is not a visit. */
export function isVisit(v: Pick<VisitFact, "status" | "localDate">): boolean {
  return v.status === "completed" && isRealLocalDate(v.localDate);
}

/** Completed visits matching the practitioner filter, repeated appointment ids counted once (a repeated id is the same visit). */
export function visitsOf(facts: readonly VisitFact[], filter: PractitionerFilter = ALL_PRACTITIONERS): VisitFact[] {
  const seen = new Set<string>();
  const out: VisitFact[] = [];
  for (const f of facts) {
    if (!isVisit(f) || !matchesPractitioner(f, filter) || seen.has(f.appointmentId)) continue;
    seen.add(f.appointmentId);
    out.push(f);
  }
  return out;
}

export function visitsInWindow(visits: readonly VisitFact[], w: Pick<PeriodWindow, "startLocal" | "endLocalExclusive">): VisitFact[] {
  return visits.filter((v) => inWindow(v.localDate, w));
}

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------

export function completedVisitCount(visits: readonly VisitFact[], w: Pick<PeriodWindow, "startLocal" | "endLocalExclusive">): number {
  return visitsInWindow(visits, w).length;
}

/** Distinct clients with at least one completed visit in the window. */
export function activeClientIds(visits: readonly VisitFact[], w: Pick<PeriodWindow, "startLocal" | "endLocalExclusive">): string[] {
  return [...new Set(visitsInWindow(visits, w).flatMap((v) => (v.clientId === null ? [] : [v.clientId])))].sort();
}

/** Completed visits in the window on an appointment with no client. Counted as visits, never as clients. */
export function visitsWithoutClient(visits: readonly VisitFact[], w: Pick<PeriodWindow, "startLocal" | "endLocalExclusive">): number {
  return visitsInWindow(visits, w).filter((v) => v.clientId === null).length;
}

/** Completed visits that have a client, per active client, in the window (numerator and denominator are the same visits). Not available when nobody was seen. */
export function visitsPerActiveClient(visits: readonly VisitFact[], w: Pick<PeriodWindow, "startLocal" | "endLocalExclusive">): Fact<number> {
  const clients = activeClientIds(visits, w).length;
  if (clients === 0) return unknown("No client had a completed visit in this period.");
  return known(visitsInWindow(visits, w).filter((v) => v.clientId !== null).length / clients);
}

// ---------------------------------------------------------------------------
// Returning and first-time
// ---------------------------------------------------------------------------

export type ReturningSplit = {
  activeClients: number;
  /** Had a completed visit BEFORE the window began. */
  returning: number;
  /** No completed visit before the window began, as far as Hone's records go. */
  firstTime: number;
  /** returning / activeClients as a number from 0 to 100, or not available when nobody was seen. */
  returningPercent: Fact<number>;
};

/**
 * `visits` must hold the client's WHOLE recorded history (not just this window). "First-time" means first visit RECORDED IN HONE: a client
 * whose earlier history was imported or never entered counts as first-time here, and the screen says so.
 */
export function splitReturning(visits: readonly VisitFact[], w: Pick<PeriodWindow, "startLocal" | "endLocalExclusive">): ReturningSplit {
  const active = activeClientIds(visits, w);
  const before = new Set(visits.filter((v) => v.localDate < w.startLocal).flatMap((v) => (v.clientId === null ? [] : [v.clientId])));
  const returning = active.filter((id) => before.has(id)).length;
  return {
    activeClients: active.length,
    returning,
    firstTime: active.length - returning,
    returningPercent: active.length === 0 ? unknown("No client had a completed visit in this period.") : known((100 * returning) / active.length),
  };
}

// ---------------------------------------------------------------------------
// Visit interval
// ---------------------------------------------------------------------------

export type ClientHistory = {
  clientId: string;
  /** Distinct studio-local dates of completed visits up to the cut-off, ascending. Two visits on one date are one date. */
  visitDates: LocalDate[];
  /** Day gaps between consecutive visit dates. */
  gaps: number[];
  lastVisitDate: LocalDate | null;
  /** Mean of the gaps, or not available when the client has fewer than two visit dates. */
  averageGapDays: Fact<number>;
};

/** Per-client history through `throughLocal` (inclusive). Visits after it are ignored (a future-dated or later visit never shapes a past figure). */
export function clientHistories(visits: readonly VisitFact[], throughLocal: LocalDate): Map<string, ClientHistory> {
  const dates = new Map<string, Set<LocalDate>>();
  for (const v of visits) {
    if (v.localDate > throughLocal || v.clientId === null) continue;
    let s = dates.get(v.clientId);
    if (!s) dates.set(v.clientId, (s = new Set()));
    s.add(v.localDate);
  }
  const out = new Map<string, ClientHistory>();
  for (const [clientId, set] of dates) {
    const visitDates = [...set].sort();
    const gaps: number[] = [];
    for (let i = 1; i < visitDates.length; i++) gaps.push(daysBetween(visitDates[i - 1], visitDates[i]));
    out.set(clientId, {
      clientId,
      visitDates,
      gaps,
      lastVisitDate: visitDates.length ? visitDates[visitDates.length - 1] : null,
      averageGapDays: gaps.length === 0 ? unknown("Needs at least two visit dates.") : known(gaps.reduce((n, g) => n + g, 0) / gaps.length),
    });
  }
  return out;
}

export type StudioInterval = {
  /** Mean of ALL clients' gaps pooled (a client with many visits weighs more), or not available when there is no gap at all. */
  pooledAverageDays: Fact<number>;
  clientsWithInterval: number;
  /** Clients in the history with fewer than two visit dates: excluded, and counted so the screen can say how many. */
  clientsWithoutInterval: number;
};

export function studioInterval(histories: ReadonlyMap<string, ClientHistory>): StudioInterval {
  let sum = 0;
  let n = 0;
  let withGap = 0;
  let without = 0;
  for (const h of histories.values()) {
    if (h.gaps.length === 0) {
      without++;
      continue;
    }
    withGap++;
    for (const g of h.gaps) {
      sum += g;
      n++;
    }
  }
  return {
    pooledAverageDays: n === 0 ? unknown("No client has two visit dates yet.") : known(sum / n),
    clientsWithInterval: withGap,
    clientsWithoutInterval: without,
  };
}

// ---------------------------------------------------------------------------
// Follow-through: no next booking, beyond usual interval
// ---------------------------------------------------------------------------

/** Months looked back for "no next booking". A product choice, so a parameter, never a constant buried in a loop. */
export const DEFAULT_NO_NEXT_BOOKING_LOOKBACK_MONTHS = 12;
/** "Beyond usual" means longer since the last visit than this multiple of the client's own average gap (the reference's rule). */
export const DEFAULT_BEYOND_USUAL_FACTOR = 1.5;

export function monthsBefore(d: LocalDate, months: number): LocalDate {
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(5, 7));
  const day = Number(d.slice(8, 10));
  const idx = y * 12 + (m - 1) - months;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`;
}

/**
 * Clients seen in the look-back who have no future booking. "Future booking" is supplied by the caller as the set of client ids that have an
 * appointment still `confirmed` after now; this function never reads one. Point in time: it is "as of today", not a period figure.
 */
export function noNextBooking(args: {
  visits: readonly VisitFact[];
  clientsWithFutureBooking: ReadonlySet<string>;
  todayLocal: LocalDate;
  lookbackMonths?: number;
}): string[] {
  const from = monthsBefore(args.todayLocal, args.lookbackMonths ?? DEFAULT_NO_NEXT_BOOKING_LOOKBACK_MONTHS);
  const seen = new Set<string>();
  for (const v of args.visits) if (v.clientId !== null && v.localDate >= from && v.localDate <= args.todayLocal) seen.add(v.clientId);
  return [...seen].filter((id) => !args.clientsWithFutureBooking.has(id)).sort();
}

export type BeyondUsual = {
  clientIds: string[];
  /** Clients with no future booking whose history is too short to say (fewer than two visit dates): listed apart, never flagged. */
  notEnoughHistory: string[];
};

export function beyondUsualInterval(args: {
  histories: ReadonlyMap<string, ClientHistory>;
  clientsWithFutureBooking: ReadonlySet<string>;
  todayLocal: LocalDate;
  factor?: number;
}): BeyondUsual {
  const factor = args.factor ?? DEFAULT_BEYOND_USUAL_FACTOR;
  const flagged: string[] = [];
  const short: string[] = [];
  for (const h of args.histories.values()) {
    if (args.clientsWithFutureBooking.has(h.clientId) || h.lastVisitDate === null) continue;
    if (!h.averageGapDays.known) {
      short.push(h.clientId);
      continue;
    }
    if (daysBetween(h.lastVisitDate, args.todayLocal) > factor * h.averageGapDays.value) flagged.push(h.clientId);
  }
  return { clientIds: flagged.sort(), notEnoughHistory: short.sort() };
}

// ---------------------------------------------------------------------------
// Rankings
// ---------------------------------------------------------------------------

export type ClientRow = {
  clientId: string;
  name: string;
  periodVisits: number;
  /** Money kept in the period, or null when money is not available (never 0 for "unknown"). */
  periodPaidCents: number | null;
  lifetimePaidCents: number | null;
  averageGapDays: number | null;
  lastVisitDate: LocalDate | null;
};

export type RankBy = "spend" | "lifetime" | "visits" | "interval" | "last_visit" | "name";
export const RANK_BYS: readonly RankBy[] = ["spend", "lifetime", "visits", "interval", "last_visit", "name"];

// Code-unit comparison on purpose: it does not depend on the server's locale, so the order is the same everywhere.
function cmpText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
/** Larger first; a missing value always sorts last. */
function desc(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}
/** Smaller first; a missing value always sorts last. */
function asc(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

export function compareClients(by: RankBy): (a: ClientRow, b: ClientRow) => number {
  const tie = (a: ClientRow, b: ClientRow) => cmpText(a.name, b.name) || cmpText(a.clientId, b.clientId);
  switch (by) {
    case "spend":
      return (a, b) => desc(a.periodPaidCents, b.periodPaidCents) || desc(a.periodVisits, b.periodVisits) || tie(a, b);
    case "lifetime":
      return (a, b) => desc(a.lifetimePaidCents, b.lifetimePaidCents) || tie(a, b);
    case "visits":
      return (a, b) => desc(a.periodVisits, b.periodVisits) || desc(a.periodPaidCents, b.periodPaidCents) || tie(a, b);
    case "interval":
      return (a, b) => asc(a.averageGapDays, b.averageGapDays) || desc(a.periodVisits, b.periodVisits) || tie(a, b);
    case "last_visit":
      return (a, b) => {
        if (a.lastVisitDate === b.lastVisitDate) return tie(a, b);
        if (a.lastVisitDate === null) return 1;
        if (b.lastVisitDate === null) return -1;
        return a.lastVisitDate < b.lastVisitDate ? 1 : -1; // most recent first
      };
    case "name":
      return tie;
  }
}

/** The top `n` clients by a ranking (server-side top-N: the caller never ships the whole roster to a browser). `n` is clamped to 1..100. */
export function rankClients(rows: readonly ClientRow[], by: RankBy, n: number): ClientRow[] {
  const take = Math.max(1, Math.min(100, Math.trunc(Number.isFinite(n) ? n : 1)));
  return [...rows].sort(compareClients(by)).slice(0, take);
}

/** "Most frequent returns" is the shortest average gap, so a client with no interval is not eligible. */
export function mostFrequentReturns(rows: readonly ClientRow[], n: number): ClientRow[] {
  return rankClients(rows.filter((r) => r.averageGapDays !== null), "interval", n);
}

/** A page of the sorted roster. Page size is clamped to 1..100; a page past the end is empty, never an error. */
export function pageClients(rows: readonly ClientRow[], by: RankBy, page: number, pageSize: number): { rows: ClientRow[]; page: number; pageSize: number; total: number; pageCount: number } {
  const size = Math.max(1, Math.min(100, Math.trunc(Number.isFinite(pageSize) ? pageSize : 25)));
  const p = Math.max(1, Math.trunc(Number.isFinite(page) ? page : 1));
  const sorted = [...rows].sort(compareClients(by));
  return { rows: sorted.slice((p - 1) * size, p * size), page: p, pageSize: size, total: sorted.length, pageCount: Math.max(1, Math.ceil(sorted.length / size)) };
}
