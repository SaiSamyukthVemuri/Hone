# 0294 rate-limit fallback: activation and rollback package (HELD)

Status: **held**. Nothing here authorizes applying 0294, merging #1339, a release or any hosted change. Sam's per-change authorization is required for each.

## Before the app is released (Sam, hosted)

1. Add `HONE_LIMITER_HMAC_SECRET` to the Vercel project for **production and preview**: at least 32 random bytes, e.g. the output of `openssl rand -base64 32` (43+ characters). Shorter values, and values with fewer than 12 distinct characters, are refused by the app, which then refuses the bounded public classes (fail closed) and says so in the operator log. The value is never written to a file or chat.
2. `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are already set for production and preview (OPS names-only read).
3. Create the Sentry alert rule described in `DN-29-SENTRY-ALERT-INTEGRATION.md` (Part B), after release.

## What changes for the platform lead tables (read before activating)

Each landing early-access and each /demo submission now also writes one **platform lead-alert row** through the 0213 commands, in the same transaction as the lead. **Nothing sends it yet**: the app has no claim, sweep or settle caller and no outbound mail or SMS code on these paths, so there is no new outbound message. Rows accumulate as pending alerts until a separate, separately approved sender exists. A source test pins this (no app, lib or script file calls any 0213 sender command; the two actions import no mail or SMS client).

## Order of activation

1. Release the application first. The waitlist/demo actions call the 0213 commands, which work with or without 0294.
2. Apply 0294 only afterwards (it drops the anonymous insert policies on `waitlist` and `demo_requests`).

## Rollback: prefer a FORWARD FIX; the down step is BREAK-GLASS only

**The down step re-opens anonymous direct writes** to `waitlist` and `demo_requests` (the 0004/0006 policies and the default privileges, so anyone holding the public key can post to PostgREST and walk around every limiter). The preferred recovery for any problem with 0294 is a forward fix (a new migration) with the app left in place. Use the down step only when no forward fix is available in time, and only with Sam's per-change authorization.

Why the order matters if it is used: rolling the application back **below the release that contains `record_platform_early_access_signup` / `record_platform_demo_request` calls** (merge of #1339) **after 0294 is applied loses leads**: the old app inserts with the public key, which 0294 removed, so every landing-page and demo submission fails.

1. Apply `supabase/rollbacks/0294_rate_limit_fallback_counter.down.sql` **first** (one transaction): restores both anonymous insert policies and the default table privileges, then drops the counter table and functions.
2. **Check the grant restoration with `has_table_privilege` after running it** (read-only): `select has_table_privilege('anon','public.waitlist','insert'), has_table_privilege('anon','public.demo_requests','insert'), has_table_privilege('authenticated','public.waitlist','insert'), has_table_privilege('authenticated','public.demo_requests','insert'), has_table_privilege('service_role','public.waitlist','insert'), has_table_privilege('service_role','public.demo_requests','insert')` must return all `true`, and `select policyname from pg_policies where tablename in ('waitlist','demo_requests') and cmd = 'INSERT'` must return both policies; `to_regclass('public.rate_limit_fallback_counters')` must be null.
3. Only then roll the application back.
4. After the app is back on a release carrying the 0213-command actions, re-apply the closure (a forward migration) so the direct writes are not left open.

While the down step is applied and the new app is still running, nothing breaks: the new app writes through the 0213 commands, and the outage fallback refuses the bounded classes if Upstash is down (the counter is gone, so it cannot be consulted).

A DB test (`tests/db/waitlist-demo-direct-write-closure.db.test.ts`) applies the down SQL inside a rolled-back transaction, proves the old app's anonymous insert works again and, with `has_table_privilege`, that the grants are restored.
