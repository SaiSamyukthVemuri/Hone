# Restore drill: database rows plus Storage objects (HIPAA-READY-01 G-12)

Issue #828 (gap G-12) and the Thursday rehearsal in #824 require an
**isolated, synthetic** backup-and-restore drill. This runbook defines it.
`scripts/ops/restore-drill.sh` runs it.

> This is local evidence about Hone's *procedure*. It is not evidence about
> the hosted project's backup configuration (PITR, retention, plan). That
> is checked read-only and recorded separately in
> `docs/security/hipaa-readiness-assessment.md` (G-03, G-12).

## Why Storage needs its own step

Supabase says: "Database backups do not include objects you store via the
Storage API, as the database only includes metadata about these objects"
([backups](https://supabase.com/docs/guides/platform/backups)). Treatment
photos live in the private `treatment-images` bucket. A database restore
alone brings back `treatment_images` rows that point at missing bytes.

## What the drill does

| Step | Action |
|---|---|
| 1 | Starts its **own** stack (`hone-restore-drill`, ports `5652x`/`8683`) from a scratch copy of `supabase/`. Only Postgres, PostgREST, Storage, Kong and Auth run. |
| 2 | Seeds synthetic rows (`scripts/ops/restore-drill-seed.sql`), including an auth user with a Google identity linked to the practitioner, and uploads three synthetic objects to `treatment-images` at paths that satisfy the table's path check. |
| 3 | Fingerprints every `public` table, every `auth` table except its migration history, and `storage.buckets` / `storage.objects`: row count and an order-independent md5. Also hashes the object bytes. |
| 4 | Backs up the rows with `pg_dump --data-only` and the object bytes through the Storage API, separately. |
| 5 | Destroys the project: `supabase stop --no-backup` deletes its volumes. |
| 6 | Starts a **new** project from the repository migrations, truncates the rows the migrations seeded, loads the export with `session_replication_role = replica`, and re-uploads the object bytes. |
| 7 | Compares fingerprints and object hashes. `storage.objects` is compared by count, because re-uploading refreshes its timestamps and version. Exits non-zero on any difference. |

**Guards.**
- It refuses to start if any `SUPABASE_`/`HONE_` variable names a hosted
  Supabase URL, or if a drill port is in use.
- It always deletes its stack on exit.
- It never touches another lane's stack.
- Run it on its own, never alongside a full local suite or another reset.

```bash
scripts/ops/restore-drill.sh /path/to/evidence-dir
```

## Application readability (DR-01A)

Identical hashes say the data came back; they do not say Hone can read it.
`scripts/ops/restore-drill-app-check.mjs` closes that gap. The drill calls it
through `RESTORE_DRILL_APP_CHECK`; unset, the drill behaves exactly as above.

| Phase | When | Expected |
|---|---|---|
| `pre-restore` (negative control) | the rebuilt project, before any row is loaded | exit **1**: sign-in and all three reads miss |
| `post-restore` | after the fingerprint comparison | exit **0**: sign-in and all three reads succeed |

The check starts the Hone **production build** (`next build`, then `next start`,
as the e2e harness does) against the drill's project and signs in as the seeded
synthetic practitioner. GoTrue's admin API issues the magic-link token and
`verifyOtp` exchanges it for the session cookie; only the mail hop is skipped,
because the drill runs no mail server. It then reads:

1. `/clients`: the seeded client's link and rendered name;
2. `/clients/<id>?tab=consultation`: the record heading and the restored
   clinical note;
3. `/api/clients/<id>/images/<image>/signed-url`: the app signs one restored
   photo, and the bytes behind that URL must hash equal to the bytes the drill
   uploaded (`objects-before.sha256`).

Exit codes: `0` all reads succeeded, `1` a read missed, `2` a harness error.
The drill **passes only on post-restore 0 and pre-restore exactly 1**, so a
broken build or server can never pass as a negative control.

**Providers.** The server gets a closed environment (only `PATH` and `HOME` are
inherited): fake Resend, fake Stripe with a test key, the Sentry egress guard
(`e2e/helpers/sentry-egress-guard.cjs`), and no Twilio or Google values. Twilio
is unset rather than faked because the Twilio egress fake (#1117) is not on
this branch, so no SMS path is reachable. The check refuses to start if any of
that is not true.

**Where it runs.** CI only: `.github/workflows/restore-drill.yml`, a job that is
**not required**, on a disposable runner, when the drill's files change or on
demand. There the check runs under the `hone-egress` group. Firewall rules log
and reject every non-loopback packet from that group, a probe first shows the
rules match, and the job fails unless both counters (IPv4, IPv6) read zero.
Evidence (logs, Sentry guard records, egress counts) is uploaded as the
`restore-drill-evidence` artifact.

**Token isolation.** The sign-in token cannot be used against production, and
the check never offers it there:
- GoTrue on the drill's own stack mints it, signed with the Supabase CLI's
  public demo JWT secret. A hosted project uses a different secret, so the
  token would not verify there; the check also refuses any key whose issuer is
  not `supabase-demo` or that carries a project ref.
- The API must be exactly `http://127.0.0.1:56521`, parsed (so
  `127.0.0.1.supabase.co`, `localhost`, userinfo tricks, another port, `https`
  and any hosted URL are refused), and that check runs before the first network
  call of every entry point. A hosted URL exits 2 with zero network attempts.
- The session cookie goes only to the app on `127.0.0.1:3197`; the server's
  environment is closed; and in CI the firewall rejects and counts every
  non-loopback packet from the check.
This is proved from configuration and code (tests in
`tests/scripts/restore-drill-app-check.test.ts`); nothing is ever sent to a
hosted project to test it.

**Sign-in writes.** Signing in creates a session row in `auth.sessions` and
updates the user's sign-in time. That happens after the drill's comparison, so
it never affects the drill's verdict.

## Recovery objectives (proposal: Sam to decide)

| Objective | Proposal | Basis |
|---|---|---|
| RPO, database | Point-in-time recovery window once PITR is enabled (G-03); until then, the plan's daily backup | Hosted configuration, unverified |
| RPO, Storage objects | Needs a scheduled object export; **none exists today** | This drill shows the export and restore route works; no schedule is set yet |
| RTO | Hours, not minutes, for a full rebuild; see the measured local timings below | Local drill timing is a lower bound |

## Results

Filled in by each run. Keep earlier rows.

| Date (UTC) | Migrations head | Result | Tables equal | Objects byte-equal | Backup | Restore | Total | Notes |
|---|---|---|---|---|---|---|---|---|
| 2026-10-12 00:26 | `6c5eac80` | **FAIL (true positive)** | 93 of 99 | 3 of 3 | 1 s | 280 s | 599 s | Six seeded tables restored **empty**. With `pg_dump`, `--table` overrides `--schema`, so the combined call exported no `public` rows. The fingerprint comparison caught it. Fixed by splitting the export into two dumps, plus a guard that fails the run if the export has no `public.clients` rows. |
| 2026-10-12 00:37 | `6c5eac80` | **PASS** | 99 of 99 | 3 of 3 | 1 s | 283 s | 594 s | Restore time is almost entirely re-applying the migration chain to the new project. |
| 2026-10-12 13:42 | `6c5eac80` | **PASS** | 120 of 120 | 3 of 3 | 1 s | 304 s | 611 s | After Codex's review on #848: the drill now runs Auth (GoTrue), seeds a synthetic user with a **Google identity** linked to the practitioner, exports and fingerprints **every auth table** except its migration history (22 tables, so `auth.identities` survives, not just `auth.users`), and signs its local token with a runtime expiry. |

**What this does and does not show**
- **Shows:** with Hone's migrations, a logical row export plus a separate
  object export is enough to rebuild a project: rows identical and photo
  bytes identical. It also shows the procedure detects an incomplete export.
- **Does not show:**
  - hosted PITR or backup configuration;
  - any hosted restore;
  - passwords for custom database roles. Supabase's daily backups omit
    them too;
  - restore at production data volume;
  - a scheduled object export. None exists yet; that is G-12's remaining
    gap.
