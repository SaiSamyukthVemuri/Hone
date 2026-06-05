# Contributing to Hone

Hone is a production pilot SaaS. Every contribution touches a system that real clients and a real studio depend on. This guide is the floor for what every PR must do.

## Local setup

```bash
git clone https://github.com/SaiSamyukthVemuri/Hone.git
cd Hone
npm ci
cp .env.local.example .env.local         # fill in real values
npm run dev                                # http://localhost:3000
```

Required environment variables are documented in [docs/10_DEPLOYMENT_AND_ENV.md](./docs/10_DEPLOYMENT_AND_ENV.md). Missing variables fail loudly in production but tolerate sensible defaults in dev.

## Branching

- Branch off the default branch `claude/build-hone-saas-hOex7`.
- Use a short, descriptive branch name: `claude/cancellation-reason-insight`, `claude/manual-fee-test-charge`, etc.
- One PR per feature. Resist mixing schema changes, security changes, and product changes in one PR.

## Required commands before opening a PR

```bash
npm run typecheck
npm run lint
npm run build
npm test
git diff --check
npm run check:stripe-gates
npm run pilot:check
```

Or run them together as one command:

```bash
npm run ci
```

All seven must pass.

The `pilot:check` step (PR #160) validates the pilot control sheet YAML + the generated CSVs under `pilot-control/generated/`. When you change any tracker YAML, run `npm run pilot:export` and commit the regenerated CSVs alongside the YAML edits. CI fails when they drift. The Vercel preview deploy on the PR must reach `READY`.

GitHub Actions runs the same set automatically on every PR and every push to `claude/build-hone-saas-hOex7` (see `.github/workflows/ci.yml`, added in PR #154). A failing CI check blocks merge; do not merge a PR with a red workflow even if the local run passed.

CI does NOT replace the manual smoke catalogue in [docs/12_SMOKE_TESTS.md](./docs/12_SMOKE_TESTS.md). Browser flows (Stripe Elements, portal sign-in, public booking), real Resend / Twilio sends, real Stripe test charges, and live webhook delivery cannot be exercised in CI; they live in manual smoke.

## PR template

`.github/pull_request_template.md` (PR #147) is the required body for every new PR. Do not delete sections. Fill them honestly. The template captures:

- Type of change and risk level.
- Documentation update (or an explicit "no docs update needed" with a reason).
- Security checklist.
- Payment checklist (when applicable).
- Stripe grep gates.
- Validation status.
- Smoke tests run, and what could not be verified.
- Deployment notes.

## Documentation discipline

**A PR is not complete if it changes behavior but leaves docs stale.**

The mapping between behavior change and required doc update lives in [docs/15_DOCS_MAINTENANCE.md](./docs/15_DOCS_MAINTENANCE.md). Quick reference:

| Change | Update at minimum |
|---|---|
| Payment/Stripe | `docs/06`, `docs/12`, `docs/14` |
| Database/RLS migration | `docs/09`, `docs/14` |
| Public route or token route | `docs/03`, `docs/11`, `docs/12` |
| Env or config | `docs/10`, `README.md`, `.env.local.example` |
| Email/SMS/cron | `docs/08`, `docs/11`, `docs/12` |
| Product workflow | `docs/00` plus the feature doc, `docs/12` |
| Legal copy or forms | `docs/05`, `docs/13` |

Reviewers should block a behavior-changing PR that leaves docs stale.

## Migration discipline

- Migration number is the next available `00NN_*.sql` under `supabase/migrations/`.
- Strictly additive. Idempotent. `drop constraint if exists` before `add constraint`.
- **Apply the migration to production via `supabase db push --linked` BEFORE merging the code that reads the new columns/tables.** A merged PR whose code references a column not yet in prod produces a 500.
- Update `docs/09_DATABASE_AND_RLS.md` migration table in the same PR.
- For mixed `UPDATE` + `ALTER CONSTRAINT` migrations, post the row count from the `UPDATE` before applying the constraint (so the operator can see what got backfilled).

## Security review expectations

- Server resolves `studio_id`, `client_id`, `appointment_id`, `practitioner_id` from the session or from token resolution. **Never trust those ids from the form.**
- RLS posture: studio-member SELECT only on every studio-scoped table unless explicitly justified.
- Service-role writes only from server actions or webhook routes. Never in a `"use client"` component.
- `SECURITY DEFINER` functions must explicitly set `search_path = pg_catalog, pg_temp`. Grants are `revoke from public, anon, authenticated; grant to service_role` unless deliberately wider.
- Public token routes get noindex/no-referrer headers via `next.config.ts`. No analytics in `app/portal/verify/[token]`, `app/cancel/[token]`, `app/reschedule/[token]`, `app/manage/[token]`, `app/intake/[token]`, `app/calendar-feed/[token]`.

## Payment review expectations

- Stripe grep gates (PR #147 template):
  - `charges.create`: must be zero.
  - `checkout.sessions`: must be zero unless explicit Checkout PR.
  - `refunds.create`: must be zero unless explicit refund PR.
  - `set_studio_require_card_on_file`: must be zero unless explicit card-required booking PR.
  - `STRIPE_ALLOW_LIVE_MODE=true`: must be zero unless explicit live-mode PR.
  - `paymentIntents.create`: **exactly one existing occurrence is allowed in `lib/billing/manual-fee-charge.ts`** (test-mode manual fee path, behind every protection listed in [docs/06](./docs/06_PAYMENTS_AND_STRIPE.md)). Any new occurrence elsewhere is high-risk and must be explicitly reviewed.
- No raw card / CVC / `client_secret` in any new code.
- No automatic, batch, background, or public-triggered charge.

## How to write a safe server action

- File header: `"use server"`.
- First line of the action body: resolve practitioner / studio / portal-session from the cookie. **Never read identity ids from `formData`.**
- Validate any ids and free-form text. Cap lengths. Reject unknown enum values up front.
- For payment paths, claim the row atomically via the matching RPC before any Stripe call.
- Surface generic errors to the user; log specifics server-side with the `logInternal(event, detail)` shape used elsewhere in the codebase (no PII, no secrets in the log line).
- `revalidatePath` the routes that need to re-render. Return a typed result the UI can branch on.

## How to use service role correctly

`createAdminClient()` from `@/lib/supabase/admin-server` is for:

- Webhook routes (Stripe, Twilio) where the caller is not an authenticated user.
- Server actions that need to read across RLS to enforce eligibility (e.g. the manual-fee eligibility helper reading `client_payment_methods`, `client_consent_signatures`, `appointment_policy_acknowledgements` in one pass after the page-level studio-membership check).
- RPC invocations where the function is `SECURITY DEFINER` with a service-role-only grant.

## How NOT to use service role

- Never in a `"use client"` component.
- Never in a route that any unauthenticated caller can reach without a token check.
- Never to bypass RLS as a convenience. If you find yourself reaching for the admin client because RLS is "in the way", revisit the RLS policy or the action's identity model.

## How to treat public / token routes

- The token is the credential. Anyone with the URL has the access it confers.
- Use the `claim_stripe_event` / `claim_manual_fee_charge_attempt` / `public_cancel_appointment_with_token` pattern: single-use claim with `FOR UPDATE` + conditional UPDATE inside an RPC.
- No analytics in the subtree. Add the new prefix to `next.config.ts headers()` for `X-Robots-Tag: noindex, nofollow` and `Referrer-Policy: no-referrer`.
- Collapse error states: never tell the visitor "this token is expired" vs "this token is unknown". Both surface the same generic "this link can't be used right now" message.

## What must be in every PR report

The PR body should answer:

1. Existing-state audit of the surface being changed.
2. Files changed and the reason for each.
3. New schema / RPC / grants (if any).
4. Migration applied to prod before merge (if any).
5. Server-action behavior summary.
6. Practitioner / client UI summary.
7. What was intentionally not changed.
8. Validation results table.
9. Stripe grep gate results.
10. Manual smoke that could not be run by the harness (so the reviewer knows what to run by hand).
11. The PR link.

Everything else is conversation. Land the substance in the PR body so a future reader does not need to re-derive it.
