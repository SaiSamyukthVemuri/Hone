"use client";

import { useState } from "react";
import Link from "next/link";
import type {
  AttentionClient,
  AttentionItemKind,
  NeedsAttention,
} from "@/lib/dashboard/needs-attention-model";
import type { DashboardTodoItem } from "@/lib/dashboard/todo-model";

// Needs Attention: ONE list, ONE card per client id. Presentational only: `needs` is already grouped and
// ordered by lib/dashboard/needs-attention-model.ts, which is pure. No loader,
// no query, no clock, and NO WRITE. Every action is a plain link to an existing
// page; opening one never marks anything reviewed or complete.

export const NEEDS_ATTENTION_COMPACT_COUNT = 6;

const ACTION_CLASS =
  "shrink-0 rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:border-neutral-900 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-neutral-100 dark:hover:bg-neutral-900";

const BADGE: Record<AttentionItemKind, string> = {
  intake_review: "Intake",
  intake_incomplete: "Intake form",
  charting: "Charting",
  aftercare: "Aftercare",
  probe_lot: "Probe lot",
  record_details: "Record details",
  treatment_memory: "Reaction / watch",
};

const BADGE_CLASS =
  "inline-flex shrink-0 items-center rounded-full border border-neutral-300 px-2 py-0.5 text-[11px] font-medium text-neutral-700 dark:border-neutral-700 dark:text-neutral-300";

// What the single "Show N more" control reveals: every card past the compact
// count, and it says so. The studio group, when present, is the last card.
export function hiddenCardsLabel(hiddenClients: number, studioHidden: boolean): string {
  const clients = `${hiddenClients} more ${hiddenClients === 1 ? "client" : "clients"}`;
  if (hiddenClients === 0) return "Show studio items";
  return studioHidden ? `Show ${clients} and studio items` : `Show ${clients}`;
}

function ClientCard({ card }: { card: AttentionClient }) {
  return (
    <li
      data-attention-client={card.clientId}
      data-attention-tier={card.tier}
      className="flex flex-col gap-2 px-4 py-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <Link
          href={`/clients/${card.clientId}`}
          className="break-words font-medium text-neutral-900 hover:underline dark:text-neutral-100"
        >
          {card.clientName}
        </Link>
        <span className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
          {card.sharesNameWithAnotherClient && (
            <span data-testid="needs-attention-same-name">Same name as another client</span>
          )}
          <span>{card.tier === "preparation" ? "Before visit" : "Follow-up"}</span>
          {card.items.length > 1 && <span>{card.items.length} items</span>}
        </span>
      </div>
      <ul className="flex flex-col gap-2">
        {card.items.map((item) => (
          <li
            key={item.id}
            data-attention-issue={item.kind}
            className="flex flex-wrap items-start justify-between gap-2"
          >
            <div className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
              <span className="flex flex-wrap items-center gap-2">
                <span className={BADGE_CLASS}>{BADGE[item.kind]}</span>
                <span className="min-w-0 break-words text-sm text-neutral-700 dark:text-neutral-300">
                  {item.label}
                </span>
              </span>
              {item.detail && (
                <span className="break-words text-xs text-neutral-500">{item.detail}</span>
              )}
            </div>
            <Link href={item.href} className={ACTION_CLASS}>
              {item.actionLabel}
            </Link>
          </li>
        ))}
      </ul>
    </li>
  );
}

function StudioCard({ items }: { items: ReadonlyArray<DashboardTodoItem> }) {
  return (
    <li data-attention-studio className="flex flex-col gap-2 px-4 py-3">
      <span className="font-medium text-neutral-900 dark:text-neutral-100">Studio</span>
      <ul className="flex flex-col gap-2">
        {items.map((item) => (
          <li
            key={item.id}
            data-todo-id={item.id}
            data-todo-kind={item.kind}
            className="flex flex-wrap items-start justify-between gap-2"
          >
            <div className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
              <span className="break-words text-sm text-neutral-700 dark:text-neutral-300">
                <span className="font-medium text-neutral-900 dark:text-neutral-100">
                  {item.subject.label}
                </span>
                {" · "}
                {item.reason}
              </span>
              {item.detail && (
                <span className="break-words text-xs text-neutral-500">{item.detail}</span>
              )}
            </div>
            <Link href={item.action.href} className={ACTION_CLASS}>
              {item.action.label}
            </Link>
          </li>
        ))}
      </ul>
    </li>
  );
}

export function NeedsAttentionPanel({ needs }: { needs: NeedsAttention }) {
  const [expanded, setExpanded] = useState(false);

  // Insurance N3: say what the details check covers, so a clean list is not read
  // as "every session ever is complete".
  const windowNote =
    needs.detailsWindow !== null ? (
      <p data-testid="needs-attention-window" className="text-xs text-neutral-500">
        Checks the studio&apos;s most recent {needs.detailsWindow} charted
        sessions for missing client or operator details.
      </p>
    ) : null;

  const unavailableNote =
    needs.unavailableChecks.length > 0 ? (
      <p
        role="status"
        data-testid="needs-attention-unavailable"
        className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
      >
        Could not check {needs.unavailableChecks.join(" and ")} just now, so
        this list may be incomplete. Reload to try again.
      </p>
    ) : null;

  if (needs.clients.length === 0 && needs.studioItems.length === 0) {
    // Something was capped away: this is not an all-clear.
    if (needs.notReturnedCount > 0) {
      return (
        <div className="flex flex-col gap-2">
          {unavailableNote}
          <p data-testid="needs-attention-capped" className="text-sm text-neutral-600 dark:text-neutral-400">
            Older items beyond this list are not included, so this may not be
            everything.
          </p>
          {windowNote}
        </div>
      );
    }
    if (unavailableNote) {
      return (
        <div className="flex flex-col gap-2">
          {unavailableNote}
          {windowNote}
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-2">
        <p className="rounded-lg border border-dashed border-neutral-300 px-4 py-6 text-sm text-neutral-500 dark:border-neutral-700">
          Nothing needs attention right now. Finished work drops off this list
          automatically.
        </p>
        {windowNote}
      </div>
    );
  }

  // ONE list: client cards, then (when present) one studio card. The compact
  // count applies to the cards, and the single control after the last card
  // reveals every card past it.
  const studioPresent = needs.studioItems.length > 0;
  const cardCount = needs.clients.length + (studioPresent ? 1 : 0);
  const hiddenCount = Math.max(0, cardCount - NEEDS_ATTENTION_COMPACT_COUNT);
  const shownClients = expanded
    ? needs.clients
    : needs.clients.slice(0, NEEDS_ATTENTION_COMPACT_COUNT);
  const showStudio =
    studioPresent && (expanded || needs.clients.length < NEEDS_ATTENTION_COMPACT_COUNT);
  const hiddenClients = needs.clients.length - shownClients.length;

  return (
    <div className="flex flex-col gap-3">
      {unavailableNote}
      <p
        data-testid="needs-attention-count"
        className="text-sm text-neutral-600 dark:text-neutral-400"
      >
        {needs.clients.length} {needs.clients.length === 1 ? "client" : "clients"}
        {", "}
        {needs.itemCount} {needs.itemCount === 1 ? "item" : "items"}
      </p>
      <ul
        id="needs-attention-list"
        className="flex flex-col divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800"
      >
        {shownClients.map((card) => (
          <ClientCard key={card.clientId} card={card} />
        ))}
        {showStudio && <StudioCard items={needs.studioItems} />}
      </ul>
      {hiddenCount > 0 && (
        <button
          type="button"
          data-testid="needs-attention-toggle"
          aria-expanded={expanded}
          aria-controls="needs-attention-list"
          onClick={() => setExpanded((v) => !v)}
          className={`self-start ${ACTION_CLASS}`}
        >
          {expanded ? "Show less" : hiddenCardsLabel(hiddenClients, studioPresent && !showStudio)}
        </button>
      )}
      {needs.notReturnedCount > 0 && (
        <p className="text-xs text-neutral-500">
          Older items beyond this list are not included.
        </p>
      )}
      {windowNote}
    </div>
  );
}
