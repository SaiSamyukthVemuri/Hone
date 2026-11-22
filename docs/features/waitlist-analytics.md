# Waitlist Analytics

Business → Analytics → Waitlist uses the existing Analytics title, tab bar,
colour tokens, cards and controls. It is read-only. The review link opens the
existing waitlist workflow; it never creates an invitation or sends a message.

## Metric definitions

- Invitation cohort: invitations issued in the last 30 rolling days. Re-invites
  count separately; provider message retries do not. Outcomes reflect current
  reads rather than a frozen historical snapshot.
- People invited: distinct waitlist entries in that cohort, from the existing
  owner-only booking-count command. While that command is unavailable, a bounded
  owner-session read counts entry references and returns only the aggregate.
  An incomplete read or a cohort-total mismatch leaves this figure unavailable;
  that mismatch check belongs to the fallback read. With the command present,
  People invited can show while Booked through invitation and the rate are
  withheld, because those need the outcome counts to reconcile with the command.
- Booked through invitation: an appointment explicitly linked by the canonical
  booking command. Includes bookings later cancelled; cancellation is also
  shown separately. Redemption alone is only **Link used**.
- Invitation-to-booking rate: linked bookings / issued invitations. Pending
  invitations remain in the denominator. This is not a mature-cohort rate or
  a forecast. A missing booking-count command, an empty cohort or counts that do
  not reconcile have no displayed rate. When some people used their link and were
  booked without a recorded link to the invitation, the rate still shows linked
  bookings only, and the card says how many more bookings are not counted, so it
  reads as a minimum.
- Delivery disposition: accepted by the provider, refused, uncertain, or not
  recorded. The four counts are read separately and are not checked to add up to
  the cohort total, so each is a reading, not a partition. Provider acceptance is not delivery, an email open or a page view.
- Active waitlist: current waiting, claimed and invited entries. Every entry is
  counted. Median and longest wait use only entries with a recorded join date
  (the booking form, or a date the studio supplied). An imported entry with no
  known join date holds its import time in `joined_at`, which is not a join date,
  so it adds no wait; the page says how many entries are excluded, and shows
  Not available when no entry has a known date.
  This population does not assert readiness, consent or availability matching.
- Capacity: the same conservative consultation estimator used by the waitlist
  composer, for the selected eligible consultation and next 7, 14 or 28 dates
  including today. Non-overlapping consultation opportunities minus live
  competing invitations gives the remaining allowance, never below zero.
  It treats a team as one calendar and may under-count. Without the window-count
  command it counts every live invitation, regardless of dates, and says so.

The capacity controls do not change the historical invitation cohort. No
practitioner filter is offered because an invitation's issuing operator does
not identify a treating practitioner. Studio identity comes from the signed-in
session; services are chosen only from the studio's active consultation list.

## Unknowns are not zeros

Email opens and invitation-page views are not recorded. Time-to-book is not
inferred from redemption time. Decline free text is neither copied into this
page nor interpreted as structured reasons. Total treatment-hours occupancy,
availability matching and the waitlist size needed to sustain full occupancy
are not inferred from consultation slots.

Linked booking counts use the existing `waitlist_invitation_booking_counts`
command when available. Its deployment dependency is unchanged. Until it is
available, issued/outcome figures still work and booking figures say **Not
available**. There is no migration in this feature.

Reads use the owner's invoker session and existing owner-RLS on waitlist
entries/invitations. No names, contact details, invitation secrets, personal
answers or clinical records are read for the new aggregate figures. The
existing capacity action still re-checks the owner and studio itself. A
truncated current pool or service list fails closed; failed counts remain
unknown. Reads can settle at slightly different times, so figures are readings,
not a transactionally frozen snapshot. The conversion rate is withheld if its
counts cannot reconcile.

## Release verification

Focused model tests cover known zero, missing attribution, inconsistent counts,
cancelled linked bookings, current wait ages and safe filter defaults. Loader
and route tests cover owner gates before reads, tenant scoping, missing or
truncated data and validated consultation selection. Rendered checks cover
tracking labels, conservative capacity and the shared theme. The existing
owner-practice-capacity browser spec covers owner/member navigation on desktop
and mobile. Production deployment and signed-in owner acceptance remain separate
from local verification.
