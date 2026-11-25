# Test a paid Hone signup

Use an isolated Hone app and database with the draft signup branch and apply migration 0387 (signup) followed by 0388 (team seats). Keep the production rollout flag off. The sandbox billing account is Hone Care inc sandbox. Stripe’s invoice previews returned USD 49.00 for Solo and USD 99.00 for Studio at quantity one, with automatic tax off. These previews did not collect payment. The owner portal configuration supports invoices and payment-method updates.

| Sandbox setting | Value to use |
| --- | --- |
| `HONE_STRIPE_PRICE_SOLO` | The existing Solo recurring USD 49.00 price ID |
| `HONE_STRIPE_PRICE_STUDIO` | The existing Studio recurring USD 99.00 price ID |
| `HONE_BILLING_ACCOUNT_ID` | The US billing sandbox account ID |
| `HONE_BILLING_PORTAL_CONFIGURATION` | The sandbox configuration for invoice history and payment method updates |


Install the billing sandbox API key as `HONE_BILLING_STRIPE_SECRET_KEY` in the test app's runtime secret store. Set `NEXT_PUBLIC_APP_ORIGIN` to the test app’s HTTPS origin and allow its auth callback on the matching test Supabase project. Register the app's HTTPS `/api/billing/webhook` as an event destination for this **platform account** for `invoice.paid` and `invoice.payment_failed`. Install its signing secret as `HONE_BILLING_WEBHOOK_SECRET`. For a local forwarded endpoint use the signing secret printed by the listener. Set `HONE_SELF_SERVE_CHECKOUT_ENABLED=true` only on the isolated app. Studio treatment payments use a separate integration.

1. Open Pricing and choose Solo or Studio. Verify the synthetic owner's email using the test inbox. Enter the owner name, studio name, and plan. Checkout shows the monthly price, with automatic tax off for this exercise.
2. Pay with a Stripe test card. Opening the return URL alone grants nothing. After the paid invoice is verified, open the dashboard. Re-deliver the same invoice event and verify there is exactly one active owner membership and one studio. Repeat on the other plan with another test identity.
3. In the owner billing portal, view the invoice and change the test payment method. For a failed renewal verify that the first failure starts 168 hours of normal access. Subsequent failures on that invoice preserve the original deadline. At the deadline new appointments and chart entries pause. Confirm the owner can read records and reach billing. Pay the invoice and check that the same studio can book and chart again. If using a Stripe test clock, advance the app/database test clock consistently for the deadline check.
4. Run the database regression with `npm run test:db -- tests/db/paid-studio-signup.db.test.ts`. It signs local event fixtures, exercises concurrent delivery and uses real PostgreSQL transactions. Stripe reads in this test are simulated.

5. Open Settings → Team as the paid owner. Solo starts at 1/1 practitioner seats with no receptionist. Studio starts at 1/3 practitioners with a separate 0/1 receptionist seat. Enable the existing desk rollout in the isolated test app to exercise receptionist invitations. Invite two practitioners and one receptionist. Pending invitations reserve seats, including an invitation for another owner. Accept an invitation, revoke another and refill it. Attempt two simultaneous invitations for the last seat and verify only one invitation is stored.
6. Run `npm run test:db -- tests/db/subscription-team-seats.db.test.ts` for the checked limits, reactivation, concurrency and plan transitions. An over-capacity downgrade must be resolved by the owner before changing the stored plan. A customer-facing Stripe upgrade/downgrade flow is separate. Full receptionist desk onboarding and team management are being integrated in #1779.

Keep the production activation conditions in HON-70. Existing pilot agreements and treatment charges have separate ownership. For a sandbox rollback, undo 0388 before 0387. The signup rollback refuses to delete active or pending purchase history.
