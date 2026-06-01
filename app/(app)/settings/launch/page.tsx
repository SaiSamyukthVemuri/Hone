import Link from "next/link";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import {
  getActiveServices,
  getAvailabilityDefaults,
} from "@/lib/booking/queries";

// Studio launch readiness checklist.
//
// Read-only. Surfaces what is configured before a real client uses
// Hone. The page does NOT enforce or block anything; booking,
// intake, postcare, and every other flow continue to work
// regardless of these statuses. The page reads existing fields only;
// no schema, no mutation, no client component, no auto-send, no
// feature toggle.
//
// Card-on-file is intentionally rendered as a fixed "Not enabled"
// row that is never "Ready". This avoids the misleading impression
// that payments are live; PR #93/#94 keep card collection off and
// require_card_on_file untouched.

const APP_ORIGIN =
  process.env.NEXT_PUBLIC_APP_ORIGIN ?? "https://hone.care";

type Status = "ready" | "needs_setup" | "optional" | "not_enabled" | "manual";

type Row = {
  title: string;
  status: Status;
  detail?: string;
  cta?: { label: string; href: string };
};

function nonEmpty(s: string | null | undefined): boolean {
  return typeof s === "string" && s.trim().length > 0;
}

export default async function LaunchChecklistPage() {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  const [services, availabilityDefaults] = await Promise.all([
    getActiveServices(studio.id),
    getAvailabilityDefaults(studio.id),
  ]);

  const hasConsultation = services.some(
    (s) => s.active && s.modality === "consultation",
  );
  const hasOpenDay = availabilityDefaults.some(
    (d) => d.is_open && nonEmpty(d.open_time) && nonEmpty(d.close_time),
  );
  const hasAftercare = nonEmpty(studio.postcare_aftercare_text);
  const hasBothPolicies =
    nonEmpty(studio.cancellation_policy_text) &&
    nonEmpty(studio.no_show_policy_text);
  const hasFeedToken = nonEmpty(practitioner.calendar_feed_token);
  const hasSlug = nonEmpty(studio.slug);
  const studioReady = nonEmpty(studio.name) && hasSlug;
  const bookingUrl = hasSlug
    ? `${APP_ORIGIN}/book/${studio.slug}`
    : null;

  const rows: Row[] = [
    {
      title: "Studio profile",
      status: studioReady ? "ready" : "needs_setup",
      detail: studioReady
        ? "Studio name and booking slug set."
        : "Set the studio name and booking slug.",
      cta: { label: "Open Studio settings", href: "/settings/studio" },
    },
    {
      title: "Public booking link",
      status: hasSlug ? "ready" : "needs_setup",
      detail: bookingUrl ?? "Set a booking slug to enable the public link.",
      cta: hasSlug
        ? { label: "Open booking settings", href: "/settings/booking" }
        : { label: "Open Studio settings", href: "/settings/studio" },
    },
    {
      title: "Consultation service",
      status: hasConsultation ? "ready" : "needs_setup",
      detail: hasConsultation
        ? "At least one active consultation service exists."
        : "Add an active service with modality 'consultation' (e.g. New Client Consultation).",
      cta: { label: "Open Services", href: "/settings/services" },
    },
    {
      title: "Availability",
      status: hasOpenDay ? "ready" : "needs_setup",
      detail: hasOpenDay
        ? "At least one weekday is open with hours set."
        : "Open at least one weekday in availability defaults.",
      cta: { label: "Open Availability", href: "/settings/availability" },
    },
    {
      title: "Client confirmation emails",
      status: studio.send_confirmation_emails ? "ready" : "needs_setup",
      detail: studio.send_confirmation_emails
        ? "Clients receive confirmation emails with the intake link."
        : "Turn on confirmation emails so clients receive the intake link after booking.",
      cta: { label: "Open Studio settings", href: "/settings/studio" },
    },
    {
      title: "Intake form",
      status: "ready",
      detail:
        "Preview available. The current intake form is shown to every new client booked through Hone.",
      cta: {
        label: "Open Intake & Postcare",
        href: "/settings/intake",
      },
    },
    {
      title: "Postcare email content",
      status: hasAftercare ? "ready" : "needs_setup",
      detail: hasAftercare
        ? "Aftercare text is set."
        : "Write aftercare text before sending postcare emails.",
      cta: {
        label: "Open Postcare editor",
        href: "/settings/intake#postcare",
      },
    },
    {
      title: "Cancellation and no-show policy",
      status: hasBothPolicies ? "ready" : "needs_setup",
      detail: hasBothPolicies
        ? "Both policies are set."
        : "Write a cancellation policy and a no-show policy before card-on-file is offered later.",
      cta: { label: "Open Policies", href: "/settings/intake" },
    },
    {
      title: "Calendar feed",
      status: hasFeedToken ? "ready" : "optional",
      detail: hasFeedToken
        ? "Calendar feed URL exists. Subscribe to it in Google Calendar or Apple Calendar."
        : "Optional one-way calendar subscription. Generate a URL in your profile when you want to subscribe.",
      cta: { label: "Open Profile", href: "/settings/profile" },
    },
    {
      title: "Card-on-file",
      status: "not_enabled",
      detail:
        "Not enabled. No cards are being collected. The Payments page shows readiness only; no card collection or charging is active.",
      cta: { label: "Open Payments", href: "/settings/payments" },
    },
    {
      title: "First test booking",
      status: "manual",
      detail:
        "Run one fake booking through your public link before sending your first real client. This step is not detected automatically.",
      cta: bookingUrl
        ? { label: "Open public booking page", href: bookingUrl }
        : undefined,
    },
  ];

  const readyCount = rows.filter((r) => r.status === "ready").length;
  const needsSetupCount = rows.filter((r) => r.status === "needs_setup").length;

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h2 className="text-xl font-medium">Launch checklist</h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Use this checklist before sending real clients through Hone. It
          does not block booking.
        </p>
        <p className="text-xs text-neutral-500">
          {readyCount} ready · {needsSetupCount} needs setup
        </p>
      </header>

      <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-700 dark:bg-amber-950/30">
        <p className="font-medium text-amber-900 dark:text-amber-100">
          Card-on-file is not enabled. Hone is not collecting or charging
          client cards.
        </p>
        <p className="mt-1 text-amber-900/80 dark:text-amber-100/80">
          Some items below are manual reminders. Use this as an onboarding
          checklist, not an automated review.
        </p>
      </div>

      <ul className="flex flex-col gap-3">
        {rows.map((row) => (
          <ChecklistRow key={row.title} row={row} />
        ))}
      </ul>
    </section>
  );
}

function ChecklistRow({ row }: { row: Row }) {
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <StatusPill status={row.status} />
        <div className="flex flex-col gap-1 min-w-0">
          <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
            {row.title}
          </p>
          {row.detail && (
            <p className="break-words text-xs text-neutral-600 dark:text-neutral-400">
              {row.detail}
            </p>
          )}
        </div>
      </div>
      {row.cta && (
        <Link
          href={row.cta.href}
          className="self-start whitespace-nowrap rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          {row.cta.label}
        </Link>
      )}
    </li>
  );
}

function StatusPill({ status }: { status: Status }) {
  const { label, cls } = (() => {
    switch (status) {
      case "ready":
        return {
          label: "Ready",
          cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
        };
      case "needs_setup":
        return {
          label: "Needs setup",
          cls: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100",
        };
      case "optional":
        return {
          label: "Optional",
          cls: "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
        };
      case "not_enabled":
        return {
          label: "Not enabled",
          cls: "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
        };
      case "manual":
        return {
          label: "Manual",
          cls: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200",
        };
    }
  })();
  return (
    <span
      className={`mt-0.5 inline-flex h-fit flex-none items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}
    >
      {label}
    </span>
  );
}
