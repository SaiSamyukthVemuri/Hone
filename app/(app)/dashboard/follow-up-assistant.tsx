import Link from "next/link";
import type {
  MissingRecordItem,
  MissingRecordsAssistant,
} from "@/lib/dashboard/missing-records-assistant";

// Follow-up Assistant V1 (PR #249). Presentational only. Renders the
// deterministic, rules-based result from buildMissingRecordsAssistant.
// No AI, no model call, no provider integration, no action: every item
// is a link to an existing, safe, studio-scoped route. Recorded-history
// wording only; calm, never a compliance score or alarm.

function ChipBadge({ chip, priority }: { chip: string; priority: number }) {
  // Amber for the record gaps most worth finishing (charting, aftercare,
  // probe lot, intake); calm neutral for the lower-urgency follow-up.
  const amber = priority <= 4;
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${
        amber
          ? "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200"
          : "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
      }`}
    >
      {chip}
    </span>
  );
}

function AssistantItem({ item }: { item: MissingRecordItem }) {
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-64">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="break-words font-medium text-neutral-900 dark:text-neutral-100">
              {item.clientName}
            </span>
            <ChipBadge chip={item.chip} priority={item.priority} />
          </div>
          <p className="mt-0.5 break-words text-xs text-neutral-600 dark:text-neutral-400">
            {item.reason}
          </p>
        </div>
        <Link
          href={item.href}
          className="self-center rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:border-neutral-900 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-neutral-100 dark:hover:bg-neutral-900"
        >
          {item.actionLabel}
        </Link>
      </div>
    </li>
  );
}

export function FollowUpAssistantCard({
  assistant,
}: {
  assistant: MissingRecordsAssistant;
}) {
  const moreCount = assistant.totalFound - assistant.items.length;
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
      <div>
        <h2 className="text-lg font-medium">Follow-up assistant</h2>
        <p className="text-sm text-neutral-500">
          Record gaps and follow-ups from recent appointments.
        </p>
      </div>

      {!assistant.hasItems ? (
        <div className="rounded-md border border-dashed border-neutral-300 px-4 py-5 text-sm text-neutral-500 dark:border-neutral-700">
          <p>Nothing needs follow-up right now.</p>
          <p className="mt-1 text-xs">
            Recent appointments with a recorded gap — charting, aftercare,
            probe lot, intake, or a for-next-visit note — will appear here.
          </p>
        </div>
      ) : (
        <>
          <ul className="flex flex-col divide-y divide-neutral-200 dark:divide-neutral-800">
            {assistant.items.map((item) => (
              <AssistantItem key={item.id} item={item} />
            ))}
          </ul>
          {moreCount > 0 && (
            <p className="text-xs text-neutral-500">
              Showing {assistant.items.length} of {assistant.totalFound}{" "}
              recorded gaps.
            </p>
          )}
        </>
      )}
    </section>
  );
}
