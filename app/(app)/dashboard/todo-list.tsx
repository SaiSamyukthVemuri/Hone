"use client";

import { useState } from "react";
import Link from "next/link";
import {
  TODO_COMPACT_COUNT,
  type DashboardTodo,
} from "@/lib/dashboard/todo-model";

// ===========================================================================
// Dashboard V2 Part 2B, the ONE To-do list.
// ===========================================================================
//
// Replaces four independent visible sub-sections (Action needed, Follow-up
// assistant, Supplies expiring, Needs attention) with one ordered list built
// from one normalized model (lib/dashboard/todo-model.ts).
//
// Every row reads the same way:
//
//     subject  ·  reason  ·  action
//     WHO/WHAT    WHY        WHAT NEXT
//
// There is exactly one empty state, not four. Presentational only: no loader,
// no query, no clock: `items` is already ordered and deduplicated.

export function DashboardTodoList({ todo }: { todo: DashboardTodo }) {
  // DASH-TRUTH-02: the list used to end with the non-interactive text
  // "+ N more not shown". That told a practitioner work was hidden and then
  // gave them no way to see it. The rows are now genuinely loaded (see
  // TODO_DISCLOSURE_LIMIT), so this is a real in-place disclosure: no
  // navigation, no fake control, and the count can only ever name rows that
  // can actually be rendered.
  const [expanded, setExpanded] = useState(false);

  if (!todo.hasItems) {
    return (
      <p className="rounded-lg border border-dashed border-neutral-300 px-4 py-6 text-sm text-neutral-500 dark:border-neutral-700">
        Nothing to do right now. Finished work drops off this list
        automatically.
      </p>
    );
  }

  const hiddenCount = Math.max(0, todo.items.length - TODO_COMPACT_COUNT);
  const visible = expanded ? todo.items : todo.items.slice(0, TODO_COMPACT_COUNT);

  return (
    <>
    <ul id="dashboard-todo-list" className="flex flex-col divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
      {visible.map((item) => {
        const urgent = item.tone === "urgent";
        return (
          <li
            key={item.id}
            data-todo-id={item.id}
            data-todo-kind={item.kind}
            className={
              urgent
                ? "flex flex-wrap items-start justify-between gap-3 border-l-4 border-l-amber-500 bg-amber-50 px-4 py-3 first:rounded-t-lg last:rounded-b-lg dark:bg-amber-950/30"
                : "flex flex-wrap items-start justify-between gap-3 px-4 py-3"
            }
          >
            <div className="min-w-0 flex-1 basis-64">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                {/* WHO / WHAT */}
                <span
                  className={
                    urgent
                      ? "break-words font-medium text-amber-900 dark:text-amber-200"
                      : "break-words font-medium text-neutral-900 dark:text-neutral-100"
                  }
                >
                  {item.subject.label}
                </span>
                <span
                  aria-hidden
                  className="text-xs text-neutral-400 dark:text-neutral-600"
                >
                  ·
                </span>
                {/* WHY it is unresolved */}
                <span
                  className={
                    urgent
                      ? "text-sm text-amber-800 dark:text-amber-300/90"
                      : "text-sm text-neutral-600 dark:text-neutral-400"
                  }
                >
                  {item.reason}
                </span>
              </div>
              {item.detail && (
                <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-500">
                  {item.detail}
                </p>
              )}
            </div>
            {/* WHAT the practitioner can do next. Always a real, existing
                route: this list never renders a dead CTA. */}
            <Link
              href={item.action.href}
              className="self-center shrink-0 rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:border-neutral-900 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-neutral-100 dark:hover:bg-neutral-900"
            >
              {item.action.label}
            </Link>
          </li>
        );
      })}
    </ul>
    {hiddenCount > 0 && (
      <button
        type="button"
        data-testid="todo-disclosure-toggle"
        aria-expanded={expanded}
        aria-controls="dashboard-todo-list"
        onClick={() => setExpanded((v) => !v)}
        className="mt-2 rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:border-neutral-900 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-neutral-100 dark:hover:bg-neutral-900"
      >
        {expanded ? "Show less" : `Show ${hiddenCount} more`}
      </button>
    )}
    {/* A safety scan cap can still mean the studio has older unresolved work
        this list never scanned. Say so plainly rather than implying the list
        is exhaustive, but never as a control, because there is nothing more
        to reveal in place. */}
    {todo.moreCount > 0 && (
      <p className="mt-2 text-xs text-neutral-500">
        Older items beyond this list are not included.
      </p>
    )}
    </>
  );
}
