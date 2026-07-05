import Link from "next/link";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import {
  buildGettingStarted,
  getGettingStartedSignals,
  type ChecklistItem,
} from "@/lib/onboarding/getting-started";

// PR #215: Getting Started / onboarding checklist. A practical setup
// and readiness checklist for the current user (PR #216 removed the
// future-onboarding section; this page is about setting up and
// learning Hone, not scaling). Protected app route inside the (app) layout; a
// normal page, never a blocking modal. Mostly auto-detected status +
// static "Review" guidance; no manual mark-as-done persistence in V1
// (would need a migration; deliberately deferred). Pilot wording
// only: live payments stay off, record-keeping support is not a
// compliance guarantee.

const STATUS_STYLES: Record<ChecklistItem["status"], string> = {
  done: "bg-green-100 text-green-900 dark:bg-green-900/40 dark:text-green-200",
  todo: "border border-neutral-300 text-neutral-700 dark:border-neutral-700 dark:text-neutral-300",
  review:
    "bg-blue-100 text-blue-900 dark:bg-blue-900/40 dark:text-blue-200",
};
const STATUS_LABELS: Record<ChecklistItem["status"], string> = {
  done: "Done",
  todo: "To do",
  review: "Review",
};

function Item({ item }: { item: ChecklistItem }) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-2 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLES[item.status]}`}
          >
            {STATUS_LABELS[item.status]}
          </span>
          <span className="font-medium">{item.label}</span>
        </div>
        <p className="mt-0.5 text-xs text-neutral-500">{item.explanation}</p>
      </div>
      {item.href && (
        <Link
          href={item.href}
          className="text-xs font-medium text-neutral-700 hover:underline dark:text-neutral-300"
        >
          Open →
        </Link>
      )}
    </li>
  );
}

const FIRST_CONSULTATION = [
  "Client can book",
  "Intake reviewed",
  "Client profile opens on iPad",
  "Before today appears",
  "Treatment area can be charted",
  "Probe lot can be recorded",
  "Aftercare/risks can be marked",
  "Procedure record appears",
  "Record can be printed/exported",
  "Payments run in the studio\u2019s configured Stripe mode",
];

export default async function GettingStartedPage() {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  const signals = await getGettingStartedSignals(
    { id: studio.id, name: studio.name, slug: studio.slug },
    practitioner.display_name?.trim() || practitioner.email,
  );
  const checklist = buildGettingStarted(signals);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">
          Getting started
        </h1>
        <p className="mt-1 text-sm text-neutral-500">
          A setup and readiness checklist for {studio.name}.{" "}
          {checklist.autoDone} of {checklist.autoTotal} detectable steps
          complete. Items marked Review are guidance to walk through once.
        </p>
      </div>

      {checklist.sections.map((section) => (
        <section
          key={section.key}
          className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800"
        >
          <h2 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
            {section.title}
          </h2>
          <ul className="mt-2 flex flex-col divide-y divide-neutral-200 dark:divide-neutral-800">
            {section.items.map((item) => (
              <Item key={item.key} item={item} />
            ))}
          </ul>
        </section>
      ))}

      <section className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
        <h2 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
          Ready for first real consultation
        </h2>
        <p className="mt-1 text-xs text-neutral-500">
          Walk this list before your first real client in Hone.
        </p>
        <ul className="mt-2 list-disc pl-5 text-sm text-neutral-700 dark:text-neutral-300">
          {FIRST_CONSULTATION.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        {/* PR #216: caveat kept here (it relates to first real use);
            the future-onboarding section was removed. */}
        <p className="mt-2 text-xs text-neutral-500">
          Record-keeping support still needs public-health/legal review
          before relying on it operationally. Payment readiness is shown
          in Settings \u2192 Payments.
        </p>
      </section>

    </div>
  );
}
