import Link from "next/link";
import type { BookingReadiness, ReadinessItem } from "@/lib/booking/readiness";

// Owner-only dashboard surface: the publish-readiness checklist for a booking
// page that is NOT yet ready (derived; no schema flag).
//
// CHLOE D2. It renders only while there is setup left to do.
// ---------------------------------------------------------------------------
// This card used to have two states. The "ready" state was a permanent
// congratulation: "Booking page ready" / "Your public booking page is live",
// the booking link, an Open-booking-page button, and a column of green ticks,
// that sat on the Dashboard forever once an established studio had finished
// setting up. It was no longer operational work, and it was the single biggest
// block of finished-setup clutter on the page.
//
// So the ready state is GONE, not merely hidden by the caller: `readiness.status
// === "ready"` renders null. Keeping the decision in the component means a
// future caller cannot reintroduce the banner by forgetting a guard, and there
// is no unreachable branch left behind to rot.
//
// Nothing was removed from the product. Readiness itself is unchanged
// (lib/booking/readiness.ts is untouched), the public booking page is
// soft-gated independently, and the booking LINK: copy, open, paste-it-where
// still lives on its own pages, which is where an established studio goes
// looking for it:
//   * /settings/booking      (BookingLinkCard, variant="card")
//   * /settings/availability (BookingLinkCard, inline)
//
// Not-ready state is deliberately unchanged: the same header, the same full
// checklist including the items already satisfied, and the same per-item links
// into the right settings tab.

type Props = {
  readiness: BookingReadiness;
};

export function BookingSetupCard({ readiness }: Props) {
  // Derived readiness is the ONLY authority. `status === "ready"` already means
  // "every REQUIRED item is satisfied"; informational items (public location)
  // are `required: false` by design and never hold a studio in setup.
  if (readiness.status === "ready") return null;

  return (
    <section
      aria-labelledby="booking-setup-heading"
      className="flex flex-col gap-5 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800"
    >
      <header className="flex flex-col gap-1">
        <h2 id="booking-setup-heading" className="text-lg font-medium">
          Set up your booking page
        </h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          A few things are still needed before your booking page can accept
          appointments.
        </p>
      </header>

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
