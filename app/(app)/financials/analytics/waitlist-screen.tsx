import { WAITLIST_PATH } from "@/lib/waitlist/paths";
import type { ReactNode } from "react";

import { PendingButton } from "@/components/pending-button";
import { PendingGetForm } from "@/components/pending-get-form";
import { PendingLink } from "@/components/pending-link";
import { CONTROL_MIN_TOUCH, FOCUS_RING, cx } from "@/components/ui/control-base";
import type { WaitlistRead } from "@/lib/business-analytics/server/waitlist-read";
import { WAITLIST_HORIZONS } from "@/lib/business-analytics/waitlist-model";
import { countText } from "@/lib/waitlist/invitation-booking-summary";
import type { WindowCapacityResult } from "@/app/(app)/settings/waitlist/window-capacity-actions";
import { BUTTON, PageTitle, Tabs } from "./overview-screen";

const BIG = "text-3xl font-semibold tabular-nums tracking-tight text-fg";
const INPUT = cx("rounded-lg border border-line bg-surface px-2 text-fg", CONTROL_MIN_TOUCH, FOCUS_RING);
const waitText = (pool: { total: number; agedCount: number } | null, days: number | null | undefined) =>
  !pool ? "Not available" : pool.total === 0 ? "No one waiting" : pool.agedCount === 0 || days == null ? "Not available" : daysText(days);
const daysText = (days: number) => `${Math.round(days * 10) / 10} ${Math.round(days * 10) / 10 === 1 ? "day" : "days"}`;

function Panel({ title, children, note }: { title: string; children: ReactNode; note?: string }) {
  return <section className="space-y-3 rounded-xl border border-line bg-surface p-4"><h2 className="text-xl font-semibold tracking-tight text-fg">{title}</h2>{children}{note ? <p className="text-xs text-fg-muted">{note}</p> : null}</section>;
}
function Metric({ title, value, note }: { title: string; value: string; note?: string }) {
  return <section className="space-y-2 rounded-xl border border-line bg-surface p-4"><h3 className="text-sm font-medium text-fg-muted">{title}</h3><p className={/^\d/.test(value) ? BIG : "text-sm text-fg"}>{value}</p>{note ? <p className="text-xs text-fg-muted">{note}</p> : null}</section>;
}
function Row({ label, value, nested = false }: { label: string; value: string; nested?: boolean }) {
  return <div className="flex items-start justify-between gap-4 border-b border-line py-2 text-sm last:border-b-0"><dt className={cx("text-fg-muted", nested && "pl-4")}>{label}</dt><dd className="text-right font-medium tabular-nums text-fg">{value}</dd></div>;
}

export function WaitlistScreen({ read, capacity }: { read: Extract<WaitlistRead, { access: "granted" }>; capacity: WindowCapacityResult | null }) {
  const { view, params, services } = read;
  const { summary, pool } = view;
  const row = (key: string) => summary.rows.find((r) => r.key === key)?.value ?? null;
  const available = capacity?.ok === true ? capacity : null;
  const service = services.find((s) => s.id === params.serviceId);
  const nextMove = !available ? "Review your waitlist and availability." : available.open > 0 ? `Capacity for up to ${available.open} more ${available.open === 1 ? "invitation" : "invitations"}.` : "Review the invitations already outstanding.";
  return <div className="space-y-8">
    <header className="space-y-5">
      <PageTitle />
      <div className="border-b border-line pb-5"><Tabs current="Waitlist" /></div>
      <div className="space-y-1"><h2 className="text-xl font-semibold tracking-tight text-fg">Waitlist</h2><p className="text-sm text-fg-muted">Invitations, waiting time and the consultation capacity you can offer next.</p><p className="text-xs text-fg-muted">Studio-wide figures. Invitations are not assigned to a treating practitioner.</p></div>
      {params.notices.length > 0 ? <ul className="space-y-1 text-sm text-fg" role="status">{params.notices.map((notice) => <li key={notice}>{notice}</li>)}</ul> : null}
    </header>

    <section aria-labelledby="wl-next" className="space-y-3 rounded-xl border border-line bg-surface-sunken p-4">
      <p className="text-sm font-medium text-fg-muted">Your next move</p><h2 id="wl-next" className="text-2xl font-semibold tracking-tight text-fg">{nextMove}</h2>
      <p className="text-sm text-fg-muted">{available ? `${available.fit} non-overlapping consultation appointments fit the selected dates; ${available.outstanding} outstanding invitations are counted against them. Check each person’s service and availability before inviting.` : "Capacity could not be estimated for the current selection. No invitation count is suggested."}</p>
      <PendingLink href={WAITLIST_PATH} className={BUTTON}>Review waitlist</PendingLink>
    </section>

    <section aria-labelledby="wl-cohort" className="space-y-3">
      <div className="space-y-1"><h2 id="wl-cohort" className="text-xl font-semibold tracking-tight text-fg">From invitation to booking</h2><p className="text-sm text-fg-muted">Invitations issued in the last 30 days (since {new Intl.DateTimeFormat("en-US", { timeZone: view.timezone, dateStyle: "medium" }).format(new Date(view.periodStartIso))}, up to now). Outcomes reflect the latest read.</p></div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric title="Invitations issued" value={countText(summary.invitationsSent)} note="Counts invitation records, not delivery receipts or message retries." />
        <Metric title="People invited" value={countText(summary.peopleInvited)} note="Distinct waitlist entries in this invitation cohort." />
        <Metric title="Booked through invitation" value={countText(view.booked)} note="Linked bookings, including those later cancelled. A used link alone is not a booking." />
        <Metric title="Invitation-to-booking rate" value={view.conversion ? `${Math.round(view.conversion.percent * 10) / 10}%` : "Not available"} note={view.conversion ? `${view.conversion.booked} linked bookings ÷ ${view.conversion.invitations} issued invitations. Pending invitations remain in the denominator.${(row("attribution-unavailable") ?? 0) > 0 ? ` ${row("attribution-unavailable")} more ${row("attribution-unavailable") === 1 ? "booking was" : "bookings were"} made without a link to an invitation and ${row("attribution-unavailable") === 1 ? "is" : "are"} not counted, so this is a minimum.` : ""}` : summary.bookingUnavailable ? "Booking attribution is not available yet. Link use is shown separately below." : "A rate needs a non-empty, fully reconciled invitation cohort."} />
      </div>
      {summary.inconsistent ? <p className="text-sm text-fg" role="status">Invitation counts changed while this page loaded. No conversion rate is shown. Refresh to read them again.</p> : null}
      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title="Invitation outcomes" note="The indented rows break down Link used; do not add them to it. Each invitation has one top-level outcome. Expired includes deadlines that passed before expiry was recorded.">
          <dl><Row label="Link used" value={countText(row("link-used"))} /><Row nested label="Still booked" value={countText(row("booked"))} /><Row nested label="Booked, then cancelled" value={countText(row("booked-cancelled"))} /><Row nested label="Booking attribution unavailable" value={countText(row("attribution-unavailable"))} /><Row nested label="Link used, no attributed booking" value={countText(row("link-used-other"))} /><Row label="Declined" value={countText(row("declined"))} /><Row label="Expired" value={countText(row("expired"))} /><Row label="Released — reason not recorded" value={countText(row("released"))} /><Row label="Still open" value={countText(row("open"))} /><Row label="Other or not attributable" value={countText(row("other"))} /></dl>
        </Panel>
        <Panel title="Delivery and engagement" note="Accepted for delivery means the provider accepted the message request. It does not prove delivery or that the person read it.">
          <dl><Row label="Accepted for delivery" value={countText(view.delivery.accepted)} /><Row label="Delivery refused" value={countText(view.delivery.refused)} /><Row label="Delivery outcome unknown" value={countText(view.delivery.unknown)} /><Row label="Delivery not recorded" value={countText(view.delivery.unrecorded)} /><Row label="Invitation-page views" value="Not tracked" /><Row label="Email opens" value="Not tracked" /><Row label="Median time to booking" value="Not available" /></dl>
          <p className="text-sm text-fg-muted">Link use is an invitation redemption, not a page view. Opening an email is not treated as accepting an invitation.</p>
        </Panel>
      </div>
    </section>

    <section aria-labelledby="wl-planning" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-4"><div className="space-y-1"><h2 id="wl-planning" className="text-xl font-semibold tracking-tight text-fg">Capacity to offer next</h2><p className="text-sm text-fg-muted">These controls change the capacity estimate only, not the 30-day invitation cohort.</p></div>
        <PendingGetForm action="/financials/analytics/waitlist" className="flex flex-wrap items-end gap-2" aria-label="Consultation capacity">
          <label className="flex flex-col gap-1 text-xs text-fg-muted">Consultation service<select name="service" defaultValue={params.serviceId ?? ""} className={INPUT} disabled={services.length === 0}><option value="" disabled>Choose a consultation</option>{services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <label className="flex flex-col gap-1 text-xs text-fg-muted">Look ahead<select name="days" defaultValue={params.days} className={INPUT}>{WAITLIST_HORIZONS.map((days) => <option key={days} value={days}>Next {days} days</option>)}</select></label>
          <PendingButton variant="secondary" disabled={services.length === 0} busyLabel="Showing…">Show capacity</PendingButton>
        </PendingGetForm>
      </div>
      <div className="grid gap-3 sm:grid-cols-3"><Metric title="Consultations that fit" value={available ? String(available.fit) : "Not available"} note={service ? `${service.name} · next ${params.days} days, including today.` : read.servicesAvailable ? "No eligible consultation selected." : "The consultation service list could not be read."} /><Metric title="Outstanding invitations" value={available ? String(available.outstanding) : "Not available"} note={available?.outstandingScope === "all" ? "Conservative fallback: every live invitation, whatever its dates." : "Live invitations competing for these dates, across services."} /><Metric title="Remaining invitation allowance" value={available ? String(available.open) : "Not available"} note="Consultations that fit minus outstanding invitations, never below zero." /></div>
      <p className="text-xs text-fg-muted">These are minimums. The estimator treats the studio as one calendar and may under-count a team’s capacity. Overlapping start times are not added together. Invitations do not reserve appointments; availability and the allowance are checked again when you invite.</p>
    </section>

    <div className="grid gap-3 lg:grid-cols-2">
      <Panel title="People currently waiting" note="Current waiting, claimed and invited entries, not everyone who has ever joined. Waiting time runs from the recorded join date and includes people still waiting.">
        <div className="grid gap-3 sm:grid-cols-3"><div><p className="text-sm text-fg-muted">Active waitlist</p><p className={BIG}>{pool ? pool.total : "Not available"}</p></div><div><p className="text-sm text-fg-muted">Median wait</p><p className="text-xl font-semibold text-fg">{waitText(pool, pool?.medianDays)}</p></div><div><p className="text-sm text-fg-muted">Longest wait</p><p className="text-xl font-semibold text-fg">{waitText(pool, pool?.longestDays)}</p></div></div>
        {pool && pool.total > pool.agedCount ? <p className="text-sm text-fg" role="status">{pool.total - pool.agedCount} {pool.total - pool.agedCount === 1 ? "entry has" : "entries have"} no recorded join date and {pool.total - pool.agedCount === 1 ? "is" : "are"} excluded from the wait figures. They are still counted below.</p> : null}<dl><Row label="Waiting" value={pool ? String(pool.waiting) : "Not available"} /><Row label="Claimed for invitation" value={pool ? String(pool.claimed) : "Not available"} /><Row label="Invited" value={pool ? String(pool.invited) : "Not available"} /></dl><p className="text-sm text-fg-muted">Waiting does not mean ready to invite. Matching service, consent, contact details and times still need to be checked.</p>
      </Panel>
      <Panel title="Keeping the studio full">
        <p className="text-sm font-medium text-fg">Not enough data for a reliable forecast.</p><p className="text-sm text-fg-muted">Consultation openings do not measure all available treatment hours. A studio fill target and the waitlist size needed to sustain it also need service-duration matching, consultation-to-treatment conversion and repeat-visit history.</p>
        <dl><Row label="People needed to keep the studio full" value="Not available" /><Row label="Decline reasons" value="Not categorised" /><Row label="Booking failures / no matching times" value="Not tracked here" /></dl><p className="text-sm text-fg-muted">Declined invitations are counted above. Personal answers are left in the waitlist workflow and are not interpreted or copied into Analytics.</p>
      </Panel>
    </div>
    <details className="rounded-xl border border-line bg-surface p-4"><summary className={cx("cursor-pointer text-sm font-medium text-fg", FOCUS_RING)}>How these figures are counted</summary><div className="mt-4 space-y-3 text-sm text-fg-muted"><p>Invitation figures share one cohort: invitations issued since the stated date. Re-inviting someone creates another invitation; a message retry does not. People invited counts distinct waitlist entries. Booked counts only appointments explicitly linked to their invitation, including bookings later cancelled.</p><p>The conversion rate uses all issued invitations, including pending ones, and is not a mature-cohort forecast. Reads can finish at slightly different times; a cohort that cannot reconcile has no rate. Missing booking support or a failed read is shown as not available, never zero.</p><p>The capacity estimate uses the same consultation slot engine and competing-invitation count as the invitation workflow. It is information for your review, not permission to send and not a prediction that someone will book.</p></div></details>
    <footer className="flex flex-wrap items-start justify-between gap-2 border-t border-line pt-3 text-xs text-fg-muted"><span>{view.timezone} · Read at {new Intl.DateTimeFormat("en-US", { timeZone: view.timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(view.asOf))}</span><span>Only the studio owner is shown this page. Waitlist entries and invitations are restricted to the owner in the database; capacity uses the existing owner-gated estimator.</span></footer>
  </div>;
}
