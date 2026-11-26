import type { ReactNode } from "react";
import { PendingLink } from "@/components/pending-link";
import { buttonClasses } from "@/components/ui/button";

// practitioner feedback (26 Nov), the dashboard visit card.
//
// ONE action row. Checkout / Mark completed (the `children` slot), Rebook, Chart, the next action (Open client,
// Review and the rest), Consultation notes and Review intake all sit in the same flex-wrap group, each only where it is
// available, and every one of them wears the SAME button look and size. At phone width the group wraps inside itself,
// so the actions stay together instead of scattering across the card. No primary button is larger than its neighbours.
//
// Every control is a link or the shared checkout entry, and the row sits OUTSIDE the row-body link, so nothing
// interactive is nested in an anchor.
//
// 44px on EVERY pointer, not only touch: the Consultation notes and Checkout controls were already 44px on a mouse, the
// UI-01B/UI-01D specs pin that floor, and one size for the whole row is what was asked. (`!` beats size sm's 32px on a
// precise pointer.)
export const VISIT_ACTION_CLASS = buttonClasses({ variant: "secondary", size: "sm", className: "pointer-fine:min-h-11!" });

export function VisitActionRow({
  checkout,
  rebookHref,
  chartHref,
  nextAction,
  consultation,
  intake,
}: {
  /** The owner's Checkout / Mark completed control (or its status badge). Null for a practitioner who cannot check out. */
  checkout: ReactNode;
  rebookHref: string;
  chartHref: string | null;
  /** The resolved next action, or null when it would only repeat the Chart button. */
  nextAction: { href: string; label: string } | null;
  consultation: { href: string; label: string };
  intake: { href: string; label: string } | null;
}) {
  return (
    <div data-testid="today-row-actions" className="order-1 ml-[5.75rem] flex min-w-0 basis-full flex-wrap items-center gap-2">
      {checkout}
      <PendingLink href={rebookHref} data-testid="today-rebook" pendingLabel="Opening calendar…" className={VISIT_ACTION_CLASS}>
        Rebook
      </PendingLink>
      {chartHref && (
        <PendingLink href={chartHref} data-testid="today-chart" prefetch={false} pendingLabel="Opening chart…" className={VISIT_ACTION_CLASS}>
          Chart
        </PendingLink>
      )}
      {nextAction && (
        <PendingLink href={nextAction.href} data-testid="today-next-action" pendingLabel="Opening…" className={VISIT_ACTION_CLASS}>
          {nextAction.label}
        </PendingLink>
      )}
      {/* Consultation notes in ONE TAP from the Dashboard. It NAVIGATES to the canonical practitioner writer
          (/clients/<id>?tab=treatment, client_clinical_notes) exactly as the appointment-side ConsultationNotesCard does.
          No modal, no drawer, no second textarea, no second note action, no second clinical-note loader. */}
      <PendingLink href={consultation.href} data-testid="today-consultation-notes" pendingLabel="Opening client…" className={VISIT_ACTION_CLASS}>
        {consultation.label}
      </PendingLink>
      {intake && (
        <PendingLink href={intake.href} data-testid="today-review-intake" pendingLabel="Opening intake…" className={VISIT_ACTION_CLASS}>
          {intake.label}
        </PendingLink>
      )}
    </div>
  );
}

/**
 * The private reminder written for the very next session. It always has its OWN BLUE box, apart from the yellow
 * pinned notes. Whether it exists at all (and so when it expires) is decided upstream by immediateVisitPlans.
 */
export function NextSessionReminder({ note }: { note: string }) {
  return (
    <section
      data-testid="dashboard-prep-remember"
      aria-label="From last visit, for today"
      title={note}
      className="mb-2 min-w-0 whitespace-pre-wrap break-words rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs dark:border-blue-900 dark:bg-blue-950/40"
    >
      <h3 className="text-[10px] font-semibold uppercase tracking-wider text-blue-800 dark:text-blue-300">From last visit, for today</h3>{" "}
      <p className="mt-0.5 whitespace-pre-wrap break-words leading-5 text-blue-950 dark:text-blue-100">{note}</p>
    </section>
  );
}
