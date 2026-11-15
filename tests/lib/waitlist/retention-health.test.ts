import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({
  health: { data: null as unknown, error: null as { code?: string } | null },
  alertsRows: [] as Array<{ event: string; created_at: string; resolved_at: string | null }>,
  alertsError: false,
  outbox: [] as Array<{ status: string; created_at: string }>,
  outboxError: false,
  recorded: [] as Array<Record<string, unknown>>,
}));
vi.mock("@/lib/ops/alerts", () => ({
  recordOpsAlert: async (input: Record<string, unknown>) => {
    h.recorded.push(input);
    // a recorded alert becomes a visible, unresolved row, as the real insert would
    h.alertsRows.push({ event: String(input.event), created_at: new Date(NOW).toISOString(), resolved_at: null });
  },
}));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    rpc: async (fn: string) => (fn === "waitlist_retention_health" ? h.health : { data: null, error: { code: "42883" } }),
    from: (table: string) => {
      if (table === "waitlist_decline_owner_emails") {
        let statuses: string[] = [];
        let olderThan = "9999";
        let notBefore = "";
        const o: Record<string, unknown> = {
          select: () => o,
          in: (_c: string, v: string[]) => ((statuses = v), o),
          lt: (_c: string, v: string) => ((olderThan = v), o),
          gte: (_c: string, v: string) => ((notBefore = v), o),
          then: (res: (v: unknown) => unknown) =>
            Promise.resolve(
              h.outboxError
                ? { count: null, error: { code: "XX000" } }
                : { count: h.outbox.filter((r) => statuses.includes(r.status) && r.created_at < olderThan && r.created_at >= notBefore).length, error: null },
            ).then(res),
        };
        return o;
      }
      let event = "";
      let since = "";
      let unresolvedOnly = false;
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (_c: string, v: string) => ((event = v), q),
        is: () => ((unresolvedOnly = true), q),
        gte: (_c: string, v: string) => ((since = v), q),
        limit: () => q,
        then: (res: (v: unknown) => unknown) =>
          Promise.resolve(
            h.alertsError
              ? { data: null, error: { code: "XX000" } }
              : { data: h.alertsRows.filter((r) => r.event === event && r.created_at >= since && (!unresolvedOnly || r.resolved_at === null)), error: null },
          ).then(res),
      };
      return q;
    },
  }),
}));

import {
  RETENTION_EVENTS,
  RETENTION_MISSED_AFTER_SECONDS,
  checkRetentionHealthAndAlert,
  alertRetentionUnavailable,
  evaluateRetentionHealth,
  parseRetentionHealth,
  type RetentionHealth,
} from "@/lib/waitlist/retention-health";

const NOW = Date.parse("2026-11-12T08:00:00.000Z");
const hoursAgo = (n: number) => new Date(NOW - n * 3_600_000).toISOString();
const healthy = (o: Partial<RetentionHealth> = {}): RetentionHealth => ({
  lastSuccessAt: hoursAgo(22), lastRunAt: hoursAgo(22), lastOutcome: "success", lastErasedCount: 4, lastFailedCount: 0,
  overdueUnerasedCount: 0, oldestOverdueAgeHours: null, ...o,
});
const ctx = (o: Partial<{ stuckOwnerEmails: number | null }> = {}) => ({ stuckOwnerEmails: null as number | null, ...o });
const kinds = (x: RetentionHealth, c = ctx()) => evaluateRetentionHealth(x, NOW, c).findings.map((f) => f.kind);
const row = (o: Record<string, unknown> = {}) => ({
  last_success_at: hoursAgo(22), last_run_at: hoursAgo(22), last_outcome: "success", last_erased_count: 4, last_failed_count: 0,
  overdue_unerased_count: 0, oldest_overdue_age_hours: null, ...o,
});

beforeEach(() => {
  h.health = { data: [row()], error: null };
  h.alertsRows = [];
  h.alertsError = false;
  h.outbox = [];
  h.outboxError = false;
  h.recorded = [];
  delete process.env.HONE_WAITLIST_DECLINE_OWNER_EMAIL_ENABLED;
  delete process.env.HONE_WAITLIST_DECLINE_OWNER_EMAIL_SINCE;
  delete process.env.WAITLIST_DECLINE_ANSWERS;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("the alert rules", () => {
  it("a healthy daily run raises nothing", () => {
    expect(kinds(healthy())).toEqual([]);
  });
  it("missed: no success ever, or the last success is more than 26 hours old; exactly 26 hours is not yet missed", () => {
    expect(kinds(healthy({ lastSuccessAt: null }))).toEqual(["missed"]);
    expect(kinds(healthy({ lastSuccessAt: hoursAgo(26.01) }))).toEqual(["missed"]);
    expect(kinds(healthy({ lastSuccessAt: hoursAgo(46) }))).toEqual(["missed"]);
    expect(RETENTION_MISSED_AFTER_SECONDS).toBe(26 * 3600);
    expect(kinds(healthy({ lastSuccessAt: new Date(NOW - RETENTION_MISSED_AFTER_SECONDS * 1000).toISOString() }))).toEqual([]);
  });
  it("a day-D 10:00 run that never happens is caught by the 08:00 check on day D+1", () => {
    const lastSuccess = Date.parse("2026-11-10T10:00:00.000Z"); // day D-1's run; day D (11 Nov) never ran
    const check = Date.parse("2026-11-12T08:00:00.000Z"); // 08:00 on D+1
    expect(evaluateRetentionHealth(healthy({ lastSuccessAt: new Date(lastSuccess).toISOString() }), check, ctx()).findings.map((f) => f.kind)).toEqual(["missed"]);
  });
  it("failed: the last outcome is failed or partial_failure", () => {
    expect(kinds(healthy({ lastOutcome: "failed" }))).toEqual(["failed"]);
    const partial = evaluateRetentionHealth(healthy({ lastOutcome: "partial_failure", lastFailedCount: 3 }), NOW, ctx()).findings;
    expect(partial.map((f) => f.kind)).toEqual(["failed"]);
    expect(partial[0].details).toMatchObject({ failed_answers: 3 });
  });
  it("overdue: only when the oldest unerased answer is more than 24 hours past its deadline (23h quiet, 25h alert)", () => {
    expect(kinds(healthy({ overdueUnerasedCount: 2, oldestOverdueAgeHours: 3 }))).toEqual([]);
    expect(kinds(healthy({ overdueUnerasedCount: 2, oldestOverdueAgeHours: 23 }))).toEqual([]);
    expect(kinds(healthy({ overdueUnerasedCount: 1, oldestOverdueAgeHours: 24 }))).toEqual([]);
    expect(kinds(healthy({ overdueUnerasedCount: 1, oldestOverdueAgeHours: 25 }))).toEqual(["overdue"]);
    expect(kinds(healthy({ overdueUnerasedCount: 0, oldestOverdueAgeHours: null }))).toEqual([]);
    expect(kinds(healthy({ overdueUnerasedCount: 1, oldestOverdueAgeHours: null }))).toEqual([]);
  });
  it("stuck email: raised from the app's own count, as a warning", () => {
    expect(kinds(healthy())).toEqual([]);
    expect(kinds(healthy(), ctx({ stuckOwnerEmails: 0 }))).toEqual([]);
    expect(kinds(healthy(), ctx({ stuckOwnerEmails: null }))).toEqual([]);
    const f = evaluateRetentionHealth(healthy(), NOW, ctx({ stuckOwnerEmails: 4 })).findings;
    expect(f.map((x) => x.kind)).toEqual(["stuckEmail"]);
    expect(f[0].severity).toBe("warning");
  });
  it("every finding carries counts, hours and words only: no id, no uuid, no email address, no answer", () => {
    const all = evaluateRetentionHealth(
      healthy({ lastSuccessAt: null, lastOutcome: "partial_failure", lastFailedCount: 2, overdueUnerasedCount: 3, oldestOverdueAgeHours: 30 }),
      NOW,
      ctx({ stuckOwnerEmails: 1 }),
    ).findings;
    expect(all.map((f) => f.kind).sort()).toEqual(["failed", "missed", "overdue", "stuckEmail"]);
    const text = JSON.stringify(all);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    expect(text).not.toMatch(/@/);
  });
});

describe("parsing the health row", () => {
  it("accepts numeric as a number or a string; a missing or malformed count is unknown, never healthy", () => {
    expect(parseRetentionHealth([row({ overdue_unerased_count: 2, oldest_overdue_age_hours: "30.5" })])).toMatchObject({ overdueUnerasedCount: 2, oldestOverdueAgeHours: 30.5 });
    expect(parseRetentionHealth([row({ overdue_unerased_count: "x" })])).toBeNull();
    expect(parseRetentionHealth([row({ last_failed_count: undefined })])).toBeNull();
    expect(parseRetentionHealth([])).toBeNull();
    expect(parseRetentionHealth(null)).toBeNull();
  });
});

describe("the check raises the alerts, once per day", () => {
  it("a MISSED run raises one critical missed alert", async () => {
    h.health = { data: [row({ last_success_at: hoursAgo(46) })], error: null };
    const out = await checkRetentionHealthAndAlert("/api/cron/calendar-sync", NOW);
    expect(out).toMatchObject({ status: "checked", alerted: ["missed"] });
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]).toMatchObject({ severity: "critical", event: RETENTION_EVENTS.missed, route: "/api/cron/calendar-sync" });
  });
  it("a FAILED run (failed, and partial_failure) raises a critical failed alert", async () => {
    h.health = { data: [row({ last_outcome: "failed" })], error: null };
    expect(await checkRetentionHealthAndAlert("/r", NOW)).toMatchObject({ alerted: ["failed"] });
    h.alertsRows = [];
    h.health = { data: [row({ last_outcome: "partial_failure", last_failed_count: 2 })], error: null };
    expect(await checkRetentionHealthAndAlert("/r", NOW)).toMatchObject({ alerted: ["failed"] });
    expect(h.recorded.at(-1)).toMatchObject({ severity: "critical", event: RETENTION_EVENTS.failed });
  });
  it("the three early crons together give ONE alert: the 2nd and 3rd checks are deduped", async () => {
    h.health = { data: [row({ last_success_at: hoursAgo(46) })], error: null };
    const a = await checkRetentionHealthAndAlert("/api/cron/materialize-recurring-breaks", NOW);
    const b = await checkRetentionHealthAndAlert("/api/cron/calendar-reconcile", NOW + 3_600_000);
    const c = await checkRetentionHealthAndAlert("/api/cron/calendar-sync", NOW + 5_400_000);
    expect([a, b, c].map((x) => (x.status === "checked" ? [x.alerted, x.deduped] : null))).toEqual([[["missed"], []], [[], ["missed"]], [[], ["missed"]]]);
    expect(h.recorded).toHaveLength(1);
  });
  it("it alerts again the next day while the problem persists (24 h later is outside the 23 h window)", async () => {
    h.health = { data: [row({ last_success_at: null })], error: null };
    await checkRetentionHealthAndAlert("/r", NOW);
    await checkRetentionHealthAndAlert("/r", NOW + 24 * 3_600_000);
    expect(h.recorded.filter((r) => r.event === RETENTION_EVENTS.missed)).toHaveLength(2);
  });
  it("overdue answers alert at once past 24 hours, never on a normal pre-10:00 check, and leave no marker row", async () => {
    h.health = { data: [row({ overdue_unerased_count: 2, oldest_overdue_age_hours: 3 })], error: null };
    expect(await checkRetentionHealthAndAlert("/r", NOW)).toMatchObject({ status: "checked", findings: [], alerted: [] });
    expect(await checkRetentionHealthAndAlert("/r", NOW + 3_600_000)).toMatchObject({ findings: [], alerted: [] });
    expect(h.recorded).toHaveLength(0);
    h.health = { data: [row({ overdue_unerased_count: 2, oldest_overdue_age_hours: "25" })], error: null };
    expect(await checkRetentionHealthAndAlert("/r", NOW)).toMatchObject({ alerted: ["overdue"] });
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]).toMatchObject({ severity: "critical", event: RETENTION_EVENTS.overdue });
  });
  describe("stuck owner emails", () => {
    const SINCE = "2026-11-10T00:00:00.000Z";
    const activate = () => {
      process.env.HONE_WAITLIST_DECLINE_OWNER_EMAIL_ENABLED = "true";
      process.env.HONE_WAITLIST_DECLINE_OWNER_EMAIL_SINCE = SINCE;
    };
    it("not counted, and not even read, before owner email is activated", async () => {
      h.outbox = [{ status: "held", created_at: "2026-11-10T12:00:00.000Z" }];
      expect(await checkRetentionHealthAndAlert("/r", NOW)).toMatchObject({ findings: [], alerted: [] });
    });
    it("a held row created before SINCE is not counted (it will never send); an older-than-24h row after SINCE is", async () => {
      activate();
      h.outbox = [{ status: "held", created_at: "2026-11-09T12:00:00.000Z" }, { status: "sending", created_at: "2026-11-09T23:00:00.000Z" }];
      expect(await checkRetentionHealthAndAlert("/r", NOW)).toMatchObject({ findings: [], alerted: [] });
      h.outbox.push({ status: "held", created_at: "2026-11-10T12:00:00.000Z" });
      expect(await checkRetentionHealthAndAlert("/r", NOW)).toMatchObject({ alerted: ["stuckEmail"] });
      expect(h.recorded.at(-1)).toMatchObject({ severity: "warning", event: RETENTION_EVENTS.stuckEmail, safeDetails: { stuck_owner_emails: 1 } });
    });
    it("a row younger than 24 hours, or already sent, is not stuck; an unreadable outbox raises nothing", async () => {
      activate();
      h.outbox = [{ status: "held", created_at: "2026-11-11T12:00:00.000Z" }, { status: "sent", created_at: "2026-11-10T12:00:00.000Z" }];
      expect(await checkRetentionHealthAndAlert("/r", NOW)).toMatchObject({ findings: [] });
      h.outbox = [{ status: "held", created_at: "2026-11-10T12:00:00.000Z" }];
      h.outboxError = true;
      expect(await checkRetentionHealthAndAlert("/r", NOW)).toMatchObject({ findings: [] });
    });
  });
  it("what reaches the alert path carries no studio, client, appointment or id", async () => {
    h.health = { data: [row({ last_success_at: hoursAgo(46), last_outcome: "partial_failure", last_failed_count: 2 })], error: null };
    await checkRetentionHealthAndAlert("/r", NOW);
    for (const a of h.recorded) {
      expect(a.studioId).toBeUndefined();
      expect(a.clientId).toBeUndefined();
      expect(a.appointmentId).toBeUndefined();
      expect(JSON.stringify(a)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-|@/i);
    }
  });
  it("missing or unreadable functions: QUIET before anything depends on them, CRITICAL once the answers flag is on or owner email is activated", async () => {
    h.health = { data: null, error: { code: "42883" } };
    expect(await checkRetentionHealthAndAlert("/r", NOW)).toEqual({ status: "unavailable" });
    h.health = { data: [{ junk: true }], error: null };
    expect(await checkRetentionHealthAndAlert("/r", NOW)).toEqual({ status: "unavailable" });
    expect(h.recorded).toHaveLength(0);
    process.env.WAITLIST_DECLINE_ANSWERS = "1";
    h.health = { data: null, error: { code: "42883" } };
    expect(await checkRetentionHealthAndAlert("/r", NOW)).toEqual({ status: "unavailable" });
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]).toMatchObject({ severity: "critical", event: RETENTION_EVENTS.unavailable });
    delete process.env.WAITLIST_DECLINE_ANSWERS;
    h.alertsRows = [];
    h.recorded = [];
    process.env.HONE_WAITLIST_DECLINE_OWNER_EMAIL_ENABLED = "true";
    process.env.HONE_WAITLIST_DECLINE_OWNER_EMAIL_SINCE = "2026-11-01T00:00:00.000Z";
    expect(await alertRetentionUnavailable("not_installed", "/api/cron/waitlist-decline-owner-email", NOW)).toBe("alerted");
    expect(await alertRetentionUnavailable("not_installed", "/api/cron/waitlist-decline-owner-email", NOW)).toBe("deduped");
    expect(h.recorded).toHaveLength(1);
    expect(JSON.stringify(h.recorded)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-|@/i);
  });
  it("an unreadable alerts table means 'not seen', so the alert is raised rather than lost", async () => {
    h.alertsError = true;
    h.health = { data: [row({ last_success_at: null })], error: null };
    expect(await checkRetentionHealthAndAlert("/r", NOW)).toMatchObject({ alerted: ["missed"] });
  });
});
