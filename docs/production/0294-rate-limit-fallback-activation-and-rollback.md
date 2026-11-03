# 0294 rate-limit fallback: activation and rollback package (HELD)

Status: **held**. Nothing here authorizes applying 0294, merging #1339, a release or any hosted change. Sam's per-change authorization is required for each.

## Before the app is released (Sam, hosted)

1. Add `HONE_LIMITER_HMAC_SECRET` to the Vercel project for **production and preview**: at least 32 random bytes, e.g. the output of `openssl rand -base64 32` (43+ characters). Shorter values, and values with fewer than 12 distinct characters, are refused by the app, which then refuses the bounded public classes (fail closed) and says so in the operator log. The value is never written to a file or chat.
2. `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are already set for production and preview (OPS names-only read).
3. Create the Sentry alert rule described in `DN-29-SENTRY-ALERT-INTEGRATION.md` (Part B), after release.

## What changes for the platform lead tables (read before activating)

Each landing early-access and each /demo submission now also writes one **platform lead-alert row** through the 0213 commands, in the same transaction as the lead. **Nothing sends it yet**: the app has no claim, sweep or settle caller and no outbound mail or SMS code on these paths, so there is no new outbound message. Rows accumulate as pending alerts until a separate, separately approved sender exists. A source test pins this (no app, lib or script file calls any 0213 sender command; the two actions import no mail or SMS client).

**No-send proof, and its limit (T-3).** The source test scans app, lib and scripts for names, so it proves this repository has no sender caller. It cannot prove that no sender exists elsewhere (a hosted-side cron or webhook, a Supabase function outside those folders, another service). Any sender is its own reviewed change.

**Rows accumulate, and who watches them (T-4).** Every submission writes an alert row that nothing consumes or expires (the 0213 expire command is not called). Growth is bounded by submission rate, now that the direct write is closed. The operator (OPS) reviews the pending count `select count(*) from public.platform_lead_alerts where status = 'pending'` at each release review and when the Sentry rule fires, and decides expiry then.

**Rollout rule for any later sender (G1, Privacy).** A sender processes ONLY alerts created AFTER its own enablement time. The enabling change itself writes that time durably, and the sender's claim query filters `created_at >= enabled_at`. Alerts created before it are never sent, so enabling a sender cannot flush the accumulated backlog as one message per old lead. The older rows are handled separately and deliberately (reviewed, then expired through the existing 0213 expiry command, or sent by an explicit, approved one-off), never by the sender's first run. The sender is a separate, separately approved change; nothing here authorizes building or enabling one.

## Before applying 0294: take the privilege snapshot (T-2, F-4)

Read-only, on both tables, saved with the apply record: `select table_name, grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name in ('waitlist','demo_requests') order by 1,2,3`, plus `select tablename, policyname, cmd, roles from pg_policies where tablename in ('waitlist','demo_requests') order by 1,2`. The down step's `grant all` restores the pre-0294 Supabase defaults (including truncate, references and trigger, which PostgREST does not expose); after any down step compare the WHOLE privilege and policy list to this snapshot, not only insert.

## Release-note items (T-5)

- During a limiter outage, an allowed slug request now makes three counter writes (pre-lookup visitor, visitor with studio, studio) instead of two, on a path already degraded.
- The pre-lookup visitor bucket has the same limit as the visitor bucket, so one visitor is now capped across ALL studios at the visitor bound: stricter than before, intended, and a shared-NAT visitor is the cost.

## Order of activation

1. Release the application first. The waitlist/demo actions call the 0213 commands, which work with or without 0294.
2. Apply 0294 only afterwards (it drops the anonymous insert policies on `waitlist` and `demo_requests`).

## Rollback: prefer a FORWARD FIX; the down step is BREAK-GLASS only

**The down step re-opens anonymous direct writes** to `waitlist` and `demo_requests` (the 0004/0006 policies and the default privileges, so anyone holding the public key can post to PostgREST and walk around every limiter). The preferred recovery for any problem with 0294 is a forward fix (a new migration) with the app left in place. Use the down step only when no forward fix is available in time, and only with Sam's per-change authorization.

Why the order matters if it is used: rolling the application back **below the release that contains `record_platform_early_access_signup` / `record_platform_demo_request` calls** (merge of #1339) **after 0294 is applied loses leads**: the old app inserts with the public key, which 0294 removed, so every landing-page and demo submission fails.

1. Apply `supabase/rollbacks/0294_rate_limit_fallback_counter.down.sql` **first** (one transaction): restores both anonymous insert policies and the default table privileges, then drops the counter table and functions.
2. **Check the grant restoration with `has_table_privilege` after running it** (read-only): `select has_table_privilege('anon','public.waitlist','insert'), has_table_privilege('anon','public.demo_requests','insert'), has_table_privilege('authenticated','public.waitlist','insert'), has_table_privilege('authenticated','public.demo_requests','insert'), has_table_privilege('service_role','public.waitlist','insert'), has_table_privilege('service_role','public.demo_requests','insert')` must return all `true`, and `select policyname from pg_policies where tablename in ('waitlist','demo_requests') and cmd = 'INSERT'` must return both policies; `to_regclass('public.rate_limit_fallback_counters')` must be null.
3. Only then roll the application back.
4. After the app is back on a release carrying the 0213-command actions, re-open the closure with a NEW forward migration (a new number assigned by OPS; 0294 is never re-run or edited) so the direct writes are not left open.

**The ledger is NOT changed by the down step (T-1).** The down SQL touches no migration table, so after it runs the hosted migration history still lists 0294 as applied while its objects are gone, and `docs/production/migration-state.json` (`hosted_migration_max`) would still say so. A break-glass rollback therefore must, in the same change that records it: (a) record the reversal in `docs/production/migration-ledger.md` (date, who authorized it, the has_table_privilege and policy check output) and never leave the ledger or `migration-state.json` claiming that 0294 objects exist; (b) decide, with Sam's separate authorization, how the hosted history row is repaired (for example `supabase migration repair --status reverted 0294` against the confirmed project) before any later `supabase db push`, so the history and the schema agree; and (c) leave 0294 on the held list until the forward migration replaces it. Nothing in this document authorizes any of those hosted steps.

While the down step is applied and the new app is still running, nothing breaks: the new app writes through the 0213 commands, and the outage fallback refuses the bounded classes if Upstash is down (the counter is gone, so it cannot be consulted).

A DB test (`tests/db/waitlist-demo-direct-write-closure.db.test.ts`) applies the down SQL inside a rolled-back transaction, proves the old app's anonymous insert works again and, with `has_table_privilege`, that the grants are restored.

## Still open from earlier reviews (T-6, carried, none introduced here)
F-3 hosted slug shape check; F-4 snapshot before apply (now a step above); F-5 separate HMAC secrets; E-6 DB and proof runs at the FINAL head (reported at 44e51115a, evidence in the handoffs); NQ-6 (the D-2 switch, default false) and D-5 (alert rule and owner) are Sam's. Deployment order is unchanged: app first, then 0294; rollback by the break-glass step only.
