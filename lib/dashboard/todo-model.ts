import type { ClientsNeedingAttention } from "./clients-needing-attention";
import type { MissingRecordsAssistant } from "./missing-records-assistant";
import type { ProcedureActionMetrics } from "./practice-metrics";
import { supplyExpiryState } from "@/lib/record-keeping/expiry";

// ===========================================================================
// Dashboard V2 Part 2B — ONE To-do model.
// ===========================================================================
//
// Part 1 put one "To do" heading over four independent products — Action
// needed, Follow-up assistant, Supplies expiring, Needs attention. They had
// four loaders, four row grammars, four empty states, and they asked for the
// same unresolved work more than once. Part 1 said so in the page and deferred
// the fix. This module is the fix.
//
//     domain facts  →  THIS normalization / dedupe layer  →  one To-do list
//
// Everything here is PURE. It takes facts the page has already loaded and
// returns an ordered, deduplicated list. It opens no client, issues no query,
// reads no clock, and never calls a model. The domain loaders deliberately
// stay separate — rewriting them is not this PR's scope; unifying what the
// practitioner SEES is.
//
// Product law: completed work disappears, unfinished work comes back. Every
// item below is derived from live domain state on each render, so an item
// vanishes the moment its underlying gap is filled and returns if it reopens.
// Nothing is cached, snapshotted or acknowledged away.
//
// ROW GRAMMAR — every item answers three questions, in this order:
//
//     subject.label   ·   reason        ·   action.label
//     WHO / WHAT         WHY unresolved     WHAT to do next
//
// e.g.  "Dana · Intake awaiting review · Open clients"
//       "Maya · Aftercare not marked · Review session"
//       "Sterile probes · Expired · Open records"
//
// The reason strings are NOT invented here. Each is the wording the shipping
// product already used for that condition (the assistant's `chip`, the
// Needs-attention `title`, the supply expiry label), so the practitioner sees
// the same vocabulary they saw before.

export type TodoKind =
  // Studio-level blockers (previously "Needs attention").
  | "intake_review"
  | "no_services"
  | "payment_setup"
  // Record gaps (previously "Follow-up assistant").
  | "charting"
  | "aftercare"
  | "probe_lot"
  | "intake_incomplete"
  | "follow_up"
  // Clinical treatment memory (previously the "Action needed" attention list).
  | "treatment_memory"
  // Record-keeping completeness roll-up (previously the "Action needed" tiles).
  | "records_details"
  // Supplies (previously "Supplies expiring").
  | "supply_expiry";

export type TodoSubjectKind = "client" | "supply" | "studio";

export type TodoSubject = {
  kind: TodoSubjectKind;
  // Domain identity. A client id, a sterile-item id, or the literal "studio"
  // for studio-wide items. NEVER a rendered string.
  id: string;
  // What the practitioner reads in the WHO/WHAT column.
  label: string;
};

export type TodoAction = {
  href: string;
  label: string;
};

export type DashboardTodoItem = {
  // `${kind}:${subject.id}` — the deduplication key. Deterministic domain
  // identity, never rendered text (see dedupe notes below).
  id: string;
  kind: TodoKind;
  subject: TodoSubject;
  // WHY it is unresolved. Short, recorded-history wording; never advice.
  reason: string;
  // Optional supporting line. Never required to understand the row.
  detail: string | null;
  action: TodoAction;
  // Lower sorts first. See TODO_PRIORITY.
  priority: number;
  // The authoritative domain timestamp for this gap, when one exists.
  // ISO instant, or a YYYY-MM-DD date for supply expiry. Null when the domain
  // genuinely has no timestamp (studio-level setup items).
  occurredAt: string | null;
  // Drives the amber accent, carried over from the existing Needs-attention
  // tone so urgency presentation does not change meaning.
  tone: "urgent" | "normal";
};

// ---------------------------------------------------------------------------
// ORDERING — deterministic, documented, no AI.
// ---------------------------------------------------------------------------
//
// Three tiers, and within a tier the source's own authoritative priority:
//
//   10s  BLOCKING. Someone is waiting, or the studio cannot trade, or stock is
//        already expired. Derived from signals the product ALREADY treats as
//        urgent: the Needs-attention `tone: "urgent"` items, and the
//        `supplyExpiryState() === "expired"` state.
//   20s  RECORD GAPS. A completed piece of work whose record is unfinished.
//        The relative order 20→24 is exactly the missing-records assistant's
//        own priority 1→5, which is the shipped, reviewed ordering for these
//        five gaps; it is preserved rather than re-litigated.
//   30s  CONTEXT. Real but not blocking: clinical treatment memory, stock
//        expiring later, the completeness roll-up.
//   40s  SOFT SETUP NUDGES. The Needs-attention `tone: "soft"` items. Phase-1
//        booking works without them, so they never outrank real work.
//
// Ties break by `occurredAt` NEWEST FIRST, then by `id` ascending.
//
// Newest-first (not oldest-first) is deliberate: it is the rule the
// missing-records assistant already used (`newerFirst`), and the dedupe there
// keeps the most recent instance, so an older-first list would show a
// different session than the one the assistant's own dedupe selected. `id` is
// the final tiebreak so the order is a TOTAL order — two items that tie on
// priority and timestamp still sort deterministically, which is what makes the
// list stable across renders.
export const TODO_PRIORITY: Record<TodoKind, number> = {
  intake_review: 10,
  no_services: 11,
  // Expired stock is blocking; expiring-soon is not. This entry is the
  // BLOCKING one; the soft case is scored explicitly at build time below.
  supply_expiry: 12,
  charting: 20,
  aftercare: 21,
  probe_lot: 22,
  intake_incomplete: 23,
  follow_up: 24,
  treatment_memory: 30,
  records_details: 32,
  payment_setup: 40,
};

// Score for a supply item that is expiring but not yet expired.
const SUPPLY_EXPIRING_SOON_PRIORITY = 31;

// Newest first; nulls last.
function newerFirst(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a < b ? 1 : -1;
}

export function compareTodoItems(
  a: DashboardTodoItem,
  b: DashboardTodoItem,
): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  const byDate = newerFirst(a.occurredAt, b.occurredAt);
  if (byDate !== 0) return byDate;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Inputs — already-loaded domain facts. No loader is called from here.
// ---------------------------------------------------------------------------

export type TodoStudioSignals = {
  isOwner: boolean;
  intakesAwaitingReviewCount: number;
  activeServicesCount: number;
  paymentStatus: {
    hasAccount: boolean;
    onboardingCompleted: boolean;
    payoutsEnabled: boolean;
  } | null;
};

export type TodoSupplyInput = {
  id: string;
  item_description: string;
  manufacturer_name: string;
  expiry_date: string | null;
};

export type BuildDashboardTodoInput = {
  assistant: MissingRecordsAssistant;
  attention: ClientsNeedingAttention;
  supplies: ReadonlyArray<TodoSupplyInput>;
  metrics: ProcedureActionMetrics;
  studio: TodoStudioSignals;
  // Studio-local YYYY-MM-DD, used only to classify supply expiry. Passed in so
  // this module stays clock-free and therefore testable.
  todayLocal: string;
};

export type DashboardTodo = {
  items: DashboardTodoItem[];
  hasItems: boolean;
  // Unresolved work the SOURCES know about but did not hand over, because each
  // domain caps what it returns: the assistant's "Showing N of M" and the
  // attention list's "+ N more". Both affordances existed on the retired cards
  // and would otherwise have been silently dropped, leaving the practitioner
  // believing the list was exhaustive. Summed across domains and rendered once
  // under the list.
  moreCount: number;
};

// The assistant's five gap types map 1:1 onto To-do kinds.
const ASSISTANT_KIND: Record<string, TodoKind> = {
  charting: "charting",
  aftercare: "aftercare",
  probe_lot: "probe_lot",
  intake: "intake_incomplete",
  follow_up: "follow_up",
};

/**
 * Normalize every To-do source into one ordered, deduplicated list.
 *
 * DEDUPLICATION — two mechanisms, both on DOMAIN IDENTITY, never on text.
 *
 * 1. `${kind}:${subject.id}` is unique. Two sources describing the same
 *    unresolved condition for the same subject collapse to one row, and the
 *    first survivor after sorting wins (so the highest-priority, most recent
 *    instance is the one kept).
 *
 *    This is what pins AFTERCARE specifically. "Aftercare not marked" was
 *    reaching the practitioner through TWO paths with mismatched windows and
 *    mismatched units: a per-session row from the missing-records assistant
 *    (120 most recent sessions), and a count tile over the 100 most recent
 *    procedure records. The count tile is gone — `recordsMissingDetails` now
 *    supplies only the part no per-item row covers — and the surviving
 *    aftercare row is keyed `aftercare:<clientId>`, so it cannot appear twice
 *    for the same client's unresolved aftercare no matter how many sources
 *    later learn to report it.
 *
 * 2. One cross-kind rule, for the one genuine cross-source overlap:
 *    `treatment_memory` vs `follow_up`. "Clients needing attention" includes a
 *    client because their newest session carries a watch note, a
 *    plan-for-next-visit, or a notable reaction. The assistant's `follow_up`
 *    fires on the SAME plan note, additionally knowing nothing is booked. When
 *    a client's treatment-memory row rests on the plan note ALONE, the two rows
 *    are the same unresolved fact and `follow_up` — which is strictly more
 *    informed — is kept.
 *
 *    If the treatment-memory row ALSO carries a watch note or a notable
 *    reaction, both rows survive: those are genuinely separate unresolved
 *    facts and collapsing them would hide clinical information.
 *
 * WHAT IS DELIBERATELY *NOT* COLLAPSED:
 *   - `intake_incomplete` (intake started, never submitted) and
 *     `intake_review` (submitted, awaiting the practitioner). Different rows,
 *     different states, different actions. The assistant already excludes
 *     submitted intakes for exactly this reason, and that stays true.
 *   - Two different clients with the same reason.
 *   - Two different supplies.
 */
export function buildDashboardTodo(
  input: BuildDashboardTodoInput,
): DashboardTodo {
  const items: DashboardTodoItem[] = [];

  // --- Studio-level blockers (was "Needs attention") ----------------------
  const { studio } = input;
  if (studio.intakesAwaitingReviewCount > 0) {
    const n = studio.intakesAwaitingReviewCount;
    items.push({
      id: "intake_review:studio",
      kind: "intake_review",
      subject: { kind: "studio", id: "studio", label: "Client intakes" },
      reason: `${n} ${n === 1 ? "intake" : "intakes"} awaiting review`,
      detail:
        "Open the client to read the submitted answers and mark reviewed.",
      action: { href: "/clients", label: "Open clients" },
      priority: TODO_PRIORITY.intake_review,
      occurredAt: null,
      tone: "urgent",
    });
  }

  if (studio.isOwner && studio.activeServicesCount === 0) {
    items.push({
      id: "no_services:studio",
      kind: "no_services",
      subject: { kind: "studio", id: "studio", label: "Booking" },
      reason: "No services yet",
      detail: "Clients can't book until at least one active service exists.",
      action: { href: "/settings/services", label: "Add a service" },
      priority: TODO_PRIORITY.no_services,
      occurredAt: null,
      tone: "urgent",
    });
  }

  if (studio.isOwner && studio.paymentStatus) {
    const p = studio.paymentStatus;
    // Same precedence ladder the Needs-attention card used: only ONE payment
    // nudge is ever shown, and it is the earliest unmet step.
    const nudge = !p.hasAccount
      ? {
          reason: "Stripe not connected yet",
          detail:
            "Public booking still works without it. Connect when you're ready to accept payments.",
          label: "Open Payments",
        }
      : !p.onboardingCompleted
        ? {
            reason: "Stripe setup not finished",
            detail:
              "A few details are still needed. Continue setup when you have a minute.",
            label: "Continue setup",
          }
        : !p.payoutsEnabled
          ? {
              reason: "Payout setup needs attention",
              detail: "Stripe is connected, but payouts aren't ready yet.",
              label: "Open Payments",
            }
          : null;
    if (nudge) {
      items.push({
        id: "payment_setup:studio",
        kind: "payment_setup",
        subject: { kind: "studio", id: "studio", label: "Payments" },
        reason: nudge.reason,
        detail: nudge.detail,
        action: { href: "/settings/payments", label: nudge.label },
        priority: TODO_PRIORITY.payment_setup,
        occurredAt: null,
        tone: "normal",
      });
    }
  }

  // --- Record gaps (was "Follow-up assistant") ----------------------------
  //
  // The assistant's href / actionLabel are carried through UNCHANGED, so every
  // action that worked before still works, and still points at the same
  // specific session or appointment rather than a generic list.
  for (const item of input.assistant.items) {
    const kind = ASSISTANT_KIND[item.type];
    if (!kind) continue;
    items.push({
      id: `${kind}:${item.clientId}`,
      kind,
      subject: { kind: "client", id: item.clientId, label: item.clientName },
      reason: item.chip,
      detail: item.reason,
      action: { href: item.href, label: item.actionLabel },
      priority: TODO_PRIORITY[kind],
      occurredAt: item.date,
      tone: "normal",
    });
  }

  // --- Clinical treatment memory (was the "Action needed" list) -----------
  for (const c of input.attention.clients) {
    const reasons: string[] = [];
    if (c.hasWatch) reasons.push("Watch note");
    if (c.hasPlan) reasons.push("Plan for next visit");
    if (c.notableReactionLabel) {
      reasons.push(`Latest recorded reaction: ${c.notableReactionLabel}`);
    }
    if (reasons.length === 0) continue;
    // The retired card also showed the latest tolerance rating whenever the
    // client was already included. It is context, not a reason for inclusion
    // (there is no tolerance threshold in the codebase and we do not invent
    // one), so it rides on the detail line rather than the reason.
    const tolerance =
      c.latestToleranceRating != null
        ? `Latest tolerance: ${c.latestToleranceRating}/5`
        : null;
    const detail = [c.previewLine || null, tolerance]
      .filter(Boolean)
      .join(" · ");
    items.push({
      id: `treatment_memory:${c.clientId}`,
      kind: "treatment_memory",
      subject: { kind: "client", id: c.clientId, label: c.clientName },
      reason: reasons.join(" · "),
      detail: detail || null,
      action: { href: `/clients/${c.clientId}`, label: "Open client" },
      priority: TODO_PRIORITY.treatment_memory,
      occurredAt: c.latestDate,
      tone: "normal",
    });
  }

  // --- Supplies (was "Supplies expiring") ---------------------------------
  for (const s of input.supplies) {
    const state = supplyExpiryState(s.expiry_date, input.todayLocal);
    if (state === "neutral") continue;
    const expired = state === "expired";
    items.push({
      id: `supply_expiry:${s.id}`,
      kind: "supply_expiry",
      subject: { kind: "supply", id: s.id, label: s.item_description },
      reason: expired
        ? "Expired"
        : state === "today"
          ? "Expires today"
          : "Expires soon",
      detail: s.manufacturer_name || null,
      action: { href: "/records?section=sterile", label: "Open records" },
      priority: expired
        ? TODO_PRIORITY.supply_expiry
        : SUPPLY_EXPIRING_SOON_PRIORITY,
      occurredAt: s.expiry_date,
      tone: expired ? "urgent" : "normal",
    });
  }

  // --- Record-keeping completeness roll-up (was the "Action needed" tiles) -
  //
  // ONLY the part no per-item row covers (client/operator details, or a record
  // with no treatment area). The aftercare and probe-lot tiles are gone: they
  // are per-client rows above. Without this row that capability would simply
  // have been dropped, since nothing else surfaces a missing date of birth.
  if (input.metrics.recordsMissingDetails > 0) {
    const n = input.metrics.recordsMissingDetails;
    items.push({
      id: "records_details:studio",
      kind: "records_details",
      subject: { kind: "studio", id: "studio", label: "Procedure records" },
      reason: `${n} ${n === 1 ? "record is" : "records are"} missing client or operator details`,
      detail: `Across your ${input.metrics.reviewedSessions} most recent charted sessions.`,
      action: {
        href: "/records?section=procedures",
        label: "Open records",
      },
      priority: TODO_PRIORITY.records_details,
      occurredAt: null,
      tone: "normal",
    });
  }

  // --- Order, then dedupe ------------------------------------------------
  // Sorting BEFORE deduping is what makes "first wins" meaningful: the
  // survivor of an identity collision is the highest-priority, most recent
  // instance rather than whichever source happened to be appended first.
  const ordered = [...items].sort(compareTodoItems);

  const seen = new Set<string>();
  const deduped: DashboardTodoItem[] = [];
  for (const item of ordered) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    deduped.push(item);
  }

  // Cross-kind rule: drop a treatment-memory row that rests on the plan note
  // ALONE when the better-informed follow_up row for the same client survived.
  const followUpClientIds = new Set(
    deduped
      .filter((i) => i.kind === "follow_up")
      .map((i) => i.subject.id),
  );
  const planOnlyReason = "Plan for next visit";
  const final = deduped.filter(
    (i) =>
      !(
        i.kind === "treatment_memory" &&
        i.reason === planOnlyReason &&
        followUpClientIds.has(i.subject.id)
      ),
  );

  // What the sources capped away. Never negative, even if a source ever
  // reports a total smaller than the page it returned.
  const moreCount =
    Math.max(
      0,
      input.attention.totalClients - input.attention.clients.length,
    ) +
    Math.max(
      0,
      input.assistant.totalFound - input.assistant.items.length,
    );

  return { items: final, hasItems: final.length > 0, moreCount };
}
