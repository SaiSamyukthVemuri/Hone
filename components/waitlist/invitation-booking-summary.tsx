import {
  countText,
  NOT_AVAILABLE,
  periodLabel,
  type InvitationBookingSummary as Summary,
} from "@/lib/waitlist/invitation-booking-summary";

// The owner's summary of what became of the invitations sent in the last 30 days. Counts only: no name, contact detail or token is on this page.
// A server component with no state, no link to a person and no action. Every figure is a count of INVITATIONS sent in the one period stated at the top.
export function InvitationBookingSummary({ summary, timeZone }: { summary: Summary; timeZone: string }) {
  const sent = summary.invitationsSent;
  return (
    <section aria-labelledby="invitation-booking-summary-heading" className="flex flex-col gap-2 rounded-lg border border-line p-4" data-testid="invitation-booking-summary">
      <h3 id="invitation-booking-summary-heading" className="text-base font-medium">
        What happened to the invitations
      </h3>
      <p className="text-sm text-fg-muted" data-testid="invitation-booking-period">
        {periodLabel(summary.periodStartIso, timeZone)}. Every figure below counts those invitations, so each is out of the same number.
      </p>
      <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm">
        <dt>Invitations sent</dt>
        <dd className="text-right tabular-nums" data-testid="invitation-total">{countText(sent)}</dd>
        <dt>Different people invited</dt>
        <dd className="text-right tabular-nums" data-testid="invitation-people">{countText(summary.peopleInvited)}</dd>
      </dl>
      <p className="text-xs text-fg-muted">One person can have several invitations, so the number of invitations can be larger than the number of people.</p>
      {summary.bookingUnavailable ? (
        <p className="text-sm" data-testid="invitation-booking-unavailable">
          Booking figures: {NOT_AVAILABLE}. They need a database change that is not in place yet. Nothing is estimated in their place.
        </p>
      ) : null}
      <table className="w-full text-sm" data-testid="invitation-booking-table">
        <caption className="sr-only">Outcomes of the invitations sent in the period, each out of {sent === null ? NOT_AVAILABLE : `${sent} invitations`}</caption>
        <thead>
          <tr className="border-b border-line text-left text-fg-muted">
            <th scope="col" className="py-1 pr-3 font-medium">Outcome</th>
            <th scope="col" className="py-1 text-right font-medium">{sent === null ? "Count" : `Invitations (of ${sent})`}</th>
          </tr>
        </thead>
        <tbody>
          {summary.rows.map((r) => (
            <tr key={r.key} data-row={r.key} className="align-top">
              <th scope="row" className={r.nested ? "py-1 pl-5 pr-3 text-left font-normal" : "py-1 pr-3 text-left font-normal"}>
                {r.label}
                {r.note ? <span className="block text-xs text-fg-muted">{r.note}</span> : null}
              </th>
              <td className="py-1 text-right tabular-nums" data-value={r.fixedText ?? (r.value === null ? "unavailable" : String(r.value))}>
                {r.fixedText ?? countText(r.value)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {summary.inconsistent ? (
        <p className="text-xs text-fg-muted" data-testid="invitation-booking-moved">
          A count changed while this page loaded, so some figures do not add up. Reload the page for a consistent view.
        </p>
      ) : null}
    </section>
  );
}
