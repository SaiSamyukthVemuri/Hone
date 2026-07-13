# Compact payment card — pre-implementation audit

Component: `components/session-payment-prepare-card.tsx` (1343 lines, client component).
Render site: `app/(app)/clients/[id]/sessions/[sessionId]/page.tsx:519` (server component
that already holds `practitioner.role` + `studio` from `getCurrentPractitionerWithStudio`).
Data contract: `lib/billing/session-payment-types.ts` (`SessionPaymentEligibility`,
`SessionPaymentExistingAttemptSummary`). Server actions:
`app/(app)/clients/[id]/sessions/[sessionId]/payment-actions.ts`.

## Every current payment state (status-driven, persisted row is source of truth)
- **Not charged / no active attempt** → `PrepareForm` (or `BlockedPanel` when not eligible).
- **ready** → `ReadyPanel` (Run charge).
- **pending_stripe** → `PendingPanel` (processing).
- **succeeded** → `SucceededPanel` + `ReceiptSubPanel` + `RefundSubPanel`.
- **failed** → `FailedPanel`.
- **cancelled** → `CancelledPanel`.
- **blocked** → `BlockedAttemptPanel`.
- Receipt sub-states: `receiptStatus` = sent / sending / failed.
- Refund sub-states: `refundStatus` = succeeded / pending_stripe / failed. (v1 = full-refund only;
  `refundAmountCents` exists so partial refunds need no type change — but the backend is full-only,
  so we do NOT ship a partial-refunded state.)

## Technical fields shown by DEFAULT today (to relocate)
- PaymentIntent id — ReadyPanel (post-run local state), PendingPanel, SucceededPanel, FailedPanel.
- Charge id — SucceededPanel. Refund id — SucceededPanel, RefundSubPanel.
- Raw failure code — FailedPanel, RefundSubPanel.
- Full receipt email (in `<code>`) — ReceiptSubPanel.
- "studio's Stripe connected account" developer wording — Ready/Pending/Succeeded/Refund panels.

## Fields Chloe actually needs
Paid? amount? when? receipt sent (masked)? and the actions: Charge / Retry / Resend receipt /
Refund (owner). Nothing processor-level.

## Fields support/admin may still need
All Stripe identifiers, raw codes, full email, mode — kept in the DB, audit records, server logs,
and the existing admin surfaces (`app/admin/payments`, `lib/payments/admin-payment-status.ts`).
In this component they move behind an owner-only, collapsed **Technical payment details** disclosure.

## Actions that must remain visible (wiring unchanged)
Prepare, Charge (`executeAction`), Resend/Retry receipt (`sendReceiptAction`), Refund
(`refundAction`) — all still call the same server actions with the same `attempt_id` + explicit
confirmation + pending-disable. Refund is **already server-side owner-only**
(`payment-actions.ts`: "Only the studio owner can issue a refund" → `not_authorized`); we ALSO hide
the button for non-owners (presentation only — server authorization unchanged).

## Details that can be hidden safely
Every identifier above — none is required to answer paid/amount/receipt/next-action. Kept in
storage; surfaced only to owners via the disclosure; full email replaced with a masked address.

## Owner role availability
Not currently a prop. The render site is a server component with `practitioner.role`, so a
**trusted server-derived `isOwner`** can be passed. Because it's safely available, we add the
owner-only `TechnicalPaymentDetails` (rendered only when `isOwner`, not CSS-hidden).

## Existing test coverage + gaps
Existing: `tests/**` payment-status-presenter, eligibility, action-contract tests. Gaps (added
here): compact-state presentation, email masking, human failure text, owner vs non-owner
disclosure, technical-IDs-hidden-by-default, receipt privacy.

## Plan (presentation-only)
1. Pure `lib/payments/payment-summary-presenter.ts`: `maskReceiptEmail`, `humanChargeFailure`,
   `paymentSummaryHeadline` — unit-tested, no server-only, no queries.
2. New presentational components: `components/payment/payment-summary-card.tsx`,
   `components/payment/receipt-status.tsx`, `components/payment/technical-payment-details.tsx`.
3. Thread server-derived `isOwner` page → card → panels.
4. In each panel: keep the action wiring **unchanged**; replace default-visible raw-ID `<p>` rows
   with the owner-only `TechnicalPaymentDetails`; mask the receipt email; use human failure text.
5. No schema change, no server-action change, no Stripe-call change. Stripe gates stay 35 PASS.
