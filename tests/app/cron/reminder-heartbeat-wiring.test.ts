import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #265. Source-grep pins for the reminder-scheduler status signal:
//   * the cron route records the success heartbeat ONLY on the authorized
//     path (after the CRON_SECRET gate), so an unauthorized 401 records
//     nothing, and only after the passes complete (inside the try, so a
//     thrown run records cron_route_failed instead);
//   * the heartbeat payload + module carry NO secret / PII (no CRON_SECRET,
//     email, phone, name, token, notes);
//   * the heartbeat is best-effort/fail-open and reuses Upstash (no migration,
//     no new dependency);
//   * the admin console surfaces the status (operator-only).

const REPO_ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string): string =>
  readFileSync(path.join(REPO_ROOT, rel), "utf8");

const ROUTE = read("app/api/cron/appointment-reminders/route.ts");
const HEARTBEAT = read("lib/cron/reminder-heartbeat.ts");
const ADMIN = read("app/admin/page.tsx");
const MATERIALIZE = read("app/api/cron/materialize-recurring-breaks/route.ts");
const RECONCILE = read("app/api/cron/calendar-reconcile/route.ts");
const SYNC = read("app/api/cron/calendar-sync/route.ts");
const ALERTS = read("lib/ops/alerts.ts");
const SCHEDULE = read("lib/cron/reminder-schedule.ts");

// Every Vercel-scheduled cron that must independently evaluate reminder health.
const INDEPENDENT_MONITOR_ROUTES: ReadonlyArray<readonly [string, string]> = [
  ["materialize-recurring-breaks", MATERIALIZE],
  ["calendar-reconcile", RECONCILE],
  ["calendar-sync", SYNC],
];

// Strip comments so doc-comments that ENUMERATE forbidden fields (e.g. "never
// store email/phone/notes") don't trip the PII checks below.
const codeOnly = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");

describe("cron route records the heartbeat on the authorized success path only", () => {
  it("calls recordReminderRunSuccess after the auth gate (401 records nothing)", () => {
    const gate = ROUTE.indexOf("isAuthorizedCronRequest(req)");
    const hb = ROUTE.indexOf("recordReminderRunSuccess(");
    expect(gate).toBeGreaterThan(-1);
    expect(hb).toBeGreaterThan(gate);
  });

  it("records the heartbeat before the ok:true return, after the passes", () => {
    const hb = ROUTE.indexOf("recordReminderRunSuccess(");
    const okReturn = ROUTE.indexOf("ok: true");
    expect(hb).toBeGreaterThan(-1);
    expect(okReturn).toBeGreaterThan(hb);
  });

  it("the heartbeat payload carries only non-sensitive aggregate counts", () => {
    const block =
      ROUTE.match(/recordReminderRunSuccess\(\{[\s\S]*?\}\);/)?.[0] ?? "";
    expect(block).not.toBe("");
    expect(block).toMatch(/\bat:/);
    // Aggregate counts only.
    expect(block).toMatch(/emailAttempted|smsAttempted/);
    // No PII / secret leaks in the payload.
    expect(block).not.toMatch(/email\b|phone|\bname\b|notes|token|CRON_SECRET|client/i);
  });
});

describe("heartbeat module is fail-open, secret-free, and migration-free", () => {
  it("reuses Upstash (no new dependency, no DB migration)", () => {
    expect(HEARTBEAT).toMatch(/@upstash\/redis/);
    expect(HEARTBEAT).toMatch(/UPSTASH_REDIS_REST_URL/);
    expect(HEARTBEAT).toMatch(/UPSTASH_REDIS_REST_TOKEN/);
  });

  it("is best-effort/fail-open (write + read wrapped, never throws)", () => {
    expect(HEARTBEAT).toMatch(/try\s*\{[\s\S]*?\}\s*catch/);
    // The write helper returns early when Upstash is unconfigured.
    expect(HEARTBEAT).toMatch(/if \(!redis\) return/);
  });

  it("never reads the CRON_SECRET value or references client PII (code, not comments)", () => {
    const code = codeOnly(HEARTBEAT);
    expect(code).not.toMatch(/process\.env\.CRON_SECRET/);
    expect(code).not.toMatch(/\bemail\b|\bphone\b|\bnotes\b|cancellation_token/i);
  });

  it("derives the stale threshold from the shared cadence constant", () => {
    expect(HEARTBEAT).toMatch(/CRON_INTERVAL_MINUTES/);
    expect(HEARTBEAT).toMatch(/REMINDER_STALE_AFTER_MINUTES/);
  });
});

describe("admin console surfaces the scheduler status (operator-only)", () => {
  it("reads the heartbeat and renders the status card", () => {
    expect(ADMIN).toMatch(/readReminderHeartbeat/);
    expect(ADMIN).toMatch(/computeReminderSchedulerStatus/);
    expect(ADMIN).toMatch(/ReminderSchedulerCard/);
  });

  it("classifies healthy/stale/missing and names the external scheduler", () => {
    expect(ADMIN).toMatch(/healthy/);
    expect(ADMIN).toMatch(/stale/);
    expect(ADMIN).toMatch(/missing/);
    expect(ADMIN).toMatch(/external scheduler/i);
  });

  it("does NOT record/alert on render — the admin page only reads + classifies (no write-on-render)", () => {
    // The health-alert recorder must not run during admin page render.
    expect(ADMIN).not.toMatch(/recordReminderSchedulerHealthAlert/);
  });
});

// ---------------------------------------------------------------------------
// PR #283. The stale/missing reminder-scheduler ops alert + its wiring onto
// the EXISTING daily materialize-recurring-breaks cron.
// ---------------------------------------------------------------------------
describe("reminder-scheduler health alert function (lib/cron/reminder-heartbeat.ts)", () => {
  it("dedupes on an UNRESOLVED ops_alerts row for the same event", () => {
    expect(HEARTBEAT).toMatch(/\.from\("ops_alerts"\)/);
    expect(HEARTBEAT).toMatch(/\.is\("resolved_at", null\)/);
  });

  it("uses the three event names (degraded/stale/missing)", () => {
    expect(HEARTBEAT).toContain("reminder_scheduler_degraded");
    expect(HEARTBEAT).toContain("reminder_scheduler_stale");
    expect(HEARTBEAT).toContain("reminder_scheduler_missing");
    // Both severities are still reachable; the exact mapping is pinned by the
    // dedicated ternary assertion below.
    expect(HEARTBEAT).toMatch(/"warning"/);
    expect(HEARTBEAT).toMatch(/"critical"/);
  });

  // PR OPS-01. The severity split is the whole point of the escalation: only
  // `critical` reaches OPS_ALERT_EMAILS (lib/ops/alerts.ts gates the email on
  // severity === "critical"), so `stale` must NOT be a warning.
  it("severity is chosen from the status, with degraded the ONLY warning", () => {
    expect(HEARTBEAT).toMatch(
      /const severity: ReminderAlertSeverity =\s*\n?\s*status\.status === "degraded" \? "warning" : "critical";/,
    );
  });

  it("only critical severity is emailed by the ops-alert pipeline (the reason stale escalates)", () => {
    expect(ALERTS).toMatch(/if \(input\.severity === "critical"\)/);
    expect(ALERTS).toMatch(/notifyCriticalOpsAlert/);
  });

  it("is best-effort/fail-open and returns a result (never throws to the caller)", () => {
    // The dedupe read is wrapped in try/catch and the function returns a
    // typed result rather than throwing.
    expect(HEARTBEAT).toMatch(/Promise<ReminderSchedulerHealthAlertResult>/);
    expect(HEARTBEAT).toMatch(/try\s*\{[\s\S]*?\}\s*catch/);
  });

  it("does NOT auto-resolve (no resolved_at write back from the health check)", () => {
    // Operator resolves manually. The function only SELECTs resolved_at; it
    // must not UPDATE/insert resolved_at.
    const code = codeOnly(HEARTBEAT);
    expect(code).not.toMatch(/resolved_at:\s/); // no resolved_at write payload
    expect(code).not.toMatch(/\.update\(/);
  });

  it("never reads CRON_SECRET or includes PII/reminder content in the alert (code, not comments)", () => {
    const code = codeOnly(HEARTBEAT);
    expect(code).not.toMatch(/process\.env\.CRON_SECRET/);
    expect(code).not.toMatch(/authorization/i);
    // safe_details builder keys are timing-only.
    expect(HEARTBEAT).toMatch(/reminderSchedulerAlertSafeDetails/);
    const builder =
      HEARTBEAT.match(
        /reminderSchedulerAlertSafeDetails\([\s\S]*?\)\s*:\s*Record<string, unknown>\s*\{[\s\S]*?\n\}/,
      )?.[0] ?? "";
    expect(builder).not.toMatch(/\bemail\b|\bphone\b|\bname\b|notes|token|reminder_text|body|message/i);
  });
});

describe("daily materialize cron runs the health check best-effort (PR #283)", () => {
  it("imports + calls recordReminderSchedulerHealthAlert", () => {
    expect(MATERIALIZE).toMatch(
      /import \{ recordReminderSchedulerHealthAlert \} from "@\/lib\/cron\/reminder-heartbeat"/,
    );
    expect(MATERIALIZE).toMatch(/await recordReminderSchedulerHealthAlert\(\)/);
  });

  it("wraps the health check in try/catch so its failure cannot break the daily cron", () => {
    expect(MATERIALIZE).toMatch(
      /try\s*\{\s*await recordReminderSchedulerHealthAlert\(\);\s*\}\s*catch/,
    );
  });

  it("runs the check AFTER the auth gate (an unauthorized 401 records nothing)", () => {
    const gate = MATERIALIZE.indexOf("isAuthorizedCronRequest(req)");
    const check = MATERIALIZE.indexOf("recordReminderSchedulerHealthAlert(");
    expect(gate).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(gate);
  });

  it("does NOT send reminders or call the appointment-reminders route", () => {
    // Code only — a comment may legitimately name the route it deliberately
    // does NOT call.
    const code = codeOnly(MATERIALIZE);
    expect(code).not.toMatch(/appointment-reminders/);
    expect(code).not.toMatch(/recordReminderRunSuccess/);
    expect(code).not.toMatch(/sendReminder|send_email|sendSms|twilio|resend/i);
  });
});

// ---------------------------------------------------------------------------
// PR OPS-01. Failure-independent, multi-caller reminder-scheduler monitoring.
//
// The external cron-job.org scheduler is the ONLY thing that fires the reminder
// route, and it is invisible to this repository. The only in-app way to notice
// it has died is a Vercel-scheduled cron evaluating the heartbeat. Two defects
// made that detector weaker than it looked:
//   1. it ran at the END of the materialize happy path, so the earlier
//      `return 500` on a rule-lookup failure skipped it for the whole day;
//   2. it had exactly ONE caller, so that single cron was a silent SPOF.
// ---------------------------------------------------------------------------
describe("health check is failure-independent inside materialize (PR OPS-01)", () => {
  it("runs from a `finally`, not from the happy path only", () => {
    expect(MATERIALIZE).toMatch(
      /\}\s*finally\s*\{[\s\S]*?await recordReminderSchedulerHealthAlert\(\)/,
    );
  });

  // The regression: an early `return NextResponse.json(..., { status: 500 })`
  // on the rule-lookup failure must NOT skip the health evaluation. Positional
  // proof — the check must sit after that early return in the source, and in a
  // `finally`, which is the only construct that still runs on that path.
  it("the early rule-lookup 500 return does not bypass the health check", () => {
    const earlyReturn = MATERIALIZE.indexOf('stage: "rule_lookup"');
    const finallyIdx = MATERIALIZE.indexOf("} finally {");
    const check = MATERIALIZE.indexOf("recordReminderSchedulerHealthAlert(");
    expect(earlyReturn).toBeGreaterThan(-1);
    expect(finallyIdx).toBeGreaterThan(earlyReturn);
    expect(check).toBeGreaterThan(finallyIdx);
  });

  // A `finally` only overrides the route's real result if it completes
  // abruptly. Pin that this one cannot: no `return` and no `throw` inside it.
  it("the finally block cannot convert the route's real result into a false success", () => {
    const finallyBlock =
      MATERIALIZE.slice(MATERIALIZE.indexOf("} finally {")) ?? "";
    const code = codeOnly(finallyBlock);
    expect(code).not.toMatch(/\breturn\b/);
    expect(code).not.toMatch(/\bthrow\b/);
    // and the health call itself is caught, so it cannot escape the finally
    expect(finallyBlock).toMatch(
      /try\s*\{\s*await recordReminderSchedulerHealthAlert\(\);\s*\}\s*catch/,
    );
  });

  it("a health-check failure is observable, not silently swallowed", () => {
    expect(MATERIALIZE).toMatch(/reminder_scheduler_health_check_threw/);
  });

  it("the failure log carries no secret or PII", () => {
    // Code only: the comment above the logger legitimately NAMES the things it
    // must never log ("no CRON_SECRET, no PII"), which would otherwise trip
    // this grep — the same reason codeOnly() exists for every other PII pin.
    const block = codeOnly(
      MATERIALIZE.slice(MATERIALIZE.indexOf("} finally {")),
    );
    expect(block).not.toMatch(/CRON_SECRET|authorization|bearer/i);
    expect(block).not.toMatch(/\bemail\b|\bphone\b|client_id|\bnotes\b/i);
  });
});

describe("several independent Vercel crons evaluate reminder health (PR OPS-01)", () => {
  it.each(INDEPENDENT_MONITOR_ROUTES)(
    "%s imports and awaits the shared health helper",
    (_name, src) => {
      expect(src).toMatch(
        /import \{ recordReminderSchedulerHealthAlert \} from "@\/lib\/cron\/reminder-heartbeat"/,
      );
      expect(src).toMatch(/await recordReminderSchedulerHealthAlert\(\)/);
    },
  );

  it.each(INDEPENDENT_MONITOR_ROUTES)(
    "%s wraps the call so a health failure cannot break that cron",
    (_name, src) => {
      expect(src).toMatch(
        /try\s*\{\s*await recordReminderSchedulerHealthAlert\(\);\s*\}\s*catch/,
      );
    },
  );

  it.each(INDEPENDENT_MONITOR_ROUTES)(
    "%s never sends a reminder or calls the reminder route",
    (_name, src) => {
      const code = codeOnly(src);
      expect(code).not.toMatch(/appointment-reminders/);
      expect(code).not.toMatch(/recordReminderRunSuccess/);
    },
  );

  // Detection must survive ANY single one of these routes failing or being
  // unregistered. Fewer than two callers reinstates the single point of failure.
  it("at least three independent scheduled callers exist (no single point of failure)", () => {
    const callers = INDEPENDENT_MONITOR_ROUTES.filter(([, src]) =>
      /await recordReminderSchedulerHealthAlert\(\)/.test(src),
    );
    expect(callers.length).toBeGreaterThanOrEqual(3);
  });

  // Each caller must be a cron Vercel actually runs, otherwise it is decoration.
  it("every monitor caller is a registered vercel.json cron", () => {
    const crons: Array<{ path: string; schedule: string }> = JSON.parse(
      read("vercel.json"),
    ).crons;
    const paths = new Set(crons.map((c) => c.path));
    for (const [name] of INDEPENDENT_MONITOR_ROUTES) {
      expect(paths.has(`/api/cron/${name}`)).toBe(true);
    }
  });

  // calendar-sync authenticates inside the worker seam, so it has no local
  // gate to sit behind; it must gate on the seam's own 401 instead.
  it("calendar-sync only evaluates health after the seam authorized the request", () => {
    expect(SYNC).toMatch(/if \(status !== 401\)/);
    const gate = SYNC.indexOf("status !== 401");
    const check = SYNC.indexOf("recordReminderSchedulerHealthAlert(");
    expect(gate).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(gate);
  });

  it("calendar-reconcile evaluates health after its own auth gate", () => {
    const gate = RECONCILE.indexOf("isAuthorizedCronRequest(req)");
    const check = RECONCILE.indexOf("recordReminderSchedulerHealthAlert(");
    expect(gate).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(gate);
  });

  // Three callers per day must still produce ONE alert per outage. The dedupe
  // is the mechanism; pin that it is still keyed on an unresolved row.
  it("multiple callers stay non-spammy via the unresolved-row dedupe", () => {
    expect(HEARTBEAT).toMatch(/\.eq\("event", event\)/);
    expect(HEARTBEAT).toMatch(/\.is\("resolved_at", null\)/);
  });
});

describe("monitoring thresholds track the shipped cadence (PR OPS-01)", () => {
  it("both thresholds are derived from CRON_INTERVAL_MINUTES, not magic numbers", () => {
    expect(HEARTBEAT).toMatch(
      /REMINDER_DEGRADED_AFTER_MINUTES = CRON_INTERVAL_MINUTES \* 2/,
    );
    expect(HEARTBEAT).toMatch(
      /REMINDER_STALE_AFTER_MINUTES = CRON_INTERVAL_MINUTES \* 3/,
    );
  });

  it("the heartbeat module imports the cadence rather than restating 15", () => {
    expect(HEARTBEAT).toMatch(
      /import \{ CRON_INTERVAL_MINUTES \} from "@\/lib\/cron\/reminder-schedule"/,
    );
    // No bare 15-minute literal in the threshold code.
    const code = codeOnly(HEARTBEAT);
    expect(code).not.toMatch(/AFTER_MINUTES\s*=\s*\d+\s*;/);
  });

  it("the canonical cadence constant is still 15 minutes", () => {
    expect(SCHEDULE).toMatch(/CRON_INTERVAL_MINUTES = 15/);
    expect(SCHEDULE).toMatch(
      /APPOINTMENT_REMINDER_CRON_SCHEDULE = "\*\/15 \* \* \* \*"/,
    );
  });
});

describe("admin card renders all four states (PR OPS-01)", () => {
  it("labels degraded distinctly instead of falling through to Missing", () => {
    expect(ADMIN).toMatch(/"Degraded"/);
    expect(ADMIN).toMatch(/status\.status === "degraded"/);
  });

  it("still renders every other state", () => {
    for (const label of ["Healthy", "Stale", "Missing"]) {
      expect(ADMIN).toContain(`"${label}"`);
    }
  });

  it("surfaces both thresholds so the operator can see the contract", () => {
    expect(ADMIN).toMatch(/degradedAfterMinutes/);
    expect(ADMIN).toMatch(/staleAfterMinutes/);
  });
});

// ---------------------------------------------------------------------------
// OPS-01.1 — the two P1s from the #569 review, pinned at the wiring layer.
//   3774540589  measure cadence rather than only heartbeat recency
//   3774540599  do not dedupe critical stale alerts against legacy warnings
// ---------------------------------------------------------------------------
describe("OPS-01.1 P1-A/P2-A: the writer records real INVOCATION evidence", () => {
  it("the route passes its real invocation timestamp, not a post-processing one", () => {
    // startedAt is captured immediately after the auth gate, before any work.
    expect(ROUTE).toMatch(/const startedAt = Date\.now\(\);/);
    expect(ROUTE).toMatch(/invokedAt: new Date\(startedAt\)\.toISOString\(\)/);
    const gate = ROUTE.indexOf("isAuthorizedCronRequest(req)");
    const started = ROUTE.indexOf("const startedAt = Date.now();");
    expect(started).toBeGreaterThan(gate);
  });

  it("completion time remains the recency axis", () => {
    const block =
      ROUTE.match(/recordReminderRunSuccess\(\{[\s\S]*?\}\);/)?.[0] ?? "";
    expect(block).toMatch(/at: new Date\(\)\.toISOString\(\)/);
    expect(block).toMatch(/invokedAt:/);
  });

  it("the heartbeat type names invocation fields unambiguously", () => {
    expect(HEARTBEAT).toMatch(/invokedAt\?: string;/);
    expect(HEARTBEAT).toMatch(/previousInvokedAt\?: string;/);
    // the old, misleading name must be gone entirely
    expect(HEARTBEAT).not.toMatch(/previousSuccessAt/);
  });

  it("the classifier derives cadence from invocation timestamps only", () => {
    expect(HEARTBEAT).toMatch(/invParsed - prevInvParsed/);
    expect(HEARTBEAT).not.toMatch(/parsed - priorParsed/);
  });

  it("the write path stays best-effort/fail-open", () => {
    const fn =
      HEARTBEAT.match(
        /export async function recordReminderRunSuccess\([\s\S]*?\n\}/,
      )?.[0] ?? "";
    expect(fn).not.toBe("");
    expect(fn).toMatch(/try\s*\{/);
    expect(fn).toMatch(/catch/);
    expect(fn).toMatch(/if \(!redis\) return/);
  });

  it("the classifier consumes BOTH axes, not recency alone", () => {
    expect(HEARTBEAT).toMatch(/observedIntervalMinutes/);
    expect(HEARTBEAT).toMatch(/worseHealth\(recencyStatus/);
  });

  it("cadence evidence is explicit, never fabricated", () => {
    expect(HEARTBEAT).toMatch(/cadenceEvidence/);
    expect(HEARTBEAT).toMatch(/"measured"|"unavailable"/);
  });

  it("no new dependency and no database table for cadence", () => {
    const code = codeOnly(HEARTBEAT);
    expect(code).not.toMatch(/from "(?!@upstash\/redis|@\/lib|server-only)/);
    expect(code).not.toMatch(/create table|CREATE TABLE/i);
  });
});

describe("OPS-01.1 P2-B: the heartbeat write is ONE atomic operation", () => {
  it("uses an atomic EVAL, not a client-side read-then-write", () => {
    expect(HEARTBEAT).toMatch(/await redis\.eval\(/);
    expect(HEARTBEAT).toMatch(/HEARTBEAT_MERGE_LUA/);
    const fn =
      HEARTBEAT.match(
        /export async function recordReminderRunSuccess\([\s\S]*?\n\}/,
      )?.[0] ?? "";
    // no separate GET/SET pair to race
    expect(fn).not.toMatch(/redis\.get\(/);
    expect(fn).not.toMatch(/redis\.set\(/);
  });

  it("the Lua orders by INVOCATION, never by completion or arrival", () => {
    expect(HEARTBEAT).toMatch(/if ci > ui then/);
    expect(HEARTBEAT).toMatch(/elseif ci < ui then/);
  });

  it("the Lua keeps recency on the later completion", () => {
    expect(HEARTBEAT).toMatch(/cand\.at >= cur\.at/);
  });

  it("the Lua still applies the TTL", () => {
    expect(HEARTBEAT).toMatch(/'EX', ARGV\[2\]/);
  });

  it("an unreadable stored value still stores the current run", () => {
    expect(HEARTBEAT).toMatch(/if cur == nil then/);
  });

  it("the false read-then-write monotonicity claim is gone", () => {
    expect(HEARTBEAT).not.toMatch(/read-then-write keeps `at` monotonic/);
    expect(HEARTBEAT).toMatch(/was simply WRONG and has been removed/);
  });

  it("the pure merge is exported as the specification of the Lua", () => {
    expect(HEARTBEAT).toMatch(/export function mergeReminderHeartbeat/);
  });
});

describe("OPS-01.1 P1-B: dedupe reads severity, not just existence", () => {
  it("the unresolved-alert lookup selects severity", () => {
    expect(HEARTBEAT).toMatch(/\.select\("id, severity"\)/);
  });

  it("a critical open row anywhere in the set outranks warnings", () => {
    expect(HEARTBEAT).toMatch(/severities\.includes\("critical"\)/);
  });

  it("the decider compares severity rather than a bare boolean", () => {
    expect(HEARTBEAT).toMatch(/isAtLeastAsSevere\(existingUnresolved\.severity, severity\)/);
  });

  it("severity ordering is stated explicitly (warning < critical)", () => {
    expect(HEARTBEAT).toMatch(/SEVERITY_RANK/);
    expect(HEARTBEAT).toMatch(/warning: 0/);
    expect(HEARTBEAT).toMatch(/critical: 1/);
  });

  // D6 — a failed dedupe lookup must fail OPEN (record), never silently drop
  // a scheduler-down alert.
  it("D6 a read error falls open toward recording the alert", () => {
    // Slice to a STABLE end anchor. A non-greedy `\n  }` stops at the first
    // nested block close, which sits before the catch — the slice would then
    // silently exclude the very thing under test.
    const start = HEARTBEAT.indexOf("let existingUnresolved");
    const end = HEARTBEAT.indexOf("const plan = decideReminderSchedulerAlert");
    const block = start > -1 && end > start ? HEARTBEAT.slice(start, end) : "";
    expect(block).not.toBe("");
    expect(block).toMatch(/\}\s*catch\s*\{\s*existingUnresolved = null;/);
  });

  // The legacy row is operator-owned history; making a test pass by rewriting
  // it would be worse than letting the critical row sit beside it.
  it("does NOT auto-resolve the legacy warning row", () => {
    const code = codeOnly(HEARTBEAT);
    expect(code).not.toMatch(/resolved_at:\s/);
    expect(code).not.toMatch(/\.update\(/);
  });
});

describe("OPS-01.1 admin card surfaces measured cadence honestly", () => {
  it("shows the observed interval", () => {
    expect(ADMIN).toMatch(/observedIntervalMinutes/);
    expect(ADMIN).toMatch(/Observed cadence/);
  });

  it("says 'not yet measured' rather than implying a healthy cadence", () => {
    expect(ADMIN).toMatch(/not yet measured/);
  });
});

// ---------------------------------------------------------------------------
// OPS-01.1 follow-up — Codex review on the OPS-01.1 head.
//   3774838342 (P2) refresh the heartbeat even when the prior read fails
//   3774838345 (P2) distinguish cadence failures from recency failures
// ---------------------------------------------------------------------------
describe("P2 3774838342: a failed prior read must not discard the run's heartbeat", () => {
  // This invariant is now STRUCTURAL rather than defensive. The earlier fix
  // isolated a client-side read in its own try/catch; the atomic EVAL removes
  // the client-side read altogether, so there is no longer a prior-read step
  // that can fail independently of the write. The guarantee is stronger, so
  // these pins assert the new shape.
  it("there is no separate client-side prior read to fail", () => {
    const fn =
      HEARTBEAT.match(
        /export async function recordReminderRunSuccess\([\s\S]*?\n\}/,
      )?.[0] ?? "";
    expect(fn).not.toBe("");
    expect(fn).not.toMatch(/redis\.get\(/);
    expect(fn).toMatch(/redis\.eval\(/);
  });

  it("the prior value is read INSIDE the same atomic step", () => {
    expect(HEARTBEAT).toMatch(/redis\.call\('GET', KEYS\[1\]\)/);
    expect(HEARTBEAT).toMatch(/redis\.call\('SET', KEYS\[1\]/);
  });

  it("an unreadable or corrupt current value still records this run's success", () => {
    // pcall-guarded decode, then the cur == nil branch stores the candidate.
    expect(HEARTBEAT).toMatch(/pcall\(cjson\.decode, raw\)/);
    expect(HEARTBEAT).toMatch(/if cur == nil then[\s\S]*?redis\.call\('SET'/);
  });

  it("cadence evidence is optional; recording the success is not", () => {
    expect(HEARTBEAT).toMatch(/cannot suppress this run's recency/);
  });
});

describe("P2 3774838345: operator copy names the axis that failed", () => {
  it("the status carries a failing-axis attribution", () => {
    expect(HEARTBEAT).toMatch(/failingAxis/);
    expect(HEARTBEAT).toMatch(/ReminderFailingAxis/);
  });

  it("the alert message branches on the failing axis", () => {
    expect(HEARTBEAT).toMatch(/status\.failingAxis === "cadence"/);
    // and it takes the whole status, not just the bare health word
    expect(HEARTBEAT).toMatch(
      /function reminderSchedulerAlertMessage\(\s*status: ReminderSchedulerStatus,?\s*\)/,
    );
  });

  it("a cadence-only message does not claim the last success is old", () => {
    const fn =
      HEARTBEAT.match(
        /function reminderSchedulerAlertMessage\([\s\S]*?\n\}/,
      )?.[0] ?? "";
    expect(fn).toMatch(/still firing/);
  });

  it("the admin card branches on the failing axis too", () => {
    expect(ADMIN).toMatch(/status\.failingAxis === "cadence"/);
    expect(ADMIN).toMatch(/still firing/);
  });
});
