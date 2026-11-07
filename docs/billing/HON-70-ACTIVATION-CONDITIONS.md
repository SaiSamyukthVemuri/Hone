# HON-70 self-serve signup: conditions before the flag is turned on anywhere real

Status: PROPOSED list from the Insurance and Privacy reviews of PR #1380. It approves nothing.
`HONE_SELF_SERVE_CHECKOUT_ENABLED` stays OFF (exactly the string `true` enables it) until every
item below is closed or explicitly accepted by Sam. Merging the draft with the flag off is a
separate decision from activation.

Where the flag is defined: `isSelfServeCheckoutEnabled` in `lib/subscriptions/plans.ts`.

## What turning the flag on does today
* `/signup` becomes a real page (otherwise a 404) and sends a verification email to ANY
  well-formed address, with `shouldCreateUser: true`. **This deliberately reverses the PR #189
  rule** that the login action creates an Auth user only for an invited address.
* `/pricing` shows plan links to `/signup?plan=<solo|studio>` and replaces the "no self-service
  checkout" sentence.
* Nothing grants studio access. There is no checkout action and no persistence yet.

## Signup abuse and email (Privacy RL-1..RL-5, Insurance U-1)
* RL-1: a signup limiter keyed by hashed IP AND hashed lower-cased address (SHA-256 before the key),
  generic message identical to `RATE_LIMIT_MESSAGE`. `lib/rate-limit/public.ts` belongs to its owner.
* RL-2: an explicit fail-open or fail-closed choice for this surface (the module defaults to
  fail-open). Recommended: fail-closed in production while the flag is on, with a health check that
  refuses to enable the flag without the limiter env. Sam's call; state it and test it.
* RL-3: Sam reads the Supabase Auth email quota and per-address cooldown. Signup shares the quota
  with existing customers' sign-in links, so a flood must not block a practitioner's login email.
* RL-4: decide on bot protection (Turnstile or hCaptcha).
* RL-5: counts-only monitoring (attempts, refusals by reason, sends); no address, IP or user id in
  any log or Sentry event.
* U-1: captcha OR a per-IP limiter, a hosted rate-limit and custom-SMTP read, and an alert on send
  failures.

## Auth rows and the invite-only boundary
* N-1: a retention rule for never-confirmed Auth rows (whether Supabase creates the row at request
  time is UNVERIFIED; a hosted check, Sam's). Say it in the privacy notice.
* N-2: `/signup` carries only the plan KEY in its query, never an email or user id.
* N-3: a test, in the auth owner's lane, that a brand-new user with no membership lands on
  `/no-access` after `/auth/callback`; the gate's invite-only copy needs its own wording pass.
* U-2: `enable_signup = true` is in the tracked config. If hosted matches, anyone can create an Auth
  user today. The no-studio-user surface census (`tests/db/no-studio-user-surface.db.test.ts` on its
  own branch) and a hosted catalog read (including storage) must be reviewed first.
* U-4 (known limit): the invite-only guard tests pin spellings. The real boundary is the database
  test; extend that, not the regex, when a studio-creating function is added.

## Environments
* U-7 and Privacy R-3: Terms section 8 ("no automated Hone subscription billing") is true only while
  the flag is off in EVERY deployed environment, previews included. Keep it unset on previews.
  Activation carries a Terms and privacy-notice update as a named item (Sam owns the wording).
* U-6: the chosen plan is re-chosen after verification (not carried in the link). `/pricing` is
  statically prerendered (deploy-time env) while `/signup` is dynamic; flipping the flag needs a redeploy.

## Webhook and payment (carried from the Insurance and Privacy reads)
* W-2 (Privacy): when the route is wired, log decision kind, refusal reason and event type only;
  never the signature, body, metadata or customer id.
* S-2: the privacy notice must cover sending the account email and internal user id to the Hone Care
  Inc (US) Stripe account before any real signup; use the verified email.
* S-3: entitlement binds on the Hone user id, never an email fallback.
* The exact-path public entry for `/api/billing/webhook` is in place (Codex P2 4500263864).
* G-1 (Privacy): test-mode key only until a separate live approval; the allow-list does not encode test mode.
* K-2 (Insurance): the owned-stack flag-on run is recorded as evidence before activation.

## Persistence milestone (migration, T3, its own reviews)
* Unique Stripe event id plus ONE atomic command (insert-or-skip, apply only when inserted); the stale
  compare inside that command (Insurance W-1).
* Atomic one-live-checkout-session claim per user, inserted before the Stripe call; define the owner
  of the double-paid case as a manual refund runbook (R-2). `hasOpenSubscription` counts every
  non-terminal status (R-3).
* `hone_user_id` validated against the real user table inside the command (R-4); the existing-state
  read is keyed by the authenticated user id only, and the stored Checkout url is service-role-only
  and ignored once expired (Privacy R-1).
* Store only `EntitlementWrite` fields; never the raw event, metadata or body (Privacy W-1).
* Retry-wrapper call sites map a still-deadlocked result through `userMessageForDeadlock` and return
  no raw error text (Privacy R-2).

## Other known limits
* U-5: the importer tripwire in the truthfulness test is file-level; it does not pin what each
  permitted file imports.
* C-2: the `new Stripe(` gate pin can be evaded by an aliased import (recorded in docs/13).
* Whether a checkout with a paid-but-refused second subscription needs an ops alert and refund path
  is undecided (`second_open_subscription`).

## Insurance conditions, verbatim (PEER-1380-1E5BC9A4)

* **U-1:** /signup is an unauthenticated, bulk email-sending path with no app-level limiter and no captcha, relying on Supabase's built-in OTP limits. Three consequences when the flag is ever on: (a) the project-wide email_sent limit is SHARED with every other auth email (login links for existing customers and invites), so an attacker iterating distinct addresses can exhaust it and block Sabrina's staff from signing in: an availability attack on production through a public form; (b) Hone-branded mail to arbitrary third-party addresses harms sender reputation; (c) auth.users rows accrue unbounded. The tracked config shows email_sent = 1000 and sign_in_sign_ups = 30 per rate-limit window locally; the HOSTED values are not in the repository and I did not read them (Sam-run). Before activation: a captcha (Supabase supports Turnstile/hCaptcha) or a per-IP limiter on this action, the hosted rate limits and custom SMTP verified, and an alert on send failures. Keep the flag off until then.

* **U-2:** The tracked supabase/config.toml has enable_signup = true, so GoTrue accepts new-user requests with the public anon key regardless of this PR if hosted matches. The invite-only guarantee therefore rests on the database (a no-op handle_new_user, no studio INSERT policy, RLS membership checks) and the no-studio middleware gate, not on closing signups. That is the right place for it, and this PR does not create the capability, but it makes it discoverable and email-emitting. The activation precondition is therefore a census of what any authenticated user with NO studio can reach: RPCs executable by authenticated that do not check membership, storage policies, and tables with non-membership policies. The existing DB test covers studios, practitioners and invitations inserts and cross-studio reads, not the function and storage surface. I suggest this be added to Machines' hosted catalog read (C-6) as an explicit 'no-studio user' probe, and to the DB test once create_self_serve_studio exists.

* **U-5:** The importer tripwire is file-level. It does not pin WHAT the permitted files import, so wiring checkout or webhook handling into app/api/billing/webhook/route.ts or the pricing page would not fail it. The new importers are clean today (plans and plan-selection only), and the 'no Stripe or billing code' test covers only the three signup files, not pricing. Pin the import list per importer, as I suggested for the route.

* **U-7:** Terms section 8 stays true only while the flag is off in EVERY deployed environment (Privacy R-3, already a condition). Preview deployments with the flag on would make /signup and the OTP path live there against the shared Supabase project; keep the flag unset on previews.

## Added by the 1B2D2D06 read
* G-2 (store PR): once a store exists, `/api/billing/webhook` (publicly reachable by exact path) must
  verify the signature with `HONE_BILLING_WEBHOOK_SECRET` BEFORE reading or acting on anything. A named
  condition of the persistence PR, not a comment.
* G-4 (activation): the flag-ON path is the one that creates Auth rows for any address and CI never
  runs it (its Playwright case self-skips). Run the flag-on Playwright case ONCE on an owned local
  stack, with the paired-target guard, before activation; and close the abuse limits above (RL-1..5,
  U-1) first.
* G-3 (low): the webhook route exports only POST, so an anonymous GET gets Next's 405 where other
  unauthenticated API paths are redirected; the route's existence is fingerprintable (same pattern as
  the Stripe webhook).
* G-5: a missing app-origin env now logs one bounded server line (a fixed code, no address).
