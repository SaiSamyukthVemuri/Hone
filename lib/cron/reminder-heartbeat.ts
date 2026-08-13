import "server-only";
import { Redis } from "@upstash/redis";
import { CRON_INTERVAL_MINUTES } from "@/lib/cron/reminder-schedule";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { recordOpsAlert } from "@/lib/ops/alerts";

// ---------------------------------------------------------------------------
// PR #265. Operator-visible heartbeat for the EXTERNAL appointment-reminder
// scheduler.
// ---------------------------------------------------------------------------
//
// /api/cron/appointment-reminders is driven by an external every-15-minute
// scheduler (cron-job.org), because Vercel's plan caps cron at once-per-day
// (PR #258). If that external scheduler is disabled, misconfigured, or
// failing, reminders silently stop and NOTHING is recorded — a stopped
// scheduler produces SILENCE, not an alert (the existing
// `cron_route_failed` / `reminder_send_exhausted` ops_alerts only fire when
// the route runs AND something throws/exhausts).
//
// This module records a single positive "last successful reminder cron run"
// heartbeat so the admin console can show healthy / stale / missing. It
// reuses the Upstash Redis that already backs public rate limiting
// (PR #262 makes it production-required) — a single overwritten KV key, NOT
// the append-only ops_alerts table (which would gain ~96 info rows/day and
// pollute the failure dashboard). No migration, no new dependency, no new
// scheduler/queue.
//
// Posture (mirrors lib/rate-limit/public.ts): FAIL-OPEN. The write is
// best-effort and never throws — a heartbeat failure must never break a real
// reminder run. The read returns null ("unknown/unconfigured") on any error
// rather than crashing the admin page. Locally (no Upstash) it reads as
// missing/unknown, which is acceptable for an operator signal; in production
// Upstash is guaranteed present by the PR #262 build gate.
//
// Non-sensitive ONLY: the heartbeat stores a timestamp + aggregate run
// counts. NEVER a client email/phone/name, appointment notes, raw token,
// token hash, URL, or the CRON_SECRET.

const HEARTBEAT_KEY = "reminder_cron:last_success";
// Expire the key well after a healthy cadence so a long-dead scheduler reads
// as "missing" rather than leaving an ancient timestamp lingering forever.
const HEARTBEAT_TTL_SECONDS = 60 * 60 * 24; // 24h

// ---------------------------------------------------------------------------
// Health thresholds — derived from the shipped cadence contract, never literals
// ---------------------------------------------------------------------------
//
// Both thresholds are multiples of CRON_INTERVAL_MINUTES so a future cadence
// change moves the monitoring contract with it (there is no second magic 15).
//
// DEGRADED (2 x cadence = 30 min). This is the exact point where the reminder
// system loses its correctness MARGIN, and the number is not arbitrary: the 2h
// reminder window is 30 minutes wide (REMINDER_WINDOW_MINUTES["2h"] = [105,
// 135]). The reliability invariant in lib/cron/reminder-schedule.ts is that a
// window W minutes wide sampled every P minutes is only missable when W < P.
// So while the effective cadence stays <= 30 the 2h window still covers every
// appointment minute offset; the moment it exceeds 30, appointment offsets
// start being missed outright (at 45 min: 19/60 offsets; at 60 min: 29/60).
// A heartbeat age above 2 x cadence therefore means "the external scheduler is
// no longer delivering the cadence the window math depends on".
//
// STALE (3 x cadence = 45 min) is unchanged from PR #265 — three consecutive
// missed cycles is a sustained failure, not a blip, and matches the 3-strike
// per-row MAX_ATTEMPTS posture of the reminder route itself.
//
// PR #283 classified everything from 45 min upwards as one "stale" bucket and
// reported it as a WARNING, which never emails. That left two holes this module
// now closes: ages between 30 and 45 minutes were reported as fully "healthy"
// (a silent cadence regression), and a genuinely dead scheduler only produced
// an EMAIL once the 24h heartbeat TTL expired it into "missing" — up to ~48h.
export const REMINDER_DEGRADED_AFTER_MINUTES = CRON_INTERVAL_MINUTES * 2; // 30
export const REMINDER_STALE_AFTER_MINUTES = CRON_INTERVAL_MINUTES * 3; // 45

export type ReminderHeartbeat = {
  // RECENCY axis: when the latest successful run COMPLETED.
  at: string;
  // ---------------------------------------------------------------------
  // CADENCE axis (OPS-01.1, review 3775042692). The external scheduler's
  // cadence is the spacing between route INVOCATIONS, not between run
  // completions. Deriving it from completions is wrong in both directions:
  // a run that starts 31 minutes late but finishes quickly looks like a
  // 30-minute cadence, and a slow run makes an on-time scheduler look late.
  // These fields therefore hold INVOCATION timestamps, and are named so they
  // cannot be mistaken for completion times.
  //
  // Both are OPTIONAL: every heartbeat written before this change has neither,
  // and the classifier must report cadence as UNAVAILABLE rather than invent an
  // interval from whatever timestamp happens to be present. One cycle of
  // warm-up is the honest cost.
  // ---------------------------------------------------------------------
  invokedAt?: string; // when the latest successful run STARTED
  previousInvokedAt?: string; // when the previous successful run STARTED
  durationMs?: number;
  emailAttempted?: number;
  emailSucceeded?: number;
  emailFailed?: number;
  smsAttempted?: number;
  smsSucceeded?: number;
  smsFailed?: number;
};

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? new Redis({ url, token }) : null;
}

// Parse a heartbeat that may arrive as an object or a JSON string (the Upstash
// client usually deserializes, but tolerate both). Returns null on anything
// that is not a heartbeat with a usable `at`.
function coerceHeartbeat(raw: unknown): ReminderHeartbeat | null {
  try {
    const hb =
      typeof raw === "string" ? (JSON.parse(raw) as ReminderHeartbeat) : raw;
    if (!hb || typeof hb !== "object") return null;
    const at = (hb as ReminderHeartbeat).at;
    return typeof at === "string" && at.length > 0
      ? (hb as ReminderHeartbeat)
      : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Monotonic heartbeat merge (OPS-01.1, review 3775070631)
// ---------------------------------------------------------------------------
//
// Two reminder runs can overlap, and Redis completion order is NOT invocation
// order: an older invocation can finish (and reach Redis) after a newer one.
// A read-then-write cannot be monotonic under that — the earlier claim in this
// file that it "keeps `at` monotonic" was simply WRONG and has been removed.
//
// This pure function is the SPECIFICATION of the merge. The Lua script below
// performs exactly this merge atomically inside Redis, so the read and the
// write cannot be interleaved by another run.
//
// Rules, given the stored value and an arriving candidate:
//   * `at` (recency) takes the LATER completion — a successful run that
//     finished later is real, so recency never moves backwards.
//   * a candidate whose invocation is NEWER becomes the cadence point, and the
//     one it displaces becomes `previousInvokedAt`.
//   * a candidate whose invocation is OLDER never overwrites the newer cadence
//     point; it may only improve `previousInvokedAt` when it is a CLOSER
//     predecessor of the stored invocation than what is recorded.
//   * an equal invocation is a no-op for cadence (idempotent / non-regressive).
export function mergeReminderHeartbeat(
  current: ReminderHeartbeat | null,
  candidate: ReminderHeartbeat,
): ReminderHeartbeat {
  const t = (iso: string | undefined): number | null => {
    if (!iso) return null;
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? null : ms;
  };
  // A stored heartbeat whose completion timestamp is unusable cannot be ordered
  // against, so this run replaces it outright rather than being compared to it.
  // The Lua applies the identical guard — without it, a corrupt-but-valid-JSON
  // value would sort AFTER every real ISO timestamp and pin the heartbeat in a
  // broken state forever.
  if (!current || t(current.at) === null) return { ...candidate };

  const curAt = t(current.at);
  const candAt = t(candidate.at);
  const curInv = t(current.invokedAt);
  const candInv = t(candidate.invokedAt);
  const curPrevInv = t(current.previousInvokedAt);

  // Recency: the later completion wins, so it can never regress.
  const at =
    curAt !== null && candAt !== null
      ? (candAt >= curAt ? candidate.at : current.at)
      : (candidate.at ?? current.at);

  // Aggregate counts follow whichever completion we kept.
  const base = at === candidate.at ? candidate : current;

  let invokedAt = current.invokedAt;
  let previousInvokedAt = current.previousInvokedAt;

  if (candInv !== null) {
    if (curInv === null) {
      // First invocation-bearing heartbeat: adopt it, no predecessor known.
      invokedAt = candidate.invokedAt;
      previousInvokedAt = candidate.previousInvokedAt;
    } else if (candInv > curInv) {
      // Newer invocation: it becomes the cadence point, displacing the old one.
      invokedAt = candidate.invokedAt;
      previousInvokedAt = current.invokedAt;
    } else if (candInv < curInv) {
      // An OLDER invocation arriving late. It must never regress the cadence
      // point. It may still be the closest known predecessor of it.
      if (curPrevInv === null || candInv > curPrevInv) {
        previousInvokedAt = candidate.invokedAt;
      }
    }
    // candInv === curInv: idempotent, nothing to change.
  }

  return {
    ...base,
    at,
    ...(invokedAt ? { invokedAt } : {}),
    ...(previousInvokedAt ? { previousInvokedAt } : {}),
  };
}

// The atomic form of mergeReminderHeartbeat, executed server-side by Redis so
// no other run can interleave between the read and the write. Keep in lockstep
// with the function above.
//
// KEYS[1] = heartbeat key
// ARGV[1] = candidate heartbeat JSON
// ARGV[2] = TTL seconds
const HEARTBEAT_MERGE_LUA = `
-- Every timestamp this module writes is a canonical ISO-8601 UTC string from
-- Date.prototype.toISOString(), so LEXICOGRAPHIC order equals chronological
-- order — but ONLY for values that actually have that shape. A stored value can
-- be valid JSON and still hold a corrupt timestamp ("not-a-date"), which sorts
-- AFTER any real "2026-..." string and would therefore pin the heartbeat in a
-- corrupt state forever, unrecoverable without manual intervention. So every
-- timestamp is shape-validated before it is compared, mirroring the Date.parse
-- guards in mergeReminderHeartbeat. Unvalidated values are treated as absent.
local function ts(v)
  if v == nil or v == cjson.null or type(v) ~= 'string' then return nil end
  if string.match(v, '^%d%d%d%d%-%d%d%-%d%dT%d%d:%d%d:%d%d') == nil then return nil end
  return v
end
local raw = redis.call('GET', KEYS[1])
local cand = cjson.decode(ARGV[1])
local cur = nil
if raw then
  local ok, decoded = pcall(cjson.decode, raw)
  -- A stored heartbeat whose completion timestamp is unusable is not a
  -- heartbeat we can order against; treat it as absent so this run replaces it.
  if ok and type(decoded) == 'table' and ts(decoded.at) ~= nil then cur = decoded end
end
if cur == nil then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
  return 1
end
local out = {}
for k, v in pairs(cur) do out[k] = v end
-- recency: the later completion wins, so it never regresses
local ca = ts(cand.at)
local ua = ts(cur.at)
if ca ~= nil and (ua == nil or ca >= ua) then
  for k, v in pairs(cand) do out[k] = v end
  out.at = ca
  out.invokedAt = cur.invokedAt
  out.previousInvokedAt = cur.previousInvokedAt
end
-- cadence: ordered by INVOCATION, never by completion or arrival
local ci = ts(cand.invokedAt)
local ui = ts(cur.invokedAt)
local up = ts(cur.previousInvokedAt)
if ci ~= nil then
  if ui == nil then
    out.invokedAt = ci
    out.previousInvokedAt = ts(cand.previousInvokedAt)
  elseif ci > ui then
    out.invokedAt = ci
    out.previousInvokedAt = ui
  elseif ci < ui then
    out.invokedAt = ui
    if up == nil or ci > up then out.previousInvokedAt = ci end
  end
end
redis.call('SET', KEYS[1], cjson.encode(out), 'EX', ARGV[2])
return 1
`;

// Best-effort, fail-open. Called by the cron route after a successful run.
//
// OPS-01.1: the write is ONE atomic Redis operation (an EVAL of the Lua above,
// a documented method on the installed @upstash/redis client). There is no
// separate client-side read to race, so:
//   * recency and the cadence point are monotonic under overlapping runs;
//   * Redis completion order cannot determine heartbeat ordering — invocation
//     timestamps do;
//   * "failing to obtain prior evidence" cannot suppress this run's recency,
//     because the prior value is read inside the same atomic step and an
//     unreadable/corrupt current value simply stores the candidate.
export async function recordReminderRunSuccess(
  heartbeat: ReminderHeartbeat,
): Promise<void> {
  try {
    const redis = getRedis();
    if (!redis) return;
    await redis.eval(
      HEARTBEAT_MERGE_LUA,
      [HEARTBEAT_KEY],
      [JSON.stringify(heartbeat), String(HEARTBEAT_TTL_SECONDS)],
    );
  } catch {
    // A heartbeat write must never break the reminder run.
  }
}

// Read the last-success heartbeat for the admin console. Returns null when
// Upstash is unconfigured/unreachable or no run has been recorded.
export async function readReminderHeartbeat(): Promise<ReminderHeartbeat | null> {
  try {
    const redis = getRedis();
    if (!redis) return null;
    const raw = await redis.get<ReminderHeartbeat | string>(HEARTBEAT_KEY);
    if (!raw) return null;
    // The Upstash client usually deserializes JSON; tolerate a string too.
    const hb = typeof raw === "string" ? (JSON.parse(raw) as ReminderHeartbeat) : raw;
    return hb && typeof hb.at === "string" ? hb : null;
  } catch {
    return null;
  }
}

export type ReminderSchedulerHealth =
  | "healthy"
  | "degraded"
  | "stale"
  | "missing";

// Whether the stored heartbeat actually carried inter-run evidence. "measured"
// means observedIntervalMinutes came from two real successful runs; "unavailable"
// means the classifier had ONLY recency to go on and must not imply otherwise.
export type ReminderCadenceEvidence = "measured" | "unavailable";

// Which axis drove an unhealthy status. Carried so the admin card and the ops
// alert can describe the ACTUAL cause: a cadence-only failure (last success 10
// minutes ago, but 40 minutes between the last two runs) must not be reported
// as "last success was over 30 minutes ago", which contradicts the displayed
// age and sends the operator to the wrong place.
export type ReminderFailingAxis = "recency" | "cadence" | "both";

export type ReminderSchedulerStatus = {
  status: ReminderSchedulerHealth;
  lastSuccessAt: string | null;
  ageMinutes: number | null;
  // OPS-01.1: real inter-run evidence, null when unavailable/corrupt.
  // Invocation timestamps drive the cadence axis; null when unavailable.
  invokedAt: string | null;
  previousInvokedAt: string | null;
  observedIntervalMinutes: number | null;
  cadenceEvidence: ReminderCadenceEvidence;
  // null when healthy/missing; otherwise the axis (or axes) that failed.
  failingAxis: ReminderFailingAxis | null;
  cadenceMinutes: number;
  degradedAfterMinutes: number;
  staleAfterMinutes: number;
};

// Rank so the WORSE of two conditions can be selected without an if-ladder.
const HEALTH_RANK: Record<ReminderSchedulerHealth, number> = {
  healthy: 0,
  degraded: 1,
  stale: 2,
  missing: 3,
};

function worseHealth(
  a: ReminderSchedulerHealth,
  b: ReminderSchedulerHealth,
): ReminderSchedulerHealth {
  return HEALTH_RANK[a] >= HEALTH_RANK[b] ? a : b;
}

// One shared band, applied to BOTH recency and observed interval so the two
// axes can never drift apart.
//
// OPS-01.1 (review 3775029882): classify the RAW elapsed milliseconds, never a
// rounded minute count. `Math.round` pulled 30:01-30:29 back to 30 and
// 45:01-45:29 back to 45, so an interval that genuinely exceeds the threshold
// could still read healthy — or dodge the stale/critical escalation and its
// operator email. The reminder-window invariant is about the real elapsed time,
// so the comparison is too; rounding is for DISPLAY only.
function classifyElapsedMs(ms: number): ReminderSchedulerHealth {
  if (ms <= REMINDER_DEGRADED_AFTER_MINUTES * 60_000) return "healthy";
  if (ms <= REMINDER_STALE_AFTER_MINUTES * 60_000) return "degraded";
  return "stale";
}

// Pure, deterministic classifier — the testable core. `nowMs` is injected so
// tests are time-independent.
//
// OPS-01.1 (review 3774540589). Health is now the WORSE of two independent
// conditions, because recency alone is not evidence of cadence:
//
//   A. RECENCY  — minutes since the latest successful run.
//   B. CADENCE  — minutes between the latest TWO successful runs.
//
// The finding's example is exactly why B is required. A scheduler firing at
// 07:50 / 08:30 / 09:10 / 09:50 is running a 40-minute cadence — wide enough to
// miss appointment offsets in the 30-minute 2h window — yet health checks at
// 08:00 / 09:00 / 09:30 see ages of only 10 / 30 / 20 minutes and would each
// report "healthy". Sampling recency can never expose the gap BETWEEN runs; only
// a stored previous-success timestamp can.
//
//   healthy:  both axes within REMINDER_DEGRADED_AFTER_MINUTES (2x cadence)
//   degraded: either axis past that but within REMINDER_STALE_AFTER_MINUTES
//   stale:    either axis past REMINDER_STALE_AFTER_MINUTES
//   missing:  no (valid) heartbeat recorded
//
// When cadence evidence is absent or corrupt (a pre-hotfix heartbeat, an
// unparseable or mis-ordered invocation pair) the classifier falls back to
// recency ONLY and reports cadenceEvidence: "unavailable". It never fabricates
// an interval and never implies cadence was proven. No fifth status is added —
// the honest signal is carried by cadenceEvidence + a null interval, which the
// admin card and safe_details both surface.
export function computeReminderSchedulerStatus(
  heartbeat: ReminderHeartbeat | null,
  nowMs: number,
): ReminderSchedulerStatus {
  const base = {
    cadenceMinutes: CRON_INTERVAL_MINUTES,
    degradedAfterMinutes: REMINDER_DEGRADED_AFTER_MINUTES,
    staleAfterMinutes: REMINDER_STALE_AFTER_MINUTES,
  };
  const parsed = heartbeat?.at ? Date.parse(heartbeat.at) : NaN;
  if (Number.isNaN(parsed)) {
    return {
      status: "missing",
      lastSuccessAt: null,
      ageMinutes: null,
      invokedAt: null,
      previousInvokedAt: null,
      observedIntervalMinutes: null,
      cadenceEvidence: "unavailable",
      failingAxis: null,
      ...base,
    };
  }
  // Raw elapsed time drives classification; the rounded value is for display.
  const ageMs = Math.max(0, nowMs - parsed);
  const ageMinutes = Math.round(ageMs / 60000);

  // CADENCE axis — measured between the two most recent successful
  // INVOCATIONS (review 3775042692). Completion times are deliberately not used
  // here: a run that starts late but finishes fast would otherwise look on
  // time, and a slow run would make an on-time scheduler look late.
  //
  // Trusted only when BOTH invocation timestamps parse and are correctly
  // ordered. A legacy heartbeat has neither field, so cadence reads
  // "unavailable" for one cycle rather than being invented from `at`.
  const invRaw = heartbeat?.invokedAt;
  const prevInvRaw = heartbeat?.previousInvokedAt;
  const invParsed = invRaw ? Date.parse(invRaw) : NaN;
  const prevInvParsed = prevInvRaw ? Date.parse(prevInvRaw) : NaN;
  const cadenceMeasured =
    !Number.isNaN(invParsed) &&
    !Number.isNaN(prevInvParsed) &&
    prevInvParsed <= invParsed;
  const intervalMs = cadenceMeasured
    ? Math.max(0, invParsed - prevInvParsed)
    : null;
  const observedIntervalMinutes =
    intervalMs === null ? null : Math.round(intervalMs / 60000);

  const recencyStatus = classifyElapsedMs(ageMs);
  const cadenceStatus = intervalMs === null ? null : classifyElapsedMs(intervalMs);
  const status =
    cadenceStatus === null ? recencyStatus : worseHealth(recencyStatus, cadenceStatus);

  // Attribute the failure so downstream copy can name the real cause.
  const recencyFailed = recencyStatus !== "healthy";
  const cadenceFailed = cadenceStatus !== null && cadenceStatus !== "healthy";
  const failingAxis: ReminderFailingAxis | null =
    status === "healthy"
      ? null
      : recencyFailed && cadenceFailed
        ? "both"
        : cadenceFailed
          ? "cadence"
          : "recency";

  return {
    status,
    lastSuccessAt: heartbeat!.at,
    ageMinutes,
    invokedAt: invRaw && !Number.isNaN(invParsed) ? invRaw : null,
    previousInvokedAt: cadenceMeasured ? prevInvRaw! : null,
    observedIntervalMinutes,
    cadenceEvidence: cadenceMeasured ? "measured" : "unavailable",
    failingAxis,
    ...base,
  };
}

// ---------------------------------------------------------------------------
// PR #283. Deduped ops alert for a stale/missing reminder scheduler.
// ---------------------------------------------------------------------------
//
// PR #265 made the external-scheduler health observable (the admin
// "Reminder scheduler" card), but the signal stayed PASSIVE — an operator
// only learns the scheduler stopped if they happen to open /admin. This
// records an ops alert so a dead scheduler becomes actionable (and, for the
// missing case, emails OPS_ALERT_EMAILS via the critical path).
//
// Where this runs (PR #283): the EXISTING daily `materialize-recurring-
// breaks` Vercel cron, NOT the admin page render (a render-time write is an
// anti-pattern and would only fire when an operator is already looking) and
// NOT the appointment-reminders route (a dead scheduler never calls it, so
// it cannot self-report). The daily cron runs automatically, independent of
// the external scheduler, so a stale/missing scheduler is detected within
// ~24h without a new job/route/migration. The always-on admin card remains
// the real-time read-only view.
//
// Dedupe: skip if an UNRESOLVED ops_alerts row already exists for the same
// event. An unresolved alert means the operator has not yet handled this
// outage; do not pile on a duplicate each daily run. No auto-resolve — the
// operator resolves manually (admin ops-alerts page) after fixing the
// scheduler, matching every other ops alert.
//
// Non-sensitive ONLY: safe_details carry status + timing scalars. NEVER the
// CRON_SECRET, an Authorization header, client phone/email/PII, reminder
// contents, or a provider payload.

const REMINDER_SCHEDULER_DEGRADED_EVENT = "reminder_scheduler_degraded";
const REMINDER_SCHEDULER_STALE_EVENT = "reminder_scheduler_stale";
const REMINDER_SCHEDULER_MISSING_EVENT = "reminder_scheduler_missing";
const HEALTH_ALERT_ROUTE =
  "lib/cron/reminder-heartbeat:recordReminderSchedulerHealthAlert";

export type ReminderSchedulerHealthAlertResult = {
  status: ReminderSchedulerHealth;
  // true when this call recorded a NEW ops alert.
  alerted: boolean;
  // true when an unhealthy status was suppressed by an existing unresolved
  // alert for the same event (dedupe hit).
  deduped: boolean;
};

// Decision plan: whether to record + which event/severity. Returned by the
// pure decider so the side-effecting wrapper just executes it.
export type ReminderSchedulerAlertEvent =
  | typeof REMINDER_SCHEDULER_DEGRADED_EVENT
  | typeof REMINDER_SCHEDULER_STALE_EVENT
  | typeof REMINDER_SCHEDULER_MISSING_EVENT;

export type ReminderSchedulerAlertPlan =
  | { shouldAlert: false; reason: "healthy" | "deduped" }
  | {
      shouldAlert: true;
      event: ReminderSchedulerAlertEvent;
      severity: "warning" | "critical";
    };

// The event each unhealthy status records. Exported so the caller and the
// tests share one mapping instead of restating it.
export function reminderSchedulerAlertEventFor(
  status: ReminderSchedulerHealth,
): ReminderSchedulerAlertEvent | null {
  switch (status) {
    case "healthy":
      return null;
    case "degraded":
      return REMINDER_SCHEDULER_DEGRADED_EVENT;
    case "stale":
      return REMINDER_SCHEDULER_STALE_EVENT;
    case "missing":
      return REMINDER_SCHEDULER_MISSING_EVENT;
  }
}

export type ReminderAlertSeverity = "warning" | "critical";

// Explicit ordering. Scheduler alerts use only these two levels, and the
// dedupe rule below depends on the comparison being stated rather than implied.
const SEVERITY_RANK: Record<ReminderAlertSeverity, number> = {
  warning: 0,
  critical: 1,
};

export function isAtLeastAsSevere(
  existing: ReminderAlertSeverity,
  desired: ReminderAlertSeverity,
): boolean {
  return SEVERITY_RANK[existing] >= SEVERITY_RANK[desired];
}

// The severity of the strongest UNRESOLVED alert already open for the event,
// or null when none is open (or the lookup failed — see the caller).
export type ExistingUnresolvedAlert = { severity: ReminderAlertSeverity } | null;

// Pure, deterministic decision — the testable core. Given the computed status
// and the strongest UNRESOLVED ops alert already open for the matching event,
// decide whether to record a new one.
//   healthy                          -> no alert
//   degraded + nothing open          -> warning  reminder_scheduler_degraded
//   stale + nothing open             -> CRITICAL reminder_scheduler_stale
//   missing + nothing open           -> CRITICAL reminder_scheduler_missing
//   open alert >= desired severity   -> no alert (deduped)
//   open alert <  desired severity   -> RECORD the escalation
//
// PR OPS-01: `stale` is CRITICAL, not warning. recordOpsAlert only emails
// OPS_ALERT_EMAILS for critical severity, so the previous warning meant a dead
// scheduler produced no operator email until the 24h heartbeat TTL expired the
// key into `missing` — up to ~48h of silence. `degraded` stays a warning on
// purpose: it is the early cadence signal (row + admin card), and paging on it
// would train operators to ignore the channel.
//
// OPS-01.1 (review 3774540599): dedupe is SEVERITY-AWARE. Deduping on
// "same event AND unresolved" alone was correct only while an event had exactly
// one severity forever. OPS-01 changed `reminder_scheduler_stale` from warning
// to critical, so any warning-severity stale row left unresolved from before
// that change would have silently swallowed the first real critical escalation
// — and with it the OPS_ALERT_EMAILS notification the escalation exists to
// send. A lower-severity open row must never suppress a higher-severity alert.
// The legacy warning is deliberately NOT auto-resolved: rewriting operator-owned
// history to make a check pass would be worse than letting the critical row sit
// alongside it, and the operator resolves both from the same admin page.
export function decideReminderSchedulerAlert(
  status: ReminderSchedulerStatus,
  existingUnresolved: ExistingUnresolvedAlert,
): ReminderSchedulerAlertPlan {
  const event = reminderSchedulerAlertEventFor(status.status);
  if (event === null) {
    return { shouldAlert: false, reason: "healthy" };
  }
  const severity: ReminderAlertSeverity =
    status.status === "degraded" ? "warning" : "critical";
  if (existingUnresolved && isAtLeastAsSevere(existingUnresolved.severity, severity)) {
    return { shouldAlert: false, reason: "deduped" };
  }
  return { shouldAlert: true, event, severity };
}

// Pure builder for the alert's safe_details. NON-SENSITIVE scalars only —
// status + timing. Intentionally carries NO CRON_SECRET, Authorization
// header, client phone/email/PII, reminder contents, or provider payload.
export function reminderSchedulerAlertSafeDetails(
  status: ReminderSchedulerStatus,
  nowMs: number,
): Record<string, unknown> {
  return {
    status: status.status,
    last_success_at: status.lastSuccessAt,
    age_minutes: status.ageMinutes,
    // OPS-01.1: non-sensitive timing scalars only — two ISO timestamps and an
    // integer minute count. No identifiers, no reminder content, no secrets.
    invoked_at: status.invokedAt,
    previous_invoked_at: status.previousInvokedAt,
    observed_interval_minutes: status.observedIntervalMinutes,
    cadence_evidence: status.cadenceEvidence,
    failing_axis: status.failingAxis,
    cadence_minutes: status.cadenceMinutes,
    degraded_after_minutes: status.degradedAfterMinutes,
    stale_after_minutes: status.staleAfterMinutes,
    checked_at: new Date(nowMs).toISOString(),
  };
}

// OPS-01.1 (review 3774838345): the message must name the axis that ACTUALLY
// failed. A cadence-only failure (last success 10 minutes ago, but 40 minutes
// between the last two runs) previously read "last success was over 30 minutes
// ago", which contradicted the age in the same alert and pointed the operator
// at the wrong symptom.
function reminderSchedulerAlertMessage(
  status: ReminderSchedulerStatus,
): string {
  const remedy =
    "Check the external scheduler (cron-job.org), the CRON_SECRET configuration, and recent Vercel logs; resolve this alert after the scheduler is confirmed healthy.";
  if (status.status === "missing") {
    return `The external appointment-reminder scheduler has no recorded successful run (missing heartbeat). Appointment reminders may be silently stopped. ${remedy}`;
  }
  const cause =
    status.failingAxis === "cadence"
      ? `the last two successful runs were ${status.observedIntervalMinutes} minutes apart (the most recent was only ${status.ageMinutes} minutes ago, so the scheduler is still firing — just too slowly)`
      : status.failingAxis === "both"
        ? `the last successful run was ${status.ageMinutes} minutes ago AND the last two runs were ${status.observedIntervalMinutes} minutes apart`
        : `the last successful run was ${status.ageMinutes} minutes ago`;
  const impact =
    "The 2h reminder window is only as wide as twice the expected cadence, so at this rate some appointments can stop receiving a 2h reminder.";
  return status.status === "degraded"
    ? `The external appointment-reminder scheduler is not meeting its required cadence: ${cause}. ${impact} ${remedy}`
    : `The external appointment-reminder scheduler is failing its cadence contract: ${cause}. Appointment reminders may be delayed or stopped. ${remedy}`;
}

// Best-effort, fail-open. Reads the heartbeat, classifies, and records ONE
// deduped ops alert when the scheduler is degraded/stale/missing. Never throws
// — a health-check failure must never break the daily cron that calls it.
// `nowMs` is injected so tests are time-independent.
//
// SAFE TO CALL FROM SEVERAL DAILY CRONS. The dedupe below keys on an
// UNRESOLVED ops_alerts row for the same event, so the 08:00, 09:00 and 09:30
// UTC checks record at most ONE alert per outage per event — the second and
// third callers of the day dedupe. This is what makes the monitor survive any
// single daily cron route failing.
export async function recordReminderSchedulerHealthAlert(
  nowMs: number = Date.now(),
): Promise<ReminderSchedulerHealthAlertResult> {
  // readReminderHeartbeat is itself fail-open (returns null on any error)
  // and computeReminderSchedulerStatus is pure, so status is always safely
  // computed; null/unconfigured reads as "missing".
  const status = computeReminderSchedulerStatus(
    await readReminderHeartbeat(),
    nowMs,
  );
  if (status.status === "healthy") {
    return { status: "healthy", alerted: false, deduped: false };
  }
  // Narrowed to the unhealthy states, so the event mapping is total.
  const unhealthy: "degraded" | "stale" | "missing" = status.status;
  const event = reminderSchedulerAlertEventFor(unhealthy) as ReminderSchedulerAlertEvent;

  // Dedupe on an existing UNRESOLVED alert for this exact event.
  //
  // OPS-01.1 (review 3774540599): the SEVERITY is read too, and the strongest
  // open row wins. Selecting only `id` made every unresolved row look
  // equivalent, so a legacy warning-severity `reminder_scheduler_stale` row
  // (the severity this event used before OPS-01) would suppress the new
  // critical escalation and its OPS_ALERT_EMAILS notification.
  //
  // On a read error, fall through (null = nothing open) and record —
  // recordOpsAlert is fail-open; a rare duplicate beats silently dropping a
  // scheduler-down alert.
  let existingUnresolved: ExistingUnresolvedAlert = null;
  try {
    const admin = createAdminClient();
    const { data: existing } = await admin
      .from("ops_alerts")
      .select("id, severity")
      .eq("event", event)
      .is("resolved_at", null);
    // Strongest open row decides: one critical anywhere in the set dedupes a
    // critical; only warnings open means a critical still escalates.
    const severities = (existing ?? [])
      .map((row) => (row as { severity?: string }).severity)
      .filter((s): s is ReminderAlertSeverity => s === "warning" || s === "critical");
    if (severities.length > 0) {
      existingUnresolved = {
        severity: severities.includes("critical") ? "critical" : "warning",
      };
    }
  } catch {
    existingUnresolved = null;
  }

  const plan = decideReminderSchedulerAlert(status, existingUnresolved);
  if (!plan.shouldAlert) {
    return {
      status: status.status,
      alerted: false,
      deduped: plan.reason === "deduped",
    };
  }

  await recordOpsAlert({
    severity: plan.severity,
    event: plan.event,
    message: reminderSchedulerAlertMessage(status),
    route: HEALTH_ALERT_ROUTE,
    safeDetails: reminderSchedulerAlertSafeDetails(status, nowMs),
  });
  return { status: status.status, alerted: true, deduped: false };
}
