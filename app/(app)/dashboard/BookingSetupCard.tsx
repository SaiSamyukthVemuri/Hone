import Link from "next/link";
import { BookingLinkCard } from "../settings/booking/BookingLinkCard";
import type { BookingReadiness, ReadinessItem } from "@/lib/booking/readiness";

// Owner-only dashboard surface that doubles as:
//   - publish-readiness checklist (derived; no schema)
//   - "your booking link" (copy + open + paste-it-where helper)
//
// Ready state: compact "Booking page ready" header + the existing
// BookingLinkCard (inline variant) + "Open booking page" link + helper text.
// Not-ready state: "Set up your booking page" header + every missing
// required item, each linked to the right settings tab. The link itself
// is intentionally hidden when not ready so owners don't share a URL that
// would render the public soft-gate.

type Props = {
  readiness: BookingReadiness;
  studioSlug: string | null | undefined;
  appOrigin: string;
};

export function BookingSetupCard({ readiness, studioSlug, appOrigin }: Props) {
  const isReady = readiness.status === "ready";
  const slug =
    typeof studioSlug === "string" && studioSlug.length > 0
      ? studioSlug
      : null;

  return (
    <section
      aria-labelledby="booking-setup-heading"
      className="flex flex-col gap-5 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800"
    >
      <header className="flex flex-col gap-1">
        <h2
          id="booking-setup-heading"
          className="text-lg font-medium"
        >
          {isReady ? "Booking page ready" : "Set up your booking page"}
        </h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {isReady
            ? "Your public booking page is live. Share the link wherever your clients find you."
            : "A few things are still needed before your booking page can accept appointments."}
        </p>
      </header>

      {isReady && slug && (
        <div className="flex flex-col gap-3">
          <BookingLinkCard
            slug={slug}
            origin={appOrigin}
            variant="inline"
          />
          <div className="flex flex-wrap items-center gap-3">
            <a
              href={readiness.publicBookingUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              Open booking page
            </a>
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              Opens the same page your clients see.
            </span>
          </div>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            Add this link to your website, Instagram bio, Google Business
            profile, or email signature.
          </p>
        </div>
      )}

      <Checklist items={readiness.items} />
    </section>
  );
}

function Checklist({ items }: { items: ReadinessItem[] }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {items.map((it) => (
        <ChecklistRow key={it.key} item={it} />
      ))}
    </ul>
  );
}

function ChecklistRow({ item }: { item: ReadinessItem }) {
  // Visual rules:
  //   ok + required        → solid check, calm
  //   missing + required   → empty circle, neutral-strong, link to fix
  //   ok + optional        → solid check, calm
  //   missing + optional   → empty circle, neutral-muted (informational,
  //                          not a blocker)
  const isMissingRequired = !item.ok && item.required;
  const isMissingOptional = !item.ok && !item.required;
  const mark = item.ok ? "✓" : "·";
  const markClass = item.ok
    ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300"
    : isMissingRequired
      ? "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
      : "bg-neutral-200 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400";
  const labelClass = item.ok
    ? "text-neutral-800 dark:text-neutral-200"
    : isMissingRequired
      ? "text-neutral-900 dark:text-neutral-100"
      : "text-neutral-500 dark:text-neutral-400";

  return (
    <li className="flex items-start gap-2 text-sm">
      <span
        aria-hidden
        className={`mt-0.5 inline-flex h-4 w-4 flex-none items-center justify-center rounded-full text-[10px] font-bold ${markClass}`}
      >
        {mark}
      </span>
      <span className={`flex flex-1 flex-wrap items-baseline gap-x-2 ${labelClass}`}>
        <span>{item.label}</span>
        {!item.ok && (
          <Link
            href={item.href}
            className="text-xs font-medium text-neutral-700 underline decoration-dotted underline-offset-2 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-neutral-100"
          >
            {isMissingOptional ? "Review" : "Set up"}
          </Link>
        )}
        {isMissingOptional && (
          <span className="text-xs text-neutral-500 dark:text-neutral-500">
            Optional
          </span>
        )}
      </span>
    </li>
  );
}
