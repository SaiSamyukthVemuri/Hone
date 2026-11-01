"use client";

import { useState } from "react";
import Link from "next/link";
import type {
  AttentionEntry,
  NeedsAttention,
} from "@/lib/dashboard/needs-attention-model";

// Needs Attention, grouped. Presentational only: `needs` is already grouped and
// ordered by lib/dashboard/needs-attention-model.ts, which is pure. No loader,
// no query, no clock, and NO WRITE. Every action is a plain link to an existing
// page; opening one never marks anything reviewed or complete.

export const NEEDS_ATTENTION_COMPACT_COUNT = 6;

const ACTION_CLASS =
  "shrink-0 rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:border-neutral-900 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-neutral-100 dark:hover:bg-neutral-900";

function EntryRow({ entry }: { entry: AttentionEntry }) {
  return (
    <li
      data-attention-id={entry.id}
      data-attention-scope={entry.scope}
      className="flex flex-col gap-2 px-4 py-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="break-words font-medium text-neutral-900 dark:text-neutral-100">
          {entry.clientName}
        </span>
        {entry.issues.length > 1 && (
          <span className="text-xs text-neutral-500">
            {entry.issues.length} items
          </span>
        )}
      </div>
      <ul className="flex flex-col gap-2">
        {entry.issues.map((issue) => (
          <li
            key={issue.kind}
            data-attention-issue={issue.kind}
            className="flex flex-wrap items-center justify-between gap-2"
          >
            <span className="min-w-0 break-words text-sm text-neutral-600 dark:text-neutral-400">
              {issue.label}
            </span>
            <Link href={issue.href} className={ACTION_CLASS}>
              {issue.actionLabel}
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

  if (needs.entries.length === 0 && needs.others.length === 0) {
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

  const hiddenCount = Math.max(
    0,
    needs.entries.length - NEEDS_ATTENTION_COMPACT_COUNT,
  );
  const visible = expanded
    ? needs.entries
    : needs.entries.slice(0, NEEDS_ATTENTION_COMPACT_COUNT);

  return (
    <div className="flex flex-col gap-3">
      {unavailableNote}
      {needs.entries.length > 0 && (
        <>
          <p
            data-testid="needs-attention-count"
            className="text-sm text-neutral-600 dark:text-neutral-400"
          >
            {needs.entries.length}{" "}
            {needs.entries.length === 1 ? "visit or client" : "visits and clients"}
            {needs.issueCount !== needs.entries.length &&
              `, ${needs.issueCount} items`}
          </p>
          <ul
            id="needs-attention-list"
            className="flex flex-col divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800"
          >
            {visible.map((entry) => (
              <EntryRow key={entry.id} entry={entry} />
            ))}
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
              {expanded ? "Show less" : `Show ${hiddenCount} more`}
            </button>
          )}
        </>
      )}
      {needs.others.length > 0 && (
        <ul
          data-testid="needs-attention-other"
          className="flex flex-col divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800"
        >
          {needs.others.map((item) => (
            <li
              key={item.id}
              data-todo-id={item.id}
              data-todo-kind={item.kind}
              className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
            >
              <div className="min-w-0 flex-1 basis-48">
                <span className="break-words text-sm font-medium text-neutral-900 dark:text-neutral-100">
                  {item.subject.label}
                </span>
                <span className="text-sm text-neutral-600 dark:text-neutral-400">
                  {" · "}
                  {item.reason}
                </span>
                {item.detail && (
                  <p className="mt-0.5 break-words text-xs text-neutral-500">
                    {item.detail}
                  </p>
                )}
              </div>
              <Link href={item.action.href} className={ACTION_CLASS}>
                {item.action.label}
              </Link>
            </li>
          ))}
        </ul>
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
