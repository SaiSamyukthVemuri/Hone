import { localDateString } from "@/lib/booking/tz";
import { type Fact } from "@/lib/dashboard/owner-capacity-model";
import { COLLECTED_KINDS } from "@/lib/finance/statement";
import { classifyVisit } from "@/lib/finance/statement-document";
import { assembleClientInputs, type AssembleAppointment, type AssembleResult } from "@/lib/finance/statement-document-assemble";
import type { MoneyRows } from "@/lib/finance/statement-money-read";

import { FORMER_TEAM_MEMBER_LABEL, UNATTRIBUTED_LABEL, UNNAMED_TEAM_MEMBER_LABEL } from "./copy";
import type { Figure, FigureRead, ReadFailure } from "./figure";
import {
  averagePaidPerVisit,
  classifyMoney,
  collectedCaveats,
  collectedForFilter,
  collectionsSeries,
  headlineCollected,
  percentChange,
  practitionerBucketsReconcile,
  splitCollected,
  type AveragePaid,
  type Change,
  type CollectedCaveats,
  type CollectedSplit,
  type PaidVisit,
  type SeriesPoint,
} from "./money-metrics";
import { bucketUnit, bucketsOf, statementsClaim, type PeriodWindow, type ResolvedPeriod, type StatementsClaim, type BucketUnit } from "./period";
import { reconcileWithStatement } from "./reconcile";
import { serviceValueToCollected, type CompletedVisitMoney, type ReconciliationLine } from "./reconciliation-line";
import { PRICE_EVIDENCE_CLASSES, resolveVisits, serviceValue, type PriceCandidate, type PriceEvidenceClass } from "./service-value";
import {
  activeClientIds,
  beyondUsualInterval,
  clientHistories,
  completedVisitCount,
  matchesPractitioner,
  noNextBooking,
  splitReturning,
  studioInterval,
  visitsInWindow,
  visitsOf,
  visitsPerActiveClient,
  visitsWithoutClient,
  type PractitionerFilter,
  type ReturningSplit,
  type StudioInterval,
  type VisitFact,
} from "./visit-metrics";

// ===========================================================================
// Business → Analytics: THE OVERVIEW VIEW MODEL. PURE: it is given rows already read; it reads nothing.
// ===========================================================================
//
// One value drives the screen, the CSV and the print, so they cannot disagree. The VIEW holds AGGREGATES ONLY: no appointment id, no client id, no
// practitioner id and no per-visit price ever leaves this function (the browser is sent exactly this object). Per-visit data lives only inside
// `computeWindow` and is dropped on return.
//
// Each figure is its own `Figure<T>`: a value, or a reason. A read that failed makes only the figures that needed it unavailable. All money shares
// one reconciliation proof: if the Statements identity does not hold for the window, NO money figure is shown for it.

/** The appointments and, separately, their money: a money read that failed must not hide the visit figures, which do not need it. */
export type WindowData = { appointments: readonly AssembleAppointment[]; money: FigureRead<MoneyRows> };

/** Completed-or-not appointments read for the history figures. Per-client data stays inside this module; only counts leave it. */
export type HistoryData = { appointments: readonly AssembleAppointment[] };
/** Collected now against the comparison period, computed here so the screen subtracts nothing: more, less or the same, and by how many cents (never negative). Null when the comparison could not be read. */
export type CollectedDifference = { direction: "more" | "less" | "same"; cents: number };
export function collectedDifference(nowCents: number, previousCents: number | null): CollectedDifference | null {
  if (previousCents === null) return null;
  const d = nowCents - previousCents;
  return { direction: d > 0 ? "more" : d < 0 ? "less" : "same", cents: Math.abs(d) };
}

export type FollowThroughData = { past: readonly AssembleAppointment[]; future: readonly AssembleAppointment[] };

export type PractitionerInfo = { id: string; displayName: string | null; active: boolean };

export type OverviewInput = {
  timezone: string;
  /** Null when the studio's payment currency is not set: every money figure says so, the others still show. */
  currency: string | null;
  nowIso: string;
  period: ResolvedPeriod;
  filter: PractitionerFilter;
  current: FigureRead<WindowData>;
  comparison: FigureRead<WindowData>;
  practitioners: readonly PractitionerInfo[];
  /** Every appointment BEFORE the current window began (any status; completed ones are used). Its failure makes only returning and interval unavailable. */
  history: FigureRead<HistoryData>;
  /** Appointments in the look-back up to now, and those still to come. Its failure makes only "no next booking" unavailable. */
  followThrough: FigureRead<FollowThroughData>;
  /** The kinds of price evidence the loader could actually read. A kind not listed is "not available", never a zero. */
  classesRead: readonly PriceEvidenceClass[];
};

export type ClassView = { read: true; visits: number; cents: number } | { read: false };
export type ServiceValueView = {
  classes: Record<PriceEvidenceClass, ClassView>;
  /** Over the kinds that were READ only. */
  withEvidenceVisits: number;
  withEvidenceCents: number;
  /** Completed visits with no price evidence among the sources read. Always shown beside the figure. */
  missingVisits: number;
  ambiguousVisits: number;
  completedVisits: number;
  unreadClasses: PriceEvidenceClass[];
};

export type ByPractitionerRow = { key: string; label: string; collectedCents: number };

/** Active clients by how many completed visits they had in the period. The three always add up to the active clients. */
export type VisitFrequency = { one: number; two: number; threePlus: number };

export type OverviewView = {
  currentLabel: string;
  comparisonLabel: string;
  /** The studio-local date "now" falls on, and the studio's time zone: said in the footer and the follow-through heading, never a person. */
  asOfLocal: string;
  timezone: string;
  /** The current period's first and last local dates: used for a file name, never a person. */
  currentRange: { startLocal: string; lastLocal: string };
  notes: string[];
  partial: boolean;
  clamped: boolean;
  statementsClaim: StatementsClaim;
  /** The filter's KIND only: never the practitioner's id. */
  filterKind: PractitionerFilter["kind"];
  currency: string | null;
  /** `previousCents` is the comparison period's collected (null when it could not be read), so the difference can be stated in words. */
  collected: Figure<{ headlineCents: number; split: CollectedSplit; caveats: CollectedCaveats; change: Change; previousCents: number | null; difference: CollectedDifference | null }>;
  completedVisits: Figure<{ count: number; change: Change }>;
  activeClients: Figure<{ count: number; withoutClient: number; change: Change }>;
  visitsPerClient: Figure<Fact<number>>;
  averagePaid: Figure<AveragePaid>;
  /** Unavailable when either average is unknown or the comparison could not be read; never a percentage against a missing figure. */
  averagePaidChange: Change;
  series: Figure<{ unit: BucketUnit; points: SeriesPoint[] }>;
  /** The comparison period's series, drawn beside the current one. Aligned by position (day 1 with day 1); a period with fewer days simply ends sooner, its missing days are absent, never 0. */
  previousSeries: Figure<{ unit: BucketUnit; points: SeriesPoint[] }>;
  visitFrequency: Figure<VisitFrequency>;
  byPractitioner: Figure<ByPractitionerRow[]>;
  serviceValue: Figure<ServiceValueView>;
  reconciliation: Figure<ReconciliationLine>;
  /** Of the clients seen in the period, how many had a completed visit before it. First-time means first visit recorded in Hone. */
  returning: Figure<ReturningSplit>;
  /** Average days between a client's completed visits, pooled over the RETURNING clients (seen in the period, with a completed visit before it), through the period's last day; a team-member filter applies to the visits used. */
  interval: Figure<StudioInterval>;
  /** A count only, as of now. The clients themselves are listed on the Clients tab, never here. */
  noNextBooking: Figure<{ count: number }>;
  /**
   * A count only, as of now: clients with at least two completed visit dates, no confirmed booking still to come with anyone, whose days since their last
   * completed visit exceed 1.5 times their OWN average gap (the client's whole history, any practitioner). A team-member filter narrows who is counted (the
   * clients that team member has EVER seen, not only those seen in the period, and never the history or the future-booking test. Clients with fewer than two visit dates are counted apart, never flagged.
   */
  beyondUsual: Figure<{ count: number; notEnoughHistory: number }>;
};

type Window = {
  completedVisits: Figure<number>;
  activeClients: Figure<{ count: number; withoutClient: number }>;
  visitsPerClient: Figure<Fact<number>>;
  visitFrequency: Figure<VisitFrequency>;
  collected: Figure<{ headlineCents: number; split: CollectedSplit; caveats: CollectedCaveats }>;
  averagePaid: Figure<AveragePaid>;
  series: Figure<{ unit: BucketUnit; points: SeriesPoint[] }>;
  byPractitioner: Figure<ByPractitionerRow[]>;
  serviceValue: Figure<ServiceValueView>;
  reconciliation: Figure<ReconciliationLine>;
};

const unavailable = (reason: ReadFailure): { available: false; reason: ReadFailure } => ({ available: false, reason });
const collectedLines = (lines: ReadonlyArray<{ kind: string; cents: number | null }>) => lines.filter((l) => (COLLECTED_KINDS as readonly string[]).includes(l.kind) && typeof l.cents === "number");

function assemble(args: { appointments: readonly AssembleAppointment[]; money: MoneyRows; currency: string; timezone: string; nowIso: string }): AssembleResult {
  return assembleClientInputs({
    studioCurrency: args.currency,
    timezone: args.timezone,
    nowIso: args.nowIso,
    appointments: args.appointments,
    cardRows: args.money.cardRows,
    settlementRows: args.money.settlementRows,
    legacyFeeRows: args.money.legacyFeeRows,
    serviceNames: new Map(),
    practitionerNames: new Map(),
  });
}

/**
 * The kinds of price evidence THIS MODEL can turn into candidates from the rows it is given. A class listed as read by a caller but not supplied here
 * is still "not available": claiming it was read would show a false zero. Adding a class means adding its candidates below AND listing it here.
 */
export const SUPPLIED_EVIDENCE_CLASSES: readonly PriceEvidenceClass[] = ["recorded_at_visit"];

function practitionerLabel(id: string | null, byId: ReadonlyMap<string, PractitionerInfo>): string {
  if (id === null) return UNATTRIBUTED_LABEL;
  const p = byId.get(id);
  if (!p || !p.active) return FORMER_TEAM_MEMBER_LABEL; // a deactivated or removed practitioner is never named
  return p.displayName && p.displayName.trim() ? p.displayName.trim() : UNNAMED_TEAM_MEMBER_LABEL;
}

function visitFrequency(mine: readonly VisitFact[], w: PeriodWindow): VisitFrequency {
  const perClient = new Map<string, number>();
  for (const v of visitsInWindow(mine, w)) if (v.clientId !== null) perClient.set(v.clientId, (perClient.get(v.clientId) ?? 0) + 1);
  const counts = [...perClient.values()];
  return { one: counts.filter((n) => n === 1).length, two: counts.filter((n) => n === 2).length, threePlus: counts.filter((n) => n >= 3).length };
}

function computeWindow(data: WindowData, w: PeriodWindow, o: Pick<OverviewInput, "timezone" | "currency" | "nowIso" | "filter" | "practitioners" | "classesRead"> & { unit: BucketUnit }): Window {
  const facts: VisitFact[] = data.appointments.map((a) => ({
    appointmentId: a.id,
    clientId: a.clientId,
    localDate: localDateString(new Date(a.startsAt), o.timezone),
    practitionerId: a.practitionerId,
    status: a.status,
  }));
  const mine = visitsOf(facts, o.filter);
  const completed = completedVisitCount(mine, w);
  const clients = activeClientIds(mine, w).length;
  const base = {
    completedVisits: { available: true, value: completed } as Figure<number>,
    activeClients: { available: true, value: { count: clients, withoutClient: visitsWithoutClient(mine, w) } } as Figure<{ count: number; withoutClient: number }>,
    visitsPerClient: { available: true, value: visitsPerActiveClient(mine, w) } as Figure<Fact<number>>,
    visitFrequency: { available: true, value: visitFrequency(mine, w) } as Figure<VisitFrequency>,
  };
  const money = (reason: ReadFailure) => ({
    collected: unavailable(reason), averagePaid: unavailable(reason), series: unavailable(reason),
    byPractitioner: unavailable(reason), serviceValue: unavailable(reason), reconciliation: unavailable(reason),
  });
  if (o.currency === null) return { ...base, ...money("currency_unknown") };
  if (!data.money.ok) return { ...base, ...money(data.money.reason) };
  const moneyRows = data.money.value;

  const all = assemble({ appointments: data.appointments, money: moneyRows, currency: o.currency, timezone: o.timezone, nowIso: o.nowIso });
  const subset = o.filter.kind === "all" ? data.appointments : data.appointments.filter((a) => matchesPractitioner(a, o.filter));
  const ids = new Set(subset.map((a) => a.id));
  const moneyF: MoneyRows = o.filter.kind === "all" ? moneyRows : {
    cardRows: moneyRows.cardRows.filter((r) => r.appointmentId !== null && ids.has(r.appointmentId)),
    settlementRows: moneyRows.settlementRows.filter((r) => ids.has(r.appointmentId)),
    legacyFeeRows: moneyRows.legacyFeeRows.filter((r) => ids.has(r.appointmentId)),
  };
  const f = o.filter.kind === "all" ? all : assemble({ appointments: subset, money: moneyF, currency: o.currency, timezone: o.timezone, nowIso: o.nowIso });

  // ---- by practitioner (always the whole studio's statement), labelled and keyed by an opaque index
  const byId = new Map(o.practitioners.map((p) => [p.id, p]));
  const bucketsOk = practitionerBucketsReconcile(all.statement);
  const byPractitioner: Figure<ByPractitionerRow[]> = bucketsOk
    ? { available: true, value: all.statement.byPractitioner.map((b, i) => ({ key: `p${i}`, label: practitionerLabel(b.practitionerId, byId), collectedCents: b.bucket.collectedCents })) }
    : unavailable("not_reconciled");

  // ---- the split and the one reconciliation proof
  const classes = classifyMoney(f);
  const split = splitCollected(f, classes);
  if (!split.ok) return { ...base, ...money("not_reconciled"), byPractitioner };
  const clientsSpend = f.visits.filter((v) => v.eligibility !== "not_completed").reduce((n, v) => n + collectedLines(v.lines).reduce((m, l) => m + (l.cents as number), 0), 0)
    + f.feeItems.reduce((n, it) => n + collectedLines(it.lines).reduce((m, l) => m + (l.cents as number), 0), 0);
  const proof = reconcileWithStatement({
    statement: f.statement,
    overviewCollectedCents: headlineCollected(split.split, "all_money"),
    split: split.split,
    clientsSpendCents: clientsSpend,
    offDocumentCollectedCents: f.offDocumentCollectedCents,
  });
  const filterAgrees = o.filter.kind === "all" || (bucketsOk && collectedForFilter(all.statement, o.filter) === f.statement.all.collectedCents);
  if (!proof.reconciled || !filterAgrees) return { ...base, ...money("not_reconciled"), byPractitioner: bucketsOk ? byPractitioner : unavailable("not_reconciled") };

  // ---- per completed visit, inside this function only
  const treatment = f.visits.filter((v) => v.eligibility === undefined || v.eligibility === "treatment");
  const paid: PaidVisit[] = treatment.map((v) => {
    const d = classifyVisit(v);
    return { appointmentId: v.appointmentId, state: d.state, paidCents: d.paidCents };
  });
  const localDateByAppointment = new Map(facts.filter((x) => ids.has(x.appointmentId)).map((x) => [x.appointmentId, x.localDate]));
  const series = collectionsSeries({ window: w, unit: o.unit, buckets: bucketsOf(w, o.unit).buckets, statement: f.statement, localDateByAppointment, classes });
  const unit = o.unit;

  // A kind of evidence that was not read contributes NOTHING, anywhere: its candidates are dropped before any price is resolved, so the subtotals, the
  // with-evidence totals and the line to collected money all agree with the "not available" shown for it.
  const readClasses = o.classesRead.filter((c) => SUPPLIED_EVIDENCE_CLASSES.includes(c));
  const pv = treatment.map((v) => ({
    appointmentId: v.appointmentId,
    candidates: readClasses.includes("recorded_at_visit") ? v.feeCandidates.filter((c) => c.source === "settlement_quote").map((c): PriceCandidate => ({ evidence: "recorded_at_visit", cents: c.cents })) : [],
  }));
  const sv = serviceValue(pv);
  const resolved = resolveVisits(pv);
  const unread = PRICE_EVIDENCE_CLASSES.filter((c) => !readClasses.includes(c));
  const classView = Object.fromEntries(PRICE_EVIDENCE_CLASSES.map((c) => [c, readClasses.includes(c) ? { read: true, visits: sv.subtotals[c].visits, cents: sv.subtotals[c].cents } : { read: false }])) as Record<PriceEvidenceClass, ClassView>;
  const serviceValueView: ServiceValueView = {
    classes: classView,
    withEvidenceVisits: sv.withEvidenceVisits,
    withEvidenceCents: sv.withEvidenceCents,
    missingVisits: sv.missingVisits,
    ambiguousVisits: sv.missingByReason.ambiguous,
    completedVisits: sv.completedVisits,
    unreadClasses: unread,
  };
  const money7: CompletedVisitMoney[] = treatment.map((v) => {
    const r = resolved.get(v.appointmentId);
    const lines = collectedLines(v.lines);
    return { appointmentId: v.appointmentId, priceCents: r && r.state === "evidence" ? r.cents : null, collectedCents: lines.reduce((n, l) => n + (l.cents as number), 0), collectedRows: lines.length };
  });
  const line = serviceValueToCollected(money7, split.split);
  // With NO kind of price evidence read there is no service value to state: a 0 here would read as "the visits were worth nothing". Collected money is unaffected.
  const noEvidence = readClasses.length === 0;

  return {
    ...base,
    collected: { available: true, value: { headlineCents: headlineCollected(split.split), split: split.split, caveats: collectedCaveats(f.statement) } },
    averagePaid: { available: true, value: averagePaidPerVisit(paid) },
    series: series.ok ? { available: true, value: { unit, points: series.points } } : unavailable("not_reconciled"),
    byPractitioner,
    serviceValue: noEvidence ? unavailable("no_evidence_read") : { available: true, value: serviceValueView },
    reconciliation: noEvidence ? unavailable("no_evidence_read") : line.ok ? { available: true, value: line.line } : unavailable("not_reconciled"),
  };
}

const factsOf = (rows: readonly AssembleAppointment[], timezone: string): VisitFact[] =>
  rows.map((a) => ({ appointmentId: a.id, clientId: a.clientId, localDate: localDateString(new Date(a.startsAt), timezone), practitionerId: a.practitionerId, status: a.status }));

/**
 * Returning, interval and no-next-booking. The practitioner filter decides who counts as SEEN; it never narrows the history (a client is returning if
 * ANY practitioner saw them before) and never narrows the future-booking test (a booking with anyone counts), as the note on the screen says.
 */
function historyFigures(input: OverviewInput, currentData: WindowData): Pick<OverviewView, "returning" | "interval" | "noNextBooking" | "beyondUsual"> {
  const w = input.period.current;
  const tz = input.timezone;
  const todayLocal = localDateString(new Date(input.nowIso), tz);
  const failedHistory = input.history.ok ? null : unavailable(input.history.reason);
  const failedFollow = input.followThrough.ok ? null : unavailable(input.followThrough.reason);

  let returning: Figure<ReturningSplit> = failedHistory ?? unavailable("read_failed");
  let interval: Figure<StudioInterval> = failedHistory ?? unavailable("read_failed");
  if (input.history.ok) {
    const all = [...factsOf(input.history.value.appointments, tz), ...factsOf(currentData.appointments, tz)];
    const completedAll = visitsOf(all); // whole history, every practitioner
    const seen = new Set(activeClientIds(visitsOf(all, input.filter), w));
    returning = { available: true, value: splitReturning([...completedAll.filter((v) => v.clientId !== null && seen.has(v.clientId))], w) };
    // RETURNING clients only: seen in the period AND with a completed visit before it (any practitioner, as the returning card says). Their gaps are
    // between THEIR completed visits up to the period's last day; with a team-member filter those visits are that team member's.
    const before = new Set(completedAll.filter((v) => v.clientId !== null && v.localDate < w.startLocal).map((v) => v.clientId as string));
    const returningIds = new Set([...seen].filter((id) => before.has(id)));
    const histories = clientHistories(visitsOf(all, input.filter).filter((v) => v.clientId !== null && returningIds.has(v.clientId)), w.lastLocal);
    interval = { available: true, value: studioInterval(histories) };
  }

  let next: Figure<{ count: number }> = failedFollow ?? unavailable("read_failed");
  let beyond: Figure<{ count: number; notEnoughHistory: number }> = failedFollow ?? unavailable("read_failed");
  if (input.followThrough.ok) {
    const seenFacts = visitsOf(factsOf(input.followThrough.value.past, tz), input.filter);
    const nowMs = new Date(input.nowIso).getTime();
    const future = new Set(input.followThrough.value.future.filter((a) => a.status === "confirmed" && new Date(a.startsAt).getTime() > nowMs).map((a) => a.clientId));
    next = { available: true, value: { count: noNextBooking({ visits: seenFacts, clientsWithFutureBooking: future, todayLocal }).length } };
    const everyone = visitsOf(factsOf(input.followThrough.value.past, tz));
    const counted = new Set(seenFacts.flatMap((v) => (v.clientId === null ? [] : [v.clientId])));
    const histories = clientHistories(everyone.filter((v) => v.clientId !== null && counted.has(v.clientId)), todayLocal);
    const b = beyondUsualInterval({ histories, clientsWithFutureBooking: future, todayLocal });
    beyond = { available: true, value: { count: b.clientIds.length, notEnoughHistory: b.notEnoughHistory.length } };
  }
  return { returning, interval, noNextBooking: next, beyondUsual: beyond };
}

const numberOf = <T,>(f: Figure<T>, pick: (v: T) => number): number | null => (f.available ? pick(f.value) : null);

export function buildOverview(input: OverviewInput): OverviewView {
  const common = { timezone: input.timezone, currency: input.currency, nowIso: input.nowIso, filter: input.filter, practitioners: input.practitioners, classesRead: input.classesRead, unit: bucketUnit(input.period.current) };
  const cur = input.current.ok ? computeWindow(input.current.value, input.period.current, common) : null;
  const prev = input.comparison.ok ? computeWindow(input.comparison.value, input.period.comparison, common) : null;
  const fail = (read: FigureRead<WindowData>): ReadFailure => (read.ok ? "read_failed" : read.reason);
  const curFail = unavailable(fail(input.current));
  const changeOf = (now: number | null, before: number | null, comparisonRead: boolean): Change => (comparisonRead ? percentChange(now, before) : { kind: "unavailable" });

  const view: OverviewView = {
    asOfLocal: localDateString(new Date(input.nowIso), input.timezone),
    timezone: input.timezone,
    currentLabel: input.period.currentLabel,
    comparisonLabel: input.period.comparisonLabel,
    currentRange: { startLocal: input.period.current.startLocal, lastLocal: input.period.current.lastLocal },
    notes: input.period.notes,
    partial: input.period.partial,
    clamped: input.period.clamped,
    statementsClaim: statementsClaim(input.period.current),
    filterKind: input.filter.kind,
    currency: input.currency,
    collected: curFail, completedVisits: curFail, activeClients: curFail, visitsPerClient: curFail, averagePaid: curFail, averagePaidChange: { kind: "unavailable" },
    series: curFail, previousSeries: curFail, visitFrequency: curFail, byPractitioner: curFail, serviceValue: curFail, reconciliation: curFail,
    returning: curFail, interval: curFail, noNextBooking: curFail, beyondUsual: curFail,
  };
  if (!cur) return view;
  const cmp = prev !== null;
  view.completedVisits = cur.completedVisits.available
    ? { available: true, value: { count: cur.completedVisits.value, change: changeOf(cur.completedVisits.value, prev ? numberOf(prev.completedVisits, (v) => v) : null, cmp) } }
    : cur.completedVisits;
  view.activeClients = cur.activeClients.available
    ? { available: true, value: { ...cur.activeClients.value, change: changeOf(cur.activeClients.value.count, prev ? numberOf(prev.activeClients, (v) => v.count) : null, cmp) } }
    : cur.activeClients;
  view.visitsPerClient = cur.visitsPerClient;
  view.collected = cur.collected.available
    ? { available: true, value: { ...cur.collected.value, change: changeOf(cur.collected.value.headlineCents, prev ? numberOf(prev.collected, (v) => v.headlineCents) : null, cmp), previousCents: prev ? numberOf(prev.collected, (v) => v.headlineCents) : null, difference: collectedDifference(cur.collected.value.headlineCents, prev ? numberOf(prev.collected, (v) => v.headlineCents) : null) } }
    : cur.collected;
  view.averagePaid = cur.averagePaid;
  const avg = (w: Window | null): number | null => (w && w.averagePaid.available && w.averagePaid.value.averageCents.known ? w.averagePaid.value.averageCents.value : null);
  view.averagePaidChange = changeOf(avg(cur), avg(prev), cmp);
  view.series = cur.series;
  view.previousSeries = prev ? prev.series : unavailable(fail(input.comparison));
  view.visitFrequency = cur.visitFrequency;
  view.byPractitioner = cur.byPractitioner;
  view.serviceValue = cur.serviceValue;
  view.reconciliation = cur.reconciliation;
  if (input.current.ok) Object.assign(view, historyFigures(input, input.current.value));
  return view;
}
