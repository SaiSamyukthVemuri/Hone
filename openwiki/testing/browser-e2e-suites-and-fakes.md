---
type: test infrastructure
title: Browser E2E suites and provider fakes
description: Hone's four Playwright lanes (core, payment, Google, mobile) — local-only environment and its guards, per-worktree ports and the never-reuse-a-server rule, the shared schema preflight, seeding and real magic-link login, the four fail-closed fakes (Resend, Stripe, Google, route faults) and what stops each one activating in a deployment, time-of-day independence, and how changed paths select browser groups and shards in CI.
tags: [e2e, playwright, test-fakes, ci, browser-tests, testing]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-04T01:59:59.625Z
sources:
  - id: openwiki-source-164e2da859b5277df81c7d94
    resource: repo://.github/workflows/ci.yml
  - id: openwiki-source-fe71ae3a2f4e98a9f0018b92
    resource: repo://app/(app)/e2e-fault/%5Bcase%5D/page.tsx
  - id: openwiki-source-4734c23c4dba9e124cd41d11
    resource: repo://e2e-google/dedicated-destination.spec.ts
  - id: openwiki-source-a755aeb3c33b87827033663a
    resource: repo://e2e-google/existing-owned.spec.ts
  - id: openwiki-source-1328e71f62e0681a45f958f5
    resource: repo://e2e-google/security-and-pending.spec.ts
  - id: openwiki-source-a17b8dd2cc919ff5ebb781ef
    resource: repo://e2e-mobile/mobile-completion.spec.ts
  - id: openwiki-source-77097baab3b84a7b774226c8
    resource: repo://e2e/global-setup.ts
  - id: openwiki-source-705ca3e507078656f251cdba
    resource: repo://e2e/helpers/local-env.ts
  - id: openwiki-source-b83d5e72e66de6465474c9c0
    resource: repo://e2e/helpers/seed.ts
  - id: openwiki-source-790ce24a683e7ea4879b0bbd
    resource: repo://e2e/helpers/timezone.ts
  - id: openwiki-source-0c99578f8e5bb59cb894065b
    resource: repo://lib/email/client.ts
  - id: openwiki-source-3e7b32a3d061ff902b408f90
    resource: repo://lib/email/e2e-fake-resend.ts
  - id: openwiki-source-b90ea8d9b946a7ce3d1c214b
    resource: repo://lib/email/send-welcome.ts
  - id: openwiki-source-ed69249f11682ffeb149722b
    resource: repo://lib/google-calendar/e2e/fake-google-guard.ts
  - id: openwiki-source-de5eba7646538bcb1ae50014
    resource: repo://lib/google-calendar/e2e/fake-google-provider.ts
  - id: openwiki-source-e2a4b102f8c7c9f2e31c8a74
    resource: repo://lib/google-calendar/google-transport.ts
  - id: openwiki-source-d234ff3df4a5dc4edd3c5367
    resource: repo://lib/reliability/e2e-route-fault.ts
  - id: openwiki-source-3d478ff18a4ab0a51dfea734
    resource: repo://lib/stripe/e2e-fake-guard.ts
  - id: openwiki-source-3008bc446a0a791860e0cfb3
    resource: repo://lib/stripe/e2e-fake-stripe.ts
  - id: openwiki-source-1417bfc8f19c4ae00cc2cbfe
    resource: repo://lib/stripe/session-payment-stripe.ts
  - id: openwiki-source-5e753d9d77984cb67aae1517
    resource: repo://playwright.config.ts
  - id: openwiki-source-2a65f6b52f36e74ae561cccc
    resource: repo://playwright.google.config.ts
  - id: openwiki-source-80b153b6c40fcde46b699b5a
    resource: repo://playwright.mobile.config.ts
  - id: openwiki-source-6480634db094b4fd9dc7e537
    resource: repo://scripts/browser-groups.mjs
  - id: openwiki-source-5c53134045a42bee584295af
    resource: repo://scripts/worktree-resources.mjs
  - id: openwiki-source-f6a9df45d3a108b6059bb641
    resource: repo://tests/ci/browser-selection.test.ts
  - id: openwiki-source-b7bb275e4f3f54cc1c69ac77
    resource: repo://tests/ci/browser-shard-coverage.test.ts
  - id: openwiki-source-4fe03fb1a3e9643fb9d19b50
    resource: repo://tests/scripts/e2e-guardrails.test.ts
  - id: openwiki-source-20464c06d457fefcf59afbc0
    resource: repo://tests/scripts/e2e-time-independence.test.ts
generated: { by: "claude-code", at: "2026-10-04T01:59:59.625Z" }
---

# Browser E2E suites and provider fakes

All browser lanes run against a **local** Next production build and the **local** Supabase stack. Nothing in
them can reach a hosted project, send real mail or SMS, or move money.

## 1. The four lanes

| Config | Specs | Server | Notes |
|---|---|---|---|
| `playwright.config.ts` | `e2e/*.spec.ts` | `npm run e2e:server` | one Chromium project, one worker, not fully parallel; one retry in CI ([L17-L58](../../playwright.config.ts#L17-L58)) |
| `playwright.payment.config.ts` | `e2e-payment/` | `e2e:payment-server` with the fake-Stripe markers | — |
| `playwright.google.config.ts` | `e2e-google/` | `e2e:google-server` with the fake-Google markers | — |
| `playwright.mobile.config.ts` | `e2e-mobile/` | reuses the payment server environment | runs **Chromium** at iPhone 13 dimensions plus a Pixel 5 control |

The mobile lane uses Chromium rather than WebKit because a real WebKit context over the plain-http localhost
harness upgrades subresources to https and drops Secure cookies. A WebKit lane would need an HTTPS harness
([`playwright.mobile.config.ts` L14-L35](../../playwright.mobile.config.ts#L14-L35)).

### What the dedicated lanes prove

The payment and Google lanes mirror each other. Each has:

- its own `testDir`, which the ordinary `./e2e` config never matches, so the fake environment can only
  exist there;
- its own production-build server carrying the fake markers, with `reuseExistingServer: false`;
- the shared schema preflight and teardown;
- a single worker.

What each lane proves:

- **Payment (`e2e-payment/`).** A duplicate click charges once. Two browser contexts produce one effect.
  A lost response recovers to Paid without a duplicate. Crafted, appended or stale amounts prepare
  nothing. An owner-authored total is charged exactly. Both checkout surfaces prefill the same reference.
  Details are on
  [Card on file, checkout and payment proof](../payments/card-on-file-checkout-and-payment-proof.md#6-the-e2e-payment-proof-lane).
- **Google (`e2e-google/`).** The fake-Google guard is fail-closed, so no real Google request can leave
  the lane ([config](../../playwright.google.config.ts)). It covers:
  - **Flow A, dedicated calendar:** only the `app.created` scope is requested, exactly one calendar is
    created, re-provisioning is idempotent, an ambiguous multi-match fails closed, and a single orphan
    from a failed insert is adopted on retry.
  - **Flow B, existing calendar:** only `events.owned` is requested, behind an owner-only picker.
  - **Security and pending states:** unauthenticated, non-owner and inactive callers are denied; an
    account switch or a partial grant is rejected without replacing the stored grant; a tampered OAuth
    state is rejected at the callback; provisioning-pending and selection-pending states keep the grant
    and stay retryable.

  See [Google Calendar integration](../integrations/google-calendar-sync.md).
- **Mobile (`e2e-mobile/`).** At iPhone dimensions:
  - Mark completed through the accessible dialog leads to in-place checkout and **exactly one** fake
    charge, with zero other providers contacted.
  - Cancelling the dialog sends no request.
  - Mark no-show uses its own dialog copy.

All three `e2e*-server` scripts are `next build && next start`, never the dev watcher. A guardrail pins this
([`e2e-guardrails.test.ts` L134-L146](../../tests/scripts/e2e-guardrails.test.ts#L134-L146)).

## 2. Local-only by construction

`e2e/helpers/local-env.ts` is the single source of the lane environment
([L1-L159](../../e2e/helpers/local-env.ts#L1-L159)).

- **Hosted targets are refused.** It refuses to load if any Supabase or database URL override points off the
  loopback host or matches a hosted pattern, if a live Stripe key is present, or if `STRIPE_ALLOW_LIVE_MODE` is
  set.
- **Endpoints are literals.** Supabase, Postgres and Mailpit are fixed loopback addresses. The only JWTs are the
  public local `supabase-demo` keys.
- **Every provider value is a dummy**, including Stripe test placeholders with live mode explicitly false.
- **Waitlist flags are confined to one slug.** The new-client waitlist and durable-waitlist flags are enabled
  only for one reserved slug claimed by a single spec. Every other seeded studio runs with them **off**, so the
  rest of the suite doubles as the flag-off regression proof.
- **`HONE_E2E_ROUTE_FAULT=1` is always set** for this server; the fakes' own guards keep it inert anywhere else.

Guardrails ([`e2e-guardrails.test.ts` L25-L163](../../tests/scripts/e2e-guardrails.test.ts#L25-L163)):

- endpoints are local, and hosted overrides and live Stripe are refused;
- login goes through the real magic-link UI and Mailpit;
- no `app/api/e2e` route exists;
- seeds use an `e2e-` prefix and never `delete from public.*`;
- `npm run ci` stays browser-free;
- the CI job uses no secrets or `--linked`;
- no config may adopt an already-running server.

### Ports and server reuse

`scripts/worktree-resources.mjs` derives a **candidate** port for each worktree in 3200–3999 by hashing the
worktree root ([L1-L80](../../scripts/worktree-resources.mjs#L1-L80)):

- 3111 is reserved for CI, which pins it through `HONE_E2E_PORT`;
- the host is the literal `localhost`, because auth cookies must stay on one host string;
- `reuseExistingServer` is **false** in every config, with no opt-in. A port collision therefore fails loudly
  instead of silently testing another worktree's server.

### Schema preflight

Every config shares `e2e/global-setup.ts`. It refuses to run any test when the local stack's applied migrations
differ from this checkout's, and `global-teardown` checks again at the end. The stack is shared across worktrees,
so a reset from another branch would otherwise produce green evidence against a different schema
([`global-setup.ts` L11-L44](../../e2e/global-setup.ts#L11-L44)).

## 3. Seeding and login

`e2e/helpers/seed.ts` writes directly to the local database and the local GoTrue admin API. Identifiers carry a
unique `e2e-` prefix per run, and nothing is cleaned up; the lane assumes `supabase db reset --local`.

`handle_new_user` is a no-op since `0141`, so the seed creates the owner's auth user, then **inserts the
practitioner directly** with current-version acceptance stamps and marks the invitation accepted
([`seed.ts` L93-L130](../../e2e/helpers/seed.ts#L93-L130)). Specs then sign in through the **real** magic-link
form, and the link is captured from Mailpit.

The real sign-in-time acceptance path is exercised by dedicated specs such as
`invitation-reconciliation.spec.ts`; see [Authentication, sessions and tenancy](../security/authentication-sessions-and-tenancy.md).

**Time-of-day independence.** The seeded studio's timezone is a fixed-offset `Etc/GMT±N` zone chosen so the
studio clock reads about 09:00 at seed time. That keeps the local day full of bookable slots whatever the real
hour is ([`e2e/helpers/timezone.ts` L1-L22](../../e2e/helpers/timezone.ts#L1-L22)), and
[`e2e-time-independence.test.ts` L29-L59](../../tests/scripts/e2e-time-independence.test.ts#L29-L59) checks every
UTC hour.

## 4. The fakes, and why none can activate in a deployment

All four use the same guard shape:

- an **explicit server-only marker** — `HONE_E2E_*`, never `NEXT_PUBLIC_*`, and never derived from a request;
- **outright refusal** when any deployed-runtime signal is present: `VERCEL=1`, `VERCEL_ENV`, AWS execution
  variables or `KUBERNETES_SERVICE_HOST`;
- a **fail-loud** variant that throws if the marker is set in a deployed runtime, so the code never quietly falls
  back to the real client.

`NODE_ENV` is deliberately *not* the gate, because the E2E server runs `next start` with
`NODE_ENV=production`.

| Fake | Armed by | Guard | Where it plugs in | Behaviour |
|---|---|---|---|---|
| Resend | `HONE_E2E_FAKE_RESEND=1`; mode from `HONE_E2E_FAKE_RESEND_MODE` or the recipient's local-part prefix | [`e2e-fake-resend.ts` L10-L39](../../lib/email/e2e-fake-resend.ts#L10-L39) | `getResendTransport()`, used by the welcome and new-client-waitlist email paths; `lib/email/client.ts` runs the fail-loud check at module load | `success`, `reject`, `throw`, `failonce` (fails the first send per recipient) and `hold` (in flight for 4 s); no network ([L41-L143](../../lib/email/e2e-fake-resend.ts#L41-L143)) |
| Stripe | `HONE_E2E_FAKE_STRIPE=1` **plus** a well-formed `HONE_E2E_RUN_ID` | [`e2e-fake-guard.ts` L24-L87](../../lib/stripe/e2e-fake-guard.ts#L24-L87) | `lib/stripe/session-payment-stripe.ts` | PaymentIntent create/retrieve/cancel and refund only, with synthetic ids. The outcome is read per idempotency key from a guarded per-run ledger, so the browser can never choose it. A repeated key replays the same result and is still recorded as an invocation ([`e2e-fake-stripe.ts` L1-L130](../../lib/stripe/e2e-fake-stripe.ts#L1-L130)) |
| Google | `HONE_E2E_FAKE_GOOGLE=1` plus a valid run id | [`fake-google-guard.ts` L1-L59](../../lib/google-calendar/e2e/fake-google-guard.ts#L1-L59) | `googleFetch` in `google-transport.ts`, and config | synthetic responses for the exact OAuth and calendar endpoints, with the scenario read from a per-run ledger ([`fake-google-provider.ts` L17-L40](../../lib/google-calendar/e2e/fake-google-provider.ts#L17-L40)) |
| Route faults | `HONE_E2E_ROUTE_FAULT=1` | [`e2e-route-fault.ts` L1-L62](../../lib/reliability/e2e-route-fault.ts#L1-L62) | `app/(app)/e2e-fault/[case]` — authenticated, and `notFound()` whenever the guard fails | cases `ok`, `server-throw`, `client-throw`, `once`, `redirect` and `not-found`. A canary string mimics a raw database error and specs assert it never reaches the DOM ([L64-L117](../../lib/reliability/e2e-route-fault.ts#L64-L117)) |

The payment and Google env modules generate a run id when CI has not exported one, and set the markers **only**
for their own lane's server.

## 5. How CI picks specs

`scripts/browser-groups.mjs` assigns every `e2e/*.spec.ts` to exactly one group:

```
smoke  sessions  intake  portal  booking  calendar  owner_admin  marketing  responsive  google
```

`selectBrowserGroups` maps a diff to groups ([L374-L535](../../scripts/browser-groups.mjs#L374-L535)):

| Diff contains | Result |
|---|---|
| nothing detectable | **extended** (everything) |
| only docs, Markdown, migrations, or DB/security/script/CI tests | no browser lane |
| shared infrastructure (workflows, CI scripts, e2e helpers, Playwright config, `lib/supabase`, `lib/auth`, middleware, the root layout, shared components, package files, `next.config`) | **extended** |
| application code under `app/`, `components/`, `lib/` or `hooks/` that matches no group pattern | **extended** — the fail-safe |
| otherwise | the matched groups plus `smoke` |

CI shards the selection ([`ci.yml` L146-L216](../../.github/workflows/ci.yml#L146-L216)):

- **targeted:** three shards at most, never more than the spec files it selected;
- **extended**, including any full-matrix run that selected no group: four shards;
- **nightly:** the core suite in four shards.

Pinning tests:

- [`browser-selection.test.ts` L14-L88](../../tests/ci/browser-selection.test.ts#L14-L88) — every spec on disk is
  mapped exactly once, with the count derived from the disk;
- [L142](../../tests/ci/browser-selection.test.ts#L142-L142) — the targeted calendar + sessions + smoke selection
  is pinned as a deliberate cost limit;
- [`browser-shard-coverage.test.ts`](../../tests/ci/browser-shard-coverage.test.ts#L97-L170) — the shard count
  comes from one derived value.

Lane-level CI behaviour is on [CI workflows and risk lanes](ci-workflows-and-risk-lanes.md).

## 6. Contradictions and open questions

1. **The targeted cost pin has three different numbers.**
   - The test asserts **39** for calendar + sessions + smoke
     ([`browser-selection.test.ts` L142](../../tests/ci/browser-selection.test.ts#L142-L142)), which is what the
     manifest yields today.
   - The same test's title says "the targeted lane still selects 30" ([L64](../../tests/ci/browser-selection.test.ts#L64-L64)).
   - A comment in `browser-groups.mjs` says the pin is at 36 ([L289-L292](../../scripts/browser-groups.mjs#L289-L292)).
2. **Header comments describe an older, smaller lane.**
   - `playwright.config.ts` still says "one core flow (the treatment-memory loop)" ([L4-L6](../../playwright.config.ts#L4-L6)).
   - `browser-groups.mjs` still quotes 53 serial specs ([L11-L12](../../scripts/browser-groups.mjs#L11-L12)).
   - `e2e/` now holds 94 specs.
3. **"Nothing under app/ or lib/ knows about E2E" is no longer true.** The guardrail's comment says so
   ([`e2e-guardrails.test.ts` L83-L96](../../tests/scripts/e2e-guardrails.test.ts#L83-L96)), but `lib/` contains
   all four fakes and `app/(app)/e2e-fault` exists. The assertion itself checks only for an `E2E_AUTH_BYPASS`
   variable and an `app/api/e2e` directory, and its loop over directories does nothing.
4. **The seed header still describes trigger-based provisioning.** It says the owner is created through
   `pending_invitations -> handle_new_user trigger -> owner practitioner row`
   ([`seed.ts` L11-L16](../../e2e/helpers/seed.ts#L11-L16)), but the code below inserts the practitioner directly
   because the trigger is a no-op. The guardrail still requires the seed text to mention `handle_new_user`
   ([`e2e-guardrails.test.ts` L80](../../tests/scripts/e2e-guardrails.test.ts#L80-L80)).
5. **Fake-Stripe comments lag the code.**
   - The guard calls itself the "(future)" fake processor ([`e2e-fake-guard.ts` L3](../../lib/stripe/e2e-fake-guard.ts#L3-L3)).
   - The fake says its behaviour is "FIXED to success in this pass" ([`e2e-fake-stripe.ts` L20-L22](../../lib/stripe/e2e-fake-stripe.ts#L20-L22)).
   - The fake already selects success, decline or processing per idempotency key from the ledger
     ([L80-L90](../../lib/stripe/e2e-fake-stripe.ts#L80-L90)).
6. **"127.0.0.1" versus `localhost`.** `local-env.ts` says every URL is hard-coded to 127.0.0.1
   ([L11-L13](../../e2e/helpers/local-env.ts#L11-L13)), but the app origin is deliberately `localhost`
   ([L73-L84](../../e2e/helpers/local-env.ts#L73-L84)). Both are loopback; only the comment is imprecise.
