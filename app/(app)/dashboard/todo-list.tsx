import Link from "next/link";
import type { DashboardTodo } from "@/lib/dashboard/todo-model";

// ===========================================================================
// Dashboard V2 Part 2B — the ONE To-do list.
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
// no query, no clock — `items` is already ordered and deduplicated.

export function DashboardTodoList({ todo }: { todo: DashboardTodo }) {
  if (!todo.hasItems) {
    return (
      <p className="rounded-lg border border-dashed border-neutral-300 px-4 py-6 text-sm text-neutral-500 dark:border-neutral-700">
        Nothing to do right now. Finished work drops off this list
        automatically.
      </p>
    );
  }

  return (
    <>
    <ul className="flex flex-col divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
      {todo.items.map((item) => {
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
                <p className="mt-0.5 truncate text-xs text-neutral-500 dark:text-neutral-500">
                  {item.detail}
                </p>
              )}
            </div>
            {/* WHAT the practitioner can do next. Always a real, existing
                route — this list never renders a dead CTA. */}
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
    {/* The sources cap what they return. Saying so keeps the list honest: a
        practitioner must not read the last row as "and that's everything". */}
    {todo.moreCount > 0 && (
      <p className="mt-2 text-xs text-neutral-500">
        + {todo.moreCount} more not shown
      </p>
    )}
    </>
  );
}
