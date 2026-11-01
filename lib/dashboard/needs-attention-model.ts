import type { IntakeAwaitingReview } from "./intakes-awaiting-review";
import type { MissingRecordsAssistant } from "./missing-records-assistant";
import type { DashboardTodo, DashboardTodoItem } from "./todo-model";
import { practitionerIntakeReviewHref } from "./today-intake";

// ===========================================================================
// Needs Attention: ONE entry per client + session, with the issues inside it.
// ===========================================================================
//
// PURE. Takes facts the page has already loaded; opens no client, issues no
// query, reads no clock. It does NOT change any metric definition: every issue
// below is a row an existing loader already produced.
//
// GROUPING. An entry's identity is the client plus the record the issues are
// about:
//
//     intake:<client>            intake awaiting review / intake incomplete
//     session:<client>:<session> aftercare not marked, probe lot missing
//     appointment:<client>:<id>  charting needed
//
// Two issues on the SAME session fold into one entry (so "aftercare" and "probe
// lot" for one visit read as one line with two chips). Two different sessions of
// one client are two entries, and two different clients are never merged. The
// grouping key is the structured source id, never rendered text.
//
// ORDER. Preparation first (intake), then outstanding clinical documentation,
// newest record first within each. The tie-break is the entry id, so the order
// is total and stable across renders.
//
// NOTHING HERE MARKS ANYTHING REVIEWED OR COMPLETE. Every action is a plain
// navigation to the existing page; an item leaves the list only when the
// underlying record is genuinely finished.

// A source that could not be read. Distinct from "read and found nothing": an
// unreadable check must never look like a clean one.
export const CHECK_UNAVAILABLE = "unavailable" as const;

export type AttentionIssueKind =
  | "intake_review"
  | "intake_incomplete"
  | "charting"
  | "aftercare"
  | "probe_lot"
  | "record_details";

export type AttentionIssue = {
  kind: AttentionIssueKind;
  // The reason the practitioner already reads for this gap.
  label: string;
  href: string;
  actionLabel: string;
};

export type AttentionEntry = {
  // `<scope>:<client>[:<record>]`; the domain identity, also the React key.
  id: string;
  scope: "intake" | "session" | "appointment";
  tier: "preparation" | "documentation";
  clientId: string;
  clientName: string;
  // Newest relevant timestamp (ISO) or null. Used for order and display only.
  occurredAt: string | null;
  issues: AttentionIssue[];
};

export type NeedsAttention = {
  entries: AttentionEntry[];
  // Total issues across all entries, so the heading can state both counts.
  issueCount: number;
  // Items that are not about one client's record (supplies, treatment memory,
  // the procedure-record roll-up, owner setup items). They stay reachable.
  others: DashboardTodoItem[];
  // Gaps the sources know about but did not hand over because of a scan or
  // return cap. When > 0 the panel must say the list is not exhaustive.
  notReturnedCount: number;
  // Names of checks that could not be read, in plain words. When non-empty the
  // panel says the list may be incomplete and never shows the all-clear.
  unavailableChecks: string[];
};

const GROUPED_TODO_KINDS: ReadonlySet<DashboardTodoItem["kind"]> = new Set([
  "charting",
  "aftercare",
  "probe_lot",
  "intake_incomplete",
  // Replaced by one entry per client; the studio-level count row is not kept.
  "intake_review",
]);

function newerFirst(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a < b ? 1 : -1;
}

export function buildNeedsAttention(input: {
  assistant: MissingRecordsAssistant;
  intakesAwaitingReview: ReadonlyArray<IntakeAwaitingReview>;
  todo: DashboardTodo;
  unavailableChecks?: ReadonlyArray<string>;
  // Clients with a confirmed visit coming up. An intake gap for one of them is
  // PREPARATION (listed first); for anyone else it sorts with the general
  // follow-up work. Omitted when the read failed: every intake gap stays in the
  // preparation tier, which is the safe direction (nothing is hidden or reordered
  // below other work).
  upcomingVisitClientIds?: ReadonlySet<string>;
  // Per-session procedure-record gaps (client or operator details). When
  // supplied they replace the studio-level "records missing details" row.
  recordDetailGaps?: ReadonlyArray<{
    sessionId: string;
    clientId: string;
    clientName: string;
    startedAt: string;
  }>;
}): NeedsAttention {
  const byId = new Map<string, AttentionEntry>();

  const add = (entry: Omit<AttentionEntry, "issues">, issue: AttentionIssue) => {
    const existing = byId.get(entry.id);
    if (existing) {
      existing.issues.push(issue);
      if (newerFirst(entry.occurredAt, existing.occurredAt) < 0) {
        existing.occurredAt = entry.occurredAt;
      }
      return;
    }
    byId.set(entry.id, { ...entry, issues: [issue] });
  };

  const intakeTier = (clientId: string): AttentionEntry["tier"] =>
    !input.upcomingVisitClientIds || input.upcomingVisitClientIds.has(clientId)
      ? "preparation"
      : "documentation";

  for (const i of input.intakesAwaitingReview) {
    add(
      {
        id: `intake:${i.clientId}`,
        scope: "intake",
        tier: intakeTier(i.clientId),
        clientId: i.clientId,
        clientName: i.clientName,
        occurredAt: i.submittedAt || null,
      },
      {
        kind: "intake_review",
        label: "Intake awaiting review",
        href: practitionerIntakeReviewHref(i.clientId),
        actionLabel: "Review intake",
      },
    );
  }

  const allItems = input.assistant.allItems ?? [];
  for (const item of allItems) {
    if (item.type === "intake") {
      add(
        {
          id: `intake:${item.clientId}`,
          scope: "intake",
          tier: intakeTier(item.clientId),
          clientId: item.clientId,
          clientName: item.clientName,
          occurredAt: item.date,
        },
        {
          kind: "intake_incomplete",
          label: item.chip,
          href: item.href,
          actionLabel: item.actionLabel,
        },
      );
      continue;
    }
    if (item.type === "charting" && item.appointmentId) {
      add(
        {
          id: `appointment:${item.clientId}:${item.appointmentId}`,
          scope: "appointment",
          tier: "documentation",
          clientId: item.clientId,
          clientName: item.clientName,
          occurredAt: item.date,
        },
        {
          kind: "charting",
          label: item.chip,
          href: item.href,
          actionLabel: item.actionLabel,
        },
      );
      continue;
    }
    if (
      (item.type === "aftercare" || item.type === "probe_lot") &&
      item.sessionId
    ) {
      add(
        {
          id: `session:${item.clientId}:${item.sessionId}`,
          scope: "session",
          tier: "documentation",
          clientId: item.clientId,
          clientName: item.clientName,
          occurredAt: item.date,
        },
        {
          kind: item.type,
          label: item.chip,
          href: item.href,
          actionLabel: item.actionLabel,
        },
      );
    }
  }

  for (const g of input.recordDetailGaps ?? []) {
    add(
      {
        id: `session:${g.clientId}:${g.sessionId}`,
        scope: "session",
        tier: "documentation",
        clientId: g.clientId,
        clientName: g.clientName,
        occurredAt: g.startedAt,
      },
      {
        kind: "record_details",
        label: "Client or operator details missing",
        href: `/clients/${g.clientId}/sessions/${g.sessionId}`,
        actionLabel: "Review session",
      },
    );
  }

  const entries = [...byId.values()].sort((a, b) => {
    if (a.tier !== b.tier) return a.tier === "preparation" ? -1 : 1;
    const byDate = newerFirst(a.occurredAt, b.occurredAt);
    if (byDate !== 0) return byDate;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return {
    entries,
    issueCount: entries.reduce((n, e) => n + e.issues.length, 0),
    others: input.todo.items.filter(
      (i) =>
        !GROUPED_TODO_KINDS.has(i.kind) &&
        // Replaced by per-session entries when those were supplied.
        !(input.recordDetailGaps && i.kind === "records_details"),
    ),
    unavailableChecks: [...(input.unavailableChecks ?? [])],
    notReturnedCount: Math.max(
      0,
      (input.assistant.allTotal ?? allItems.length) - allItems.length,
    ),
  };
}
