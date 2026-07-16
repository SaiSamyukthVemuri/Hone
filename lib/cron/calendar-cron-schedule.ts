// Google Calendar — Phase B2.3-c3: the canonical cron schedules for the two
// Google Calendar cron routes, as registered in vercel.json. Single source of
// truth so vercel.json and the config/activation tests cannot drift.
//
// PLATFORM CONSTRAINT: the production Vercel plan caps cron cadence at ONCE PER
// DAY (a sub-daily `*/N` vercel.json cron is rejected at deploy — the same reason
// the appointment-reminder route runs on an external every-15-min scheduler; see
// docs/08 + docs/10). Both calendar routes are therefore DAILY, staggered after
// the 08:00 `materialize-recurring-breaks` cron. Per B2.3-c3 §6 the reconciliation
// schedule fires BEFORE the worker-drain schedule.
//
// DORMANT: registering a schedule does NOT enable synchronization. When these fire
// in production, `worker_enabled=false` makes the claim RPC return zero rows and
// mutate nothing, and every studio outbound/inbound/two-way flag is false, so the
// worker route reports no-work and the reconciliation route finds zero eligible
// studios. The claim RPC + the studio intent flags remain the authoritative gates.
// These strings are NOT read by the routes (Vercel reads vercel.json); they exist
// only to pin vercel.json against drift.

// Reconciliation sweep (B2.3-b) — daily at 09:00 UTC (before the worker).
export const CALENDAR_RECONCILE_CRON_SCHEDULE = "0 9 * * *";
// Worker drain (B2.3-c2) — daily at 09:30 UTC (after reconciliation).
export const CALENDAR_SYNC_CRON_SCHEDULE = "30 9 * * *";
