# 0294 rate-limit fallback: activation and rollback package (HELD)

Status: **held**. Nothing here authorizes applying 0294, merging #1339, a release or any hosted change. Sam's per-change authorization is required for each.

## Before the app is released (Sam, hosted)

1. Add `HONE_LIMITER_HMAC_SECRET` to the Vercel project for **production and preview**: at least 32 random bytes, e.g. the output of `openssl rand -base64 32` (43+ characters). Shorter values, and values with fewer than 12 distinct characters, are refused by the app, which then refuses the bounded public classes (fail closed) and says so in the operator log. The value is never written to a file or chat.
2. `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are already set for production and preview (OPS names-only read).
3. Create the Sentry alert rule described in `DN-29-SENTRY-ALERT-INTEGRATION.md` (Part B), after release.

## Order of activation

1. Release the application first. The waitlist/demo actions call the 0213 commands, which work with or without 0294.
2. Apply 0294 only afterwards (it drops the anonymous insert policies on `waitlist` and `demo_requests`).

## Rollback: the order is the reverse, and it matters

Rolling the application back **below the release that contains `record_platform_early_access_signup` / `record_platform_demo_request` calls** (merge of #1339) **after 0294 is applied loses leads**: the old app inserts with the public key, which 0294 removed, so every landing-page and demo submission fails.

1. Apply `supabase/rollbacks/0294_rate_limit_fallback_counter.down.sql` **first** (one transaction): restores both anonymous insert policies and the default table privileges, then drops the counter table and functions.
2. Only then roll the application back.

While the down step is applied and the new app is still running, nothing breaks: the new app writes through the 0213 commands, and the outage fallback refuses the bounded classes if Upstash is down (the counter is gone, so it cannot be consulted).

Verification after the down step (read-only): `select policyname from pg_policies where tablename in ('waitlist','demo_requests') and cmd = 'INSERT'` returns both policies; `to_regclass('public.rate_limit_fallback_counters')` is null.

A DB test (`tests/db/waitlist-demo-direct-write-closure.db.test.ts`) applies the down SQL inside a rolled-back transaction and proves the old app's anonymous insert works again.
