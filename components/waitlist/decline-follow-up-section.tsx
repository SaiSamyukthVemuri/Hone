import type { FollowUpRow } from "@/lib/waitlist/decline-follow-up-adapter";
import { bellStatusLine, DECLINE_CARD_SAVED, emailStatusLine, type OutboxCounts } from "@/lib/waitlist/decline-status-lines";
import { NO_TIMES_WORK_LABELS } from "@/lib/waitlist/decline-responses";

// HON-7 (b). The owner's follow-up section: the target of the `#follow-up` anchor the email, the bell and the sign-in return all land on.
// OWNER-ONLY BY CONSTRUCTION: this component renders the recipient's answers, so it must only ever be rendered after the page's owner check
// (a test pins the call site's order). It takes its data as props and performs no reads itself.
//
// The actions (mark handled, book manually, booked elsewhere) are passed in as server-action forms so this stays presentational and testable;
// they are wired to the adapter when the 0325 contract lands.
export type FollowUpActionForm = (row: FollowUpRow) => React.ReactNode;

export function DeclineFollowUpSection({
  rows,
  emailEnabled,
  justSaved = false,
  actions,
}: {
  rows: FollowUpRow[];
  emailEnabled: boolean;
  /** True when the owner arrived straight from a response being saved. */
  justSaved?: boolean;
  actions?: { markHandled?: FollowUpActionForm; bookManually?: FollowUpActionForm; bookedElsewhere?: FollowUpActionForm };
}) {
  const open = rows.filter((r) => r.status === "open");
  return (
    <section
      id="follow-up"
      aria-labelledby="follow-up-heading"
      data-testid="decline-follow-up"
      className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-700 dark:bg-amber-950"
    >
      <h2 id="follow-up-heading" className="font-medium">
        Waitlist responses ({open.length})
      </h2>
      {justSaved ? <p className="mt-1" role="status">{DECLINE_CARD_SAVED}</p> : null}
      {rows.length === 0 ? <p className="mt-1">No responses need follow-up.</p> : null}
      <ul className="mt-2 flex flex-col gap-3">
        {rows.map((r) => (
          <li key={r.id} className="border-t border-amber-200 pt-2 first:border-t-0 first:pt-0" data-status={r.status}>
            <p className="font-medium">{r.name}</p>
            {r.kind === "no_longer_needed" ? (
              <p>{NO_TIMES_WORK_LABELS.noLongerNeed}.</p>
            ) : (
              <dl className="mt-1">
                <dt className="text-neutral-600 dark:text-neutral-400">{NO_TIMES_WORK_LABELS.why}</dt>
                <dd className="whitespace-pre-wrap">{r.why}</dd>
                <dt className="mt-1 text-neutral-600 dark:text-neutral-400">{NO_TIMES_WORK_LABELS.better}</dt>
                <dd className="whitespace-pre-wrap">{r.better}</dd>
              </dl>
            )}
            <p className="mt-1 text-neutral-600 dark:text-neutral-400">{bellStatusLine()}</p>
            <p className="text-neutral-600 dark:text-neutral-400">{emailStatusLine(emailEnabled, r.emailRows as OutboxCounts | null)}</p>
            {r.status === "open" ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {actions?.bookManually?.(r)}
                {actions?.bookedElsewhere?.(r)}
                {actions?.markHandled?.(r)}
              </div>
            ) : (
              <p className="mt-1 text-neutral-600 dark:text-neutral-400">{STATUS_COPY[r.status]}</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

const STATUS_COPY: Record<Exclude<FollowUpRow["status"], "open">, string> = {
  handled: "Handled.",
  booked_manually: "Booked from the follow-up.",
  booked_elsewhere: "Booked elsewhere.",
};
