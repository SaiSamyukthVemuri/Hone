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
