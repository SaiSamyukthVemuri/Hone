# Cron setup for Hone

The email reminder + no-show system has two API endpoints that need to be
hit on a schedule:

- `GET /api/cron/appointment-reminders` — every hour
- `GET /api/cron/no-show-check` — every 15 minutes

Both require an `Authorization: Bearer <CRON_SECRET>` header. Set
`CRON_SECRET` in Vercel env vars (generate with `openssl rand -hex 32`).

## Why this isn't in vercel.json

Vercel's **Hobby plan caps cron jobs at once per day**. The schedules we need
run more frequently than that, so `vercel.json` currently ships with an empty
`crons` array. Deployment passes; nothing is scheduled by Vercel itself.

When you upgrade to **Pro** ($20/mo), restore the schedules:

```json
{
  "crons": [
    { "path": "/api/cron/appointment-reminders", "schedule": "0 * * * *" },
    { "path": "/api/cron/no-show-check", "schedule": "*/15 * * * *" }
  ]
}
```

Until then, pick one of the external schedulers below.

## Option A: cron-job.org (free, 5 minutes to set up)

1. Sign up at https://cron-job.org.
2. Create two jobs:
   - **Reminders** — URL `https://hone.care/api/cron/appointment-reminders`, schedule every hour (minute 0).
   - **No-show check** — URL `https://hone.care/api/cron/no-show-check`, schedule every 15 minutes.
3. Under each job's **Advanced** settings, add a request header:
   - Name: `Authorization`
   - Value: `Bearer <your CRON_SECRET>`
4. Save and enable.

cron-job.org has a free tier that covers both jobs comfortably.

## Option B: GitHub Actions (free, requires repo)

Create `.github/workflows/cron.yml`:

```yaml
name: Hone crons
on:
  schedule:
    - cron: "0 * * * *"      # reminders, hourly
    - cron: "*/15 * * * *"   # no-show check
jobs:
  ping:
    runs-on: ubuntu-latest
    steps:
      - name: Reminders
        if: github.event.schedule == '0 * * * *'
        run: |
          curl -fsS -H "Authorization: Bearer $CRON_SECRET" \
            https://hone.care/api/cron/appointment-reminders
        env:
          CRON_SECRET: ${{ secrets.HONE_CRON_SECRET }}
      - name: No-show check
        if: github.event.schedule == '*/15 * * * *'
        run: |
          curl -fsS -H "Authorization: Bearer $CRON_SECRET" \
            https://hone.care/api/cron/no-show-check
        env:
          CRON_SECRET: ${{ secrets.HONE_CRON_SECRET }}
```

Then in the GitHub repo: **Settings → Secrets and variables → Actions →
New repository secret**, add `HONE_CRON_SECRET` with the same value.

Caveat: GitHub Actions cron schedules can be delayed by 10-30 minutes
under load. Fine for reminders. Slightly less precise for the no-show
check than Pro Vercel crons.

## Option C: Supabase pg_cron (already-in-stack option)

Supabase supports `pg_cron` extension. Enable it in the dashboard
(**Database → Extensions → pg_cron**) and schedule a function that calls
the endpoints via `pg_net.http_get`. More setup; only worth doing if you
want everything in one place.

## Testing the endpoints manually

```bash
curl -fsS -H "Authorization: Bearer $CRON_SECRET" \
  https://hone.care/api/cron/appointment-reminders
# → {"ok":true,"reminder_24h":{...},"reminder_2h":{...}}

curl -fsS -H "Authorization: Bearer $CRON_SECRET" \
  https://hone.care/api/cron/no-show-check
# → {"ok":true,"scanned":N,"marked":N,"followups_sent":N}
```

Both endpoints are idempotent and rate-limited internally (50 reminders
per run, 100 no-show checks per run, 3 send attempts per appointment).
Calling them more often than the recommended schedule is harmless.
