import Link from "next/link";
import type { DailyPrepBrief } from "@/lib/dashboard/daily-prep-brief";
import { PilotFeedbackPrompt } from "./pilot-feedback-prompt";

// Daily Prep Brief V1 (PR #241). Presentational only. Renders the
// deterministic, rules-based brief from buildDailyPrepBrief. No AI, no
// model call, no provider integration, no action: every item is a
// link to an existing, safe, studio-scoped client route. The full
// memory stays on the client page; this is the compact prep view.

function PriorityDot({ priority }: { priority: number }) {
  // Amber accent for the items most worth reviewing first (recorded
  // memory / intake / charting attention); neutral once nothing is
  // outstanding. Calm, never alarming.
  const amber = priority <= 4;
  return (
    <span
      aria-hidden
      className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
        amber ? "bg-amber-400" : "bg-neutral-300 dark:bg-neutral-700"
      }`}
    />
  );
}

export function DailyPrepBriefCard({ brief }: { brief: DailyPrepBrief }) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
      <div>
        <h2 className="text-lg font-medium">Daily prep brief</h2>
        <p className="text-sm text-neutral-500">
          Today&apos;s recorded memory and follow-up items.
        </p>
      </div>

      {!brief.hasItems ? (
        <div className="rounded-md border border-dashed border-neutral-300 px-4 py-5 text-sm text-neutral-500 dark:border-neutral-700">
          <p>Nothing needs special review yet.</p>
          <p className="mt-1 text-xs">
            Today&apos;s appointments will appear here when there is recorded
            treatment memory, intake work, or record reminders.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col divide-y divide-neutral-200 dark:divide-neutral-800">
          {brief.items.map((item) => (
            <li key={item.id} className="py-3 first:pt-0 last:pb-0">
              <div className="flex items-start gap-3">
                <PriorityDot priority={item.priority} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                    <Link
                      href={item.href}
                      className="break-words font-medium text-neutral-900 hover:underline dark:text-neutral-100"
                    >
                      {item.title}
                    </Link>
                    <span className="shrink-0 text-xs tabular-nums text-neutral-500">
                      {item.time}
                    </span>
                  </div>
                  <p className="mt-0.5 break-words text-xs text-neutral-500">
                    {item.subtitle}
                  </p>
                  {item.reminders.length > 0 && (
                    <ul className="mt-1.5 flex flex-col gap-0.5">
                      {/* Recorded-memory lines render IN FULL (the 90-char cap
                          is gone). `whitespace-pre-wrap` keeps the line breaks
                          the practitioner typed; `break-words` keeps a long
                          unbroken token from widening the card at iPhone
                          width. Same contract as the Today roster card. */}
                      {item.reminders.map((reminder) => (
                        <li
                          key={reminder}
                          className="whitespace-pre-wrap break-words text-xs text-neutral-700 dark:text-neutral-300"
                        >
                          {reminder}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* PR #250 Pilot Love Loop: a quiet, manual "Was this useful?"
          footer. mailto only — no automated send, no analytics. */}
      <PilotFeedbackPrompt surface="daily_prep" />
    </section>
  );
}
