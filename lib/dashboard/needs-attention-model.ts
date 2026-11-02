import type { IntakeAwaitingReview } from "./intakes-awaiting-review";
import type { MissingRecordsAssistant } from "./missing-records-assistant";
import type { DashboardTodo, DashboardTodoItem } from "./todo-model";
import { practitionerIntakeReviewHref } from "./today-intake";
import { cardHasReaction } from "./attention-card";

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

// One line inside a client's card. Every row the panel shows is one of these, so a
// client with a session gap, an intake gap and a reaction on record reads as ONE
// card with three badged lines instead of three rows in two lists.
export type AttentionItemKind = AttentionIssueKind | "treatment_memory";

export type AttentionItem = {
  // Stable React key.
  id: string;
  kind: AttentionItemKind;
  label: string;
  detail: string | null;
  href: string;
  actionLabel: string;
};

export type AttentionClient = {
  // The grouping key. A client id from the loader, never a rendered name.
  clientId: string;
  clientName: string;
  tier: "preparation" | "documentation";
  occurredAt: string | null;
  items: AttentionItem[];
  // Another card in this list carries the same display name for a DIFFERENT client
  // id. They are never merged; the panel says so, so two similar cards are not
  // read as a duplicate.
  sharesNameWithAnotherClient: boolean;
};

export type NeedsAttention = {
  // ONE card per client: the list the panel renders.
  clients: AttentionClient[];
  // Items that belong to no client (supplies, owner setup, the records roll-up).
  studioItems: DashboardTodoItem[];
  // Every line in `clients` plus `studioItems`: the "items" in the heading.
  itemCount: number;
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
  // When the per-session details check ran, how many recent sessions it covers;
  // null when it did not run. The panel prints it (Insurance N3).
  detailsWindow: number | null;
};

const GROUPED_TODO_KINDS: ReadonlySet<DashboardTodoItem["kind"]> = new Set([
  "charting",
  "aftercare",
  "probe_lot",
  "intake_incomplete",
  // Replaced by one entry per client; the studio-level count row is not kept.
  "intake_review",
]);

// A to-do's detail line sometimes repeats a clause already printed in its reason
// (a reaction-only client printed "Latest recorded reaction: X" twice). Drop only
// a clause that is already in the reason, so no distinct text is lost.
function detailWithoutRepeats(reason: string, detail: string | null): string | null {
  if (!detail) return null;
  const printed = new Set(reason.split(" · ").map((c) => c.trim().toLowerCase()));
  const kept = detail
    .split(" · ")
    .map((c) => c.trim())
    .filter((c) => c !== "" && !printed.has(c.toLowerCase()));
  return kept.length > 0 ? kept.join(" · ") : null;
}

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
  detailsWindow?: number | null;
  // Treatment-memory clients the attention source knew about but did not hand
  // over because of its own cap (`totalClients - clients.length`). The retired
  // To-do list counted these in `moreCount`; dropping them would let a studio
  // with more capped clients read as complete (Codex P2).
  treatmentMemoryNotReturned?: number;
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

  const others = input.todo.items.filter(
    (i) =>
      !GROUPED_TODO_KINDS.has(i.kind) &&
      // Replaced by per-session entries when those were supplied.
      !(input.recordDetailGaps && i.kind === "records_details"),
  );
  const studioItems = others.filter((i) => i.subject.kind !== "client");

  // One card per client id. Entries are already keyed by client + record; here
  // they fold by client alone, and a client-subject to-do (treatment memory) joins
  // the card of the SAME client id.
  const cards = new Map<string, AttentionClient>();
  const touch = (clientId: string, clientName: string, occurredAt: string | null) => {
    let card = cards.get(clientId);
    if (!card) {
      card = {
        clientId,
        clientName,
        tier: "documentation",
        occurredAt,
        items: [],
        sharesNameWithAnotherClient: false,
      };
      cards.set(clientId, card);
    } else if (newerFirst(occurredAt, card.occurredAt) < 0) {
      card.occurredAt = occurredAt;
    }
    return card;
  };
  for (const e of entries) {
    const card = touch(e.clientId, e.clientName, e.occurredAt);
    if (e.tier === "preparation") card.tier = "preparation";
    for (const issue of e.issues) {
      card.items.push({
        id: `${e.id}:${issue.kind}`,
        kind: issue.kind,
        label: issue.label,
        detail: null,
        href: issue.href,
        actionLabel: issue.actionLabel,
      });
    }
  }
  for (const item of others) {
    if (item.subject.kind !== "client") continue;
    touch(item.subject.id, item.subject.label, item.occurredAt || null).items.push({
      id: item.id,
      kind: "treatment_memory",
      label: item.reason,
      detail: detailWithoutRepeats(item.reason, item.detail),
      href: item.action.href,
      actionLabel: item.action.label,
    });
  }
  // Order: before-visit cards, then cards carrying a reaction/watch item (a clinical signal that must
  // not sit behind the compact cut), then documentation-tier cards. Newest first within each rank.
  const rank = (c: AttentionClient) =>
    c.tier === "preparation" ? 0 : cardHasReaction(c) ? 1 : 2;
  const clients = [...cards.values()].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    const byDate = newerFirst(a.occurredAt, b.occurredAt);
    if (byDate !== 0) return byDate;
    return a.clientId < b.clientId ? -1 : a.clientId > b.clientId ? 1 : 0;
  });
  const idsByName = new Map<string, Set<string>>();
  for (const c of clients) {
    const key = c.clientName.trim().toLocaleLowerCase();
    (idsByName.get(key) ?? idsByName.set(key, new Set()).get(key)!).add(c.clientId);
  }
  for (const c of clients) {
    c.sharesNameWithAnotherClient =
      (idsByName.get(c.clientName.trim().toLocaleLowerCase())?.size ?? 0) > 1;
  }

  return {
    clients,
    studioItems,
    itemCount:
      clients.reduce((n, c) => n + c.items.length, 0) + studioItems.length,
    entries,
    issueCount: entries.reduce((n, e) => n + e.issues.length, 0),
    others,
    unavailableChecks: [...(input.unavailableChecks ?? [])],
    detailsWindow: input.detailsWindow ?? null,
    notReturnedCount:
      Math.max(0, (input.assistant.allTotal ?? allItems.length) - allItems.length) +
      Math.max(0, input.treatmentMemoryNotReturned ?? 0),
  };
}
