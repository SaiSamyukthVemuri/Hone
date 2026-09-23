import Link from "next/link";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { getRequiredAppOrigin } from "@/lib/app-origin";
import { CONSENT_SETTINGS_HREF } from "@/lib/consent/launch-readiness";
import {
  getNewClientReadiness,
  type NewClientBlockerKey,
} from "@/lib/booking/new-client-readiness";
import {
  StatusPill,
  type StatusTone,
} from "@/components/ui/status-pill";

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
//
// Consent readiness (F-CONSENT-GAP) is derived, never assumed. A new
// studio starts with ZERO consent templates and nothing seeds one, so
// before this row the checklist could read "Done" throughout while the
// intake presented no consent at all. The rule lives in ONE place,
// lib/consent/launch-readiness.ts, shared with the getting-started
// checklist; this page must never re-derive it. A live template means
// the intake has a form to present — it is NOT a claim that the wording
// is lawyer-reviewed or legally enforceable.

type Status =
  | "ready"
  | "needs_setup"
  | "optional"
  | "not_enabled"
  | "manual"
  // A fact this page could not establish. Distinct from "needs_setup" on
  // purpose: telling an owner to create a consent form they already have
  // is a different lie from telling them they are ready. Excluded from
  // both counters below, because it is neither done nor to do.
  | "unknown";

type Row = {
  title: string;
  status: Status;
  detail?: string;
  cta?: { label: string; href: string };
  /**
   * Optional second action. Used by the Public booking link row so the
   * practitioner can open the live booking page in a new tab AND open
   * the booking settings, without picking only one.
   */
  secondaryCta?: { label: string; href: string; newTab?: boolean };
};

function nonEmpty(s: string | null | undefined): boolean {
  return typeof s === "string" && s.trim().length > 0;
}

export default async function LaunchChecklistPage() {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  // ONB-02: ask the predicate the BOOKING PATH enforces, not a second copy of
  // it. `s.modality === "consultation"` missed `isConsultationService`'s
  // name fallback, so a studio whose service is named "New Client
  // Consultation" with no modality set was told to set one up while
  // publicBookAppointmentAction was already taking its bookings.
  // ONB-02 P1: THE CANONICAL AUTHORITY ANSWERS FOR WHAT IT OWNS.
  //
  // This page used to re-derive new-client readiness itself. Two authorities for
  // one question is one too many, and the second one was already wrong: it knew
  // nothing about WAIT admission and accepted any non-empty timezone, so an
  // owner whose studio routes new clients to the waitlist -- or carries an
  // invalid zone -- was told they were ready to take bookings.
  //
  // `computeNewClientReadiness` owns studio name, booking link, booking
  // settings, consultation service, availability and treatment consent. The rows
  // below now READ its verdict rather than recomputing it. The page keeps only
  // the facts it genuinely owns: confirmation emails, intake, postcare, policies
  // and the calendar feed.
  const readiness = await getNewClientReadiness(studio);
  const provenBlockers = new Set<NewClientBlockerKey>(
    readiness.status === "not_ready" ? readiness.blockers.map((b) => b.key) : [],
  );
  const unavailableAuthorities = new Set(
    readiness.status === "ready" ? [] : readiness.unavailable,
  );

  /**
   * The authority's answer for one owned fact.
   *
   * UNKNOWN IS NOT NEEDS_SETUP. An authority that could not answer must not be
   * rendered as a missing setup step -- that is the collapse the readiness model
   * exists to prevent, and repeating it here would undo it at the last inch.
   */
  const owned = (
    key: NewClientBlockerKey,
    authority?: "services" | "availability" | "treatment_consent",
  ): Row["status"] => {
    if (authority && unavailableAuthorities.has(authority)) return "unknown";
    return provenBlockers.has(key) ? "needs_setup" : "ready";
  };

  const hasAftercare = nonEmpty(studio.postcare_aftercare_text);
  const hasBothPolicies =
    nonEmpty(studio.cancellation_policy_text) &&
    nonEmpty(studio.no_show_policy_text);
  // Migration 0116: feed existence is now derived from the hash (hash-only at rest).
  const hasFeedToken = nonEmpty(practitioner.calendar_feed_token_hash);
  // Kept only to BUILD the public URL. The row's status comes from the
  // authority, never from this.
  const hasSlug = nonEmpty(studio.slug);
  const bookingUrl = hasSlug
    ? `${getRequiredAppOrigin()}/book/${studio.slug}`
    : null;

  const rows: Row[] = [
    {
      title: "Studio profile",
      status: owned("studio_name"),
      detail: provenBlockers.has("studio_name")
        ? "Set the studio name and booking slug."
        : "Studio name and booking slug set.",
      cta: { label: "Open Studio settings", href: "/settings/studio" },
    },
    {
      title: "Public booking link",
      status: owned("booking_link"),
      detail: bookingUrl ?? "Set a booking slug to enable the public link.",
      cta: hasSlug && bookingUrl
        ? { label: "Open public booking page", href: bookingUrl }
        : { label: "Open Studio settings", href: "/settings/studio" },
      secondaryCta: hasSlug
        ? { label: "Open booking settings", href: "/settings/booking" }
        : undefined,
    },
    {
      title: "Consultation service",
      status: owned("consultation_service", "services"),
      detail: unavailableAuthorities.has("services")
        ? "Couldn't check your services just now. Open Services to confirm."
        : provenBlockers.has("consultation_service")
          ? "Add an active service a new client can book (e.g. New Client Consultation)."
          : "At least one active consultation service exists.",
      cta: { label: "Open Services", href: "/settings/services" },
    },
    {
      title: "Availability",
      status: owned("availability", "availability"),
      detail: unavailableAuthorities.has("availability")
        ? "Couldn't check your availability just now. Open Availability to confirm."
        : provenBlockers.has("availability")
          ? "Open at least one weekday for public booking in availability defaults."
          : "At least one weekday is open to public booking with hours set.",
      cta: { label: "Open Availability", href: "/settings/availability" },
    },
    // WAIT admission is a real boundary on "can a new client book right now",
    // and it is the one the page could not see before: a studio routing new
    // clients to the waitlist was told it was ready to take bookings.
    //
    // NOT "needs_setup" WHEN IT IS ON. A configured admission pause is a
    // deliberate operator state, not a missing step, so the row states the fact
    // and sends the owner to the waitlist surface rather than telling them to
    // go fix something.
    {
      title: "New client admission",
      status: provenBlockers.has("wait_admission") ? "manual" : "ready",
      detail: provenBlockers.has("wait_admission")
        ? "New clients join the waitlist instead of booking directly. Invited clients can still book."
        : "New clients can book directly from the public booking page.",
      cta: { label: "Open Waitlist settings", href: "/settings/waitlist" },
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
        label: "Open Forms & Policies",
        href: "/settings/intake",
      },
    },
    // Sits directly under the intake row because that is where the form is
    // presented: with no live treatment consent, the intake a client completes
    // asks for no consent at all.
    {
      title: "Treatment consent form",
      status: owned("treatment_consent", "treatment_consent"),
      detail: unavailableAuthorities.has("treatment_consent")
        ? "Couldn't check your consent forms just now. Open Consent forms to confirm."
        : provenBlockers.has("treatment_consent")
          ? "Create a treatment consent form and make it live. Until you do, the intake asks new clients for no consent."
          : "A treatment consent form is live in the client portal, so the intake presents it.",
      cta: { label: "Open Consent forms", href: CONSENT_SETTINGS_HREF },
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
      status: "manual",
      detail:
        "Clients save a card in the client portal after signing the card authorization; readiness and live/test status are shown on the Payments page. Booking-time card collection is off: clients can still book without entering a card.",
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
        <h2 className="text-xl font-medium">Ready for booking checklist</h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Walk this once before sending your first real client through
          Hone. Each item is a single plain-English requirement with a
          direct link. Booking still works regardless of these statuses.
        </p>
        <p className="text-xs text-neutral-500">
          <span className="font-medium text-emerald-700 dark:text-emerald-300">
            {readyCount} ready
          </span>
          {" · "}
          <span className="font-medium text-amber-800 dark:text-amber-200">
            {needsSetupCount} still to do
          </span>
        </p>
      </header>

      <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-700 dark:bg-amber-950/30">
        <p className="font-medium text-amber-900 dark:text-amber-100">
          Payment status is shown on the Payments page. Booking-time card
          collection is off; nothing on this checklist charges anyone.
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

// External booking-page links open in a new tab; in-app settings
// links stay in the current tab. We detect "external" by absolute URL
// prefix; any href that starts with http(s):// is treated as external.
function isExternalHref(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

function ChecklistRow({ row }: { row: Row }) {
  return (
    <li className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <StatusBox status={row.status} />
        <div className="flex flex-col gap-1 min-w-0">
          <p className="flex flex-wrap items-baseline gap-2 text-sm font-medium text-neutral-900 dark:text-neutral-100">
            <span>{row.title}</span>
            <ChecklistStatusPill status={row.status} />
          </p>
          {row.detail && (
            <p className="break-words text-xs text-neutral-600 dark:text-neutral-400">
              {row.detail}
            </p>
          )}
        </div>
      </div>
      {(row.cta || row.secondaryCta) && (
        <div className="flex flex-wrap items-center gap-2 self-start">
          {row.cta && (
            <Link
              href={row.cta.href}
              target={isExternalHref(row.cta.href) ? "_blank" : undefined}
              rel={isExternalHref(row.cta.href) ? "noreferrer" : undefined}
              className="whitespace-nowrap rounded-md border border-neutral-900 bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-800 dark:border-white dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
            >
              {row.cta.label}
              {isExternalHref(row.cta.href) ? " ↗" : ""}
            </Link>
          )}
          {row.secondaryCta && (
            <Link
              href={row.secondaryCta.href}
              target={
                row.secondaryCta.newTab || isExternalHref(row.secondaryCta.href)
                  ? "_blank"
                  : undefined
              }
              rel={
                row.secondaryCta.newTab || isExternalHref(row.secondaryCta.href)
                  ? "noreferrer"
                  : undefined
              }
              className="whitespace-nowrap rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              {row.secondaryCta.label}
            </Link>
          )}
        </div>
      )}
    </li>
  );
}

// Checkbox-like box that visually reads as "done / to do / N/A". The
// previous pill alone made the page feel like a status list; pairing
// the row with a square mark makes it skim like an actual checklist.
function StatusBox({ status }: { status: Status }) {
  const isDone = status === "ready";
  const isTodo = status === "needs_setup";
  return (
    <span
      aria-hidden
      className={`mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded border-2 text-xs font-bold ${
        isDone
          ? "border-emerald-600 bg-emerald-600 text-white dark:border-emerald-400 dark:bg-emerald-400 dark:text-neutral-900"
          : isTodo
            ? "border-amber-500 bg-amber-50 text-amber-700 dark:border-amber-400 dark:bg-amber-950 dark:text-amber-200"
            : "border-neutral-300 bg-white text-neutral-400 dark:border-neutral-700 dark:bg-neutral-950"
      }`}
    >
      {isDone ? "✓" : ""}
    </span>
  );
}

// UI0: the SHAPE moved to components/ui/status-pill.tsx; the MEANING stays
// here. Launch readiness is its own vocabulary ("To do" is not an appointment
// status and not a payment status), so this presenter keeps ownership of the
// label and only chooses how the result is painted. The rendered light-mode
// classes are unchanged; the inert dark:* halves are dropped with them.
function ChecklistStatusPill({ status }: { status: Status }) {
  const { label, tone } = ((): { label: string; tone: StatusTone } => {
    switch (status) {
      case "ready":
        return { label: "Done", tone: "success" };
      case "needs_setup":
        return { label: "To do", tone: "warning" };
      case "optional":
        return { label: "Optional", tone: "neutral" };
      case "not_enabled":
        return { label: "Not enabled", tone: "neutral" };
      case "manual":
        return { label: "Manual", tone: "info" };
      // Not "To do": this page could not establish the fact, and saying
      // "To do" would assert an absence it did not observe.
      case "unknown":
        return { label: "Check", tone: "warning" };
    }
  })();
  return <StatusPill tone={tone}>{label}</StatusPill>;
}
