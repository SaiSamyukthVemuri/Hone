import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({
  alerts: [] as Array<Record<string, unknown>>,
  persist: true,
}));
vi.mock("@/lib/ops/alerts", () => ({
  recordOpsAlertDurably: async (a: Record<string, unknown>) => {
    h.alerts.push(a);
    return h.persist;
  },
}));
const { sweepStuckFeeAttempts, STUCK_FEE_SWEEP_READ_FAILED_EVENT, STUCK_FEE_AFTER_MINUTES, STUCK_FEE_EVENT, STUCK_FEE_REASON_NO_PI, STUCK_FEE_REASON_PI_UNRECONCILED } = await import("@/lib/billing/stuck-fee-sweep");

// A fake database that RECORDS every call. The sweep may read two tables and must never write anything itself.
type Call = { table: string; op: string; filters: Array<[string, unknown]> };
function fakeAdmin(opts: { attempts: unknown; attemptsError?: boolean; existingAlerts?: Array<{ attempt_id: string; reason: string }>; dedupeError?: boolean }) {
  const calls: Call[] = [];
  return {
    calls,
    admin: {
      from(table: string) {
        const filters: Array<[string, unknown]> = [];
        const call: Call = { table, op: "select", filters };
        calls.push(call);
        const q: Record<string, unknown> = {};
        const chain = (c: string) => (...a: unknown[]) => { filters.push([c, a]); return q; };
        for (const m of ["select", "in", "lt", "order", "or"]) q[m] = chain(m);
        q.eq = (c: string, v: unknown) => { filters.push([c, v]); return q; };
        q.limit = () => q;
        q.then = (resolve: (v: unknown) => unknown) => {
          if (table === "payment_charge_attempts") {
            if (opts.attemptsError) return resolve({ data: null, error: { code: "57014" } });
            // Evaluate the age filter the way the database would: coalesce(claimed_at, updated_at) < cutoff.
            const orArg = String((filters.find(([c]) => c === "or")?.[1] as unknown[] | undefined)?.[0] ?? "");
            const m = /^claimed_at\.lt\.([^,]+),and\(claimed_at\.is\.null,updated_at\.lt\.([^)]+)\)$/.exec(orArg);
            const rows = (opts.attempts as Array<{ claimed_at?: string | null; updated_at: string }>) ?? [];
            if (!m || m[1] !== m[2]) return resolve({ data: rows, error: null });
            const cutoff = m[1];
            return resolve({ data: rows.filter((r) => (r.claimed_at ?? r.updated_at) < cutoff), error: null });
          }
          if (opts.dedupeError) return resolve({ data: null, error: { code: "57014" } });
          const id = filters.find(([c]) => c === "safe_details->>attempt_id")?.[1];
          const reason = filters.find(([c]) => c === "safe_details->>reason")?.[1];
          const hit = (opts.existingAlerts ?? []).filter((a) => a.attempt_id === id && a.reason === reason);
          return resolve({ data: hit.map(() => ({ id: "alert" })), error: null });
        };
        for (const m of ["insert", "update", "upsert", "delete"]) q[m] = () => { calls.push({ table, op: m, filters }); throw new Error(`WRITE ${m} on ${table}`); };
        return q;
      },
    },
  };
}
const A1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const A2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const row = (id: string, pi: string | null, reason = "late_cancellation_fee") => ({
  id, studio_id: "11111111-1111-4111-8111-111111111111", client_id: "c1", appointment_id: "ap1", charge_reason: reason, stripe_payment_intent_id: pi, updated_at: "2026-11-15T10:00:00.000Z", claimed_at: "2026-11-15T10:00:00.000Z" as string | null,
});
const NOW = new Date("2026-11-15T12:00:00.000Z");
beforeEach(() => { h.alerts = []; h.persist = true; });

describe("stuck fee sweep: finds and alerts", () => {
  it("asks only for manual-fee reasons in pending_stripe older than N minutes", async () => {
    const f = fakeAdmin({ attempts: [] });
    await sweepStuckFeeAttempts({ admin: f.admin, now: NOW });
    const q = f.calls[0];
    expect(q.table).toBe("payment_charge_attempts");
    const get = (c: string) => q.filters.find(([k]) => k === c)?.[1];
    expect(JSON.stringify(get("in"))).toContain("no_show_fee");
    expect(JSON.stringify(get("in"))).toContain("late_cancellation_fee");
    expect(JSON.stringify(get("in"))).not.toContain("session_payment");
    expect(get("status")).toBe("pending_stripe");
    expect(String((get("or") as unknown[])[0])).toContain(new Date(NOW.getTime() - STUCK_FEE_AFTER_MINUTES * 60_000).toISOString());
  });
  it("raises ONE critical alert per attempt, with the right reason for each kind, and no PII", async () => {
    const f = fakeAdmin({ attempts: [row(A1, null), row(A2, "pi_123", "no_show_fee")] });
    const s = await sweepStuckFeeAttempts({ admin: f.admin, now: NOW });
    expect(s).toMatchObject({ scanned: 2, stuck: 2, alerted: 2, already_alerted: 0, alert_failed: 0, read_failed: false });
    expect(h.alerts).toHaveLength(2);
    for (const a of h.alerts) {
      expect(a.severity).toBe("critical");
      expect(a.event).toBe(STUCK_FEE_EVENT);
    }
    expect((h.alerts[0].safeDetails as Record<string, unknown>).reason).toBe(STUCK_FEE_REASON_NO_PI);
    expect((h.alerts[1].safeDetails as Record<string, unknown>).reason).toBe(STUCK_FEE_REASON_PI_UNRECONCILED);
    expect((h.alerts[0].safeDetails as Record<string, unknown>).attempt_id).toBe(A1);
    expect(JSON.stringify(h.alerts)).not.toMatch(/client_secret|sk_|card|@/);
  });
  it("NEGATIVE: a clean scan alerts nothing", async () => {
    const s = await sweepStuckFeeAttempts({ admin: fakeAdmin({ attempts: [] }).admin, now: NOW });
    expect(s).toMatchObject({ scanned: 0, alerted: 0 });
    expect(h.alerts).toEqual([]);
  });
});

describe("stuck fee sweep: age is measured from the CLAIM, not from prepare or from the last write", () => {
  const claimed = (id: string, claimedAt: string | null, updatedAt: string) => ({ ...row(id, null), claimed_at: claimedAt, updated_at: updatedAt });
  it("an attempt prepared days ago but claimed 1 minute ago is NOT stuck (created_at is never consulted)", async () => {
    const f = fakeAdmin({ attempts: [claimed(A1, "2026-11-15T11:59:00.000Z", "2026-11-15T11:59:00.000Z")] });
    const s = await sweepStuckFeeAttempts({ admin: f.admin, now: NOW });
    expect(s.scanned).toBe(0);
    expect(h.alerts).toEqual([]);
    expect(JSON.stringify(f.calls[0].filters)).not.toContain("created_at");
  });
  it("claimed 31 minutes ago is stuck even if a later write moved updated_at forward", async () => {
    const f = fakeAdmin({ attempts: [claimed(A1, "2026-11-15T11:29:00.000Z", "2026-11-15T11:58:00.000Z")] });
    const s = await sweepStuckFeeAttempts({ admin: f.admin, now: NOW });
    expect(s.alerted).toBe(1);
    expect((h.alerts[0].safeDetails as Record<string, unknown>).pending_since_source).toBe("claimed_at");
  });
  it("an attempt claimed before 0352 (claimed_at NULL) falls back to updated_at", async () => {
    const f = fakeAdmin({ attempts: [claimed(A1, null, "2026-11-15T10:00:00.000Z"), claimed(A2, null, "2026-11-15T11:59:00.000Z")] });
    const s = await sweepStuckFeeAttempts({ admin: f.admin, now: NOW });
    expect(s.alerted).toBe(1);
    expect((h.alerts[0].safeDetails as Record<string, unknown>).pending_since_source).toBe("updated_at");
  });
});

describe("stuck fee sweep: which states (requires_action is not an attempt status)", () => {
  it("the status CHECK has no requires_action, so a sent attempt can only be pending_stripe; no dead filter exists", () => {
    const m = readFileSync(join(process.cwd(), "supabase/migrations/0073_payment_charge_attempts.sql"), "utf8");
    const check = m.slice(m.indexOf("status text not null default 'ready'"), m.indexOf("client_payment_method_id uuid"));
    expect(check).toMatch(/'pending_stripe'/);
    expect(check).not.toMatch(/requires_action/);
    const src = readFileSync(join(process.cwd(), "lib/billing/stuck-fee-sweep.ts"), "utf8").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    expect(src).not.toMatch(/requires_action/);
    // the runner turns a requires_action PaymentIntent into a cancelled intent and a FAILED attempt, never a resting state
    const runner = readFileSync(join(process.cwd(), "lib/billing/session-payment-charge.ts"), "utf8");
    expect(runner).toMatch(/failureCode: "requires_action_canceled"/);
  });
});

describe("stuck fee sweep: the dedupe key survives the alert redactor", () => {
  it("attempt_id and reason are stored exactly as the dedupe query will look for them (real redactor, not a fake)", async () => {
    const { redactOpsAlertDetails } = await import("@/lib/ops/redact");
    const f = fakeAdmin({ attempts: [row(A1, null), row(A2, "pi_123", "no_show_fee")] });
    await sweepStuckFeeAttempts({ admin: f.admin, now: NOW });
    for (const a of h.alerts) {
      const stored = redactOpsAlertDetails(a.safeDetails as Record<string, unknown>);
      expect(stored.attempt_id).toBe((a.safeDetails as Record<string, unknown>).attempt_id);
      expect(stored.reason).toBe((a.safeDetails as Record<string, unknown>).reason);
    }
  });
});

describe("stuck fee sweep: once per attempt (dedupe)", () => {
  it("an attempt already alerted for the same reason is not alerted again", async () => {
    const f = fakeAdmin({ attempts: [row(A1, null)], existingAlerts: [{ attempt_id: A1, reason: STUCK_FEE_REASON_NO_PI }] });
    const s = await sweepStuckFeeAttempts({ admin: f.admin, now: NOW });
    expect(s).toMatchObject({ stuck: 1, alerted: 0, already_alerted: 1 });
    expect(h.alerts).toEqual([]);
  });
  it("running it twice in a row, with the first alert now on record, alerts exactly once", async () => {
    const existing: Array<{ attempt_id: string; reason: string }> = [];
    const f = () => fakeAdmin({ attempts: [row(A1, null)], existingAlerts: existing });
    await sweepStuckFeeAttempts({ admin: f().admin, now: NOW });
    existing.push({ attempt_id: A1, reason: STUCK_FEE_REASON_NO_PI });
    await sweepStuckFeeAttempts({ admin: f().admin, now: NOW });
    expect(h.alerts).toHaveLength(1);
  });
  it("a different reason for the same attempt (a PaymentIntent appeared) is a new alert; a different attempt is independent", async () => {
    const f = fakeAdmin({ attempts: [row(A1, "pi_1"), row(A2, null)], existingAlerts: [{ attempt_id: A1, reason: STUCK_FEE_REASON_NO_PI }] });
    const s = await sweepStuckFeeAttempts({ admin: f.admin, now: NOW });
    expect(s.alerted).toBe(2);
  });
  it("an unreadable dedupe check stays silent for that attempt (no spam) and is counted", async () => {
    const f = fakeAdmin({ attempts: [row(A1, null)], dedupeError: true });
    const s = await sweepStuckFeeAttempts({ admin: f.admin, now: NOW });
    expect(h.alerts).toEqual([]);
    expect(s.alert_failed).toBe(1);
  });
  it("an alert that could not be persisted is counted, so the next run tries again (nothing was recorded)", async () => {
    h.persist = false;
    const s = await sweepStuckFeeAttempts({ admin: fakeAdmin({ attempts: [row(A1, null)] }).admin, now: NOW });
    expect(s).toMatchObject({ alerted: 0, alert_failed: 1 });
  });
  it("an unreadable attempts query reports read_failed and raises ONE critical alert about the sweep itself (never silent)", async () => {
    const s = await sweepStuckFeeAttempts({ admin: fakeAdmin({ attempts: null, attemptsError: true }).admin, now: NOW });
    expect(s.read_failed).toBe(true);
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]).toMatchObject({ severity: "critical", event: STUCK_FEE_SWEEP_READ_FAILED_EVENT });
  });
});

describe("stuck fee sweep: writes NOTHING itself", () => {
  it("across every case the fake saw only selects: no insert, update, upsert or delete on any table", async () => {
    const f = fakeAdmin({ attempts: [row(A1, null), row(A2, "pi_9")] });
    await sweepStuckFeeAttempts({ admin: f.admin, now: NOW });
    expect(f.calls.every((c) => c.op === "select")).toBe(true);
    expect(f.calls.map((c) => c.table).sort()).toEqual(["ops_alerts", "ops_alerts", "payment_charge_attempts"]);
  });
  it("source: no write verbs, no Stripe, no charge or refund module", () => {
    const src = readFileSync(join(process.cwd(), "lib/billing/stuck-fee-sweep.ts"), "utf8").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    expect(src).not.toMatch(/\.(insert|update|upsert|delete)\(|\.rpc\(/);
    expect(src).not.toMatch(/@\/lib\/stripe|session-payment-charge|payment-refund|getStripe|paymentIntents|refunds\./);
    expect(src).toMatch(/recordOpsAlertDurably/);
  });
});

describe("the cron route", () => {
  it("is CRON_SECRET-guarded and registered in vercel.json", () => {
    const route = readFileSync(join(process.cwd(), "app/api/cron/stuck-fee-sweep/route.ts"), "utf8");
    expect(route).toMatch(/isAuthorizedCronRequest\(req\)/);
    const cfg = JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8"));
    expect(cfg.crons.map((c: { path: string }) => c.path)).toContain("/api/cron/stuck-fee-sweep");
  });
});

describe("the cron route refuses without the secret", () => {
  it("401 and no sweep without or with a wrong bearer", async () => {
    vi.resetModules();
    const sweep = vi.fn();
    vi.doMock("@/lib/billing/stuck-fee-sweep", () => ({ sweepStuckFeeAttempts: sweep }));
    vi.doMock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => ({}) }));
    process.env.CRON_SECRET = "synthetic-secret";
    const { GET } = await import("@/app/api/cron/stuck-fee-sweep/route");
    expect((await GET(new Request("https://x.test/a"))).status).toBe(401);
    expect((await GET(new Request("https://x.test/a", { headers: { authorization: "Bearer wrong" } }))).status).toBe(401);
    expect(sweep).not.toHaveBeenCalled();
    sweep.mockResolvedValue({ scanned: 0, stuck: 0, alerted: 0, already_alerted: 0, alert_failed: 0, read_failed: false });
    expect((await GET(new Request("https://x.test/a", { headers: { authorization: "Bearer synthetic-secret" } }))).status).toBe(200);
    delete process.env.CRON_SECRET;
  });
});
