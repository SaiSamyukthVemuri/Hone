import { abortableRpc } from "./helpers/abortable-rpc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { IdempotentEmailTransport } from "@/lib/email/new-client-waitlist-send";

// LEAD-ALERT-01 (#826): the delivery worker's decisions, with the database
// and the provider replaced by recording fakes. The real database path is
// proved in tests/db/platform-lead-alerts.db.test.ts; this file pins what is
// awkward there: the provider's literal 15-second timeout, the outcome
// mapping for every answer, and that the worker never throws.

const ops = vi.hoisted(() => ({ calls: [] as unknown[] }));
const afterCtl = vi.hoisted(() => ({ handed: [] as unknown[], throws: false }));
vi.mock("next/server", () => ({
  after: (task: unknown) => {
    if (afterCtl.throws) throw new Error("after() called outside a request scope");
    afterCtl.handed.push(task);
  },
}));
vi.mock("@/lib/ops/alerts", () => ({
  recordOpsAlert: async (input: unknown) => {
    ops.calls.push(input);
  },
}));

import {
  deliverPlatformLeadAlert,
  leadAlertConfigurationStatus,
  recipientDigest,
  schedulePlatformLeadAlert,
  settlementFor,
  sweepPlatformLeadAlerts,
} from "@/lib/platform-leads/alert-delivery";

const OPS = "ops@hone.example";
const ENV = { LEAD_ALERT_EMAIL: OPS, ADMIN_EMAILS: OPS };
const ALERT = "8f0c2b7e-5d1a-4a2b-9c3d-4e5f6a7b8c9d";

const CLAIMED = {
  result: "claimed",
  alert_id: ALERT,
  claim_token: "token-1",
  attempt: 1,
  idempotency_key: `lead-alert/${ALERT}/1`,
  lead_kind: "demo_request",
  lead_id: "lead-1",
  event_at: "2026-10-11T18:05:00Z",
  lead_name: "Avery Lead",
  lead_email: "avery@example.test",
  practice_name: null,
  location: null,
  practice_type: null,
  practitioner_count: null,
  current_tool: null,
  has_notes: false,
  frozen_message: null,
  frozen_recipient_sha256: null,
};

const FREEZE = "freeze_platform_lead_alert_message";
/** The database's first-writer-wins answer when nothing was frozen before. */
const echoFreeze = (args: Record<string, unknown>) => [
  { result: "frozen", message: args.p_message, recipient_sha256: args.p_recipient_sha256 },
];

type Call = { fn: string; args: Record<string, unknown> };

function fakeAdmin(answers: Record<string, unknown>, calls: Call[]): SupabaseClient {
  return {
    rpc: abortableRpc(async (fn: string, args: Record<string, unknown> = {}) => {
      calls.push({ fn, args });
      if (fn === FREEZE && !(FREEZE in answers)) return { data: echoFreeze(args), error: null };
      const answer = answers[fn];
      if (answer instanceof Error) throw answer;
      if (answer && typeof answer === "object" && "error" in (answer as object)) return answer;
      return { data: answer, error: null };
    }),
  } as unknown as SupabaseClient;
}

function transport(answer: () => Promise<unknown>): IdempotentEmailTransport {
  return { emails: { send: async () => (await answer()) as never } };
}

beforeEach(() => {
  ops.calls.length = 0;
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("settlementFor: the provider's answer as the alert's next state", () => {
  it("accepted", () => {
    expect(settlementFor({ status: "accepted", messageId: "m1" })).toEqual({ outcome: "accepted", messageId: "m1" });
  });

  it("an answer that may or may not have been taken is retried under the same key", () => {
    expect(settlementFor({ status: "ambiguous", reason: "timeout" })).toEqual({ outcome: "retry", errorCode: "provider_timeout" });
    expect(settlementFor({ status: "ambiguous", reason: "no_message_id" })).toEqual({ outcome: "retry", errorCode: "provider_exception" });
    expect(settlementFor({ status: "ambiguous", reason: "concurrent" })).toEqual({
      outcome: "retry",
      errorCode: "provider_unavailable",
      providerError: "concurrent_idempotent_requests",
    });
  });

  it("a refusal the same request would meet again is final", () => {
    for (const code of ["validation_error", "invalid_to_address", "missing_required_field", "invalid_idempotency_key", "invalid_idempotent_request"] as const) {
      expect(settlementFor({ status: "rejected", code })).toEqual({ outcome: "fail", errorCode: "provider_rejected", providerError: code });
    }
  });

  it("a rate limit or an unrecognised provider error may pass: retried within the budget", () => {
    for (const code of ["rate_limit_exceeded", "unrecognized_provider_error"] as const) {
      expect(settlementFor({ status: "rejected", code })).toEqual({ outcome: "retry", errorCode: "provider_unavailable", providerError: code });
    }
  });

  it("a local refusal made no request", () => {
    expect(settlementFor({ status: "rejected", code: "not_configured" })).toEqual({ outcome: "retry", errorCode: "transport_not_configured" });
    expect(settlementFor({ status: "rejected", code: null })).toEqual({ outcome: "retry", errorCode: "provider_exception" });
  });
});

describe("deliverPlatformLeadAlert", () => {
  it("a provider that never answers: the 15-second ceiling becomes a retry, under the alert's own key", async () => {
    vi.useFakeTimers();
    const calls: Call[] = [];
    const keys: Array<string | undefined> = [];
    const hanging: IdempotentEmailTransport = {
      emails: {
        send: (_payload, options) => {
          keys.push(options?.idempotencyKey);
          return new Promise(() => undefined);
        },
      },
    };
    const running = deliverPlatformLeadAlert(ALERT, {
      admin: fakeAdmin({ claim_platform_lead_alert: [CLAIMED], settle_platform_lead_alert: "retry_scheduled" }, calls),
      transport: hanging,
      env: ENV,
      appOrigin: () => "https://hone.example",
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await running).toEqual({ result: "retry_scheduled" });
    expect(keys).toEqual([`lead-alert/${ALERT}/1`]);
    expect(calls.find((c) => c.fn === "settle_platform_lead_alert")?.args).toMatchObject({
      p_alert_id: ALERT,
      p_claim_token: "token-1",
      p_outcome: "retry",
      p_error_code: "provider_timeout",
    });
  });

  it("blocked configuration claims nothing and sends nothing", async () => {
    const calls: Call[] = [];
    let sends = 0;
    const out = await deliverPlatformLeadAlert(ALERT, {
      admin: fakeAdmin({ record_platform_lead_alerts_unconfigured: 1 }, calls),
      transport: transport(async () => {
        sends += 1;
        return { data: { id: "m" }, error: null };
      }),
      env: { ADMIN_EMAILS: OPS },
      appOrigin: () => "https://hone.example",
    });
    expect(out).toEqual({ result: "blocked", code: "recipient_not_configured", recorded: true });
    expect(calls.map((c) => c.fn)).toEqual(["record_platform_lead_alerts_unconfigured"]);
    expect(calls[0].args).toEqual({ p_error_code: "recipient_not_configured", p_alert_id: ALERT });
    expect(sends).toBe(0);
  });

  it("a final failure raises one ops alert carrying ids and codes, never lead details", async () => {
    const out = await deliverPlatformLeadAlert(ALERT, {
      admin: fakeAdmin({ claim_platform_lead_alert: [CLAIMED], settle_platform_lead_alert: "failed" }, []),
      transport: transport(async () => ({ data: null, error: { name: "validation_error", message: "bad", statusCode: 422 } })),
      env: ENV,
      appOrigin: () => "https://hone.example",
    });
    expect(out).toEqual({ result: "failed" });
    expect(ops.calls).toHaveLength(1);
    const text = JSON.stringify(ops.calls[0]);
    expect(text).toContain(ALERT);
    expect(text).toContain("provider_rejected");
    expect(text).not.toMatch(/Avery|avery@example/);
  });

  it("an unsettled send reports settle_error (the lease brings it back under the same key)", async () => {
    const out = await deliverPlatformLeadAlert(ALERT, {
      admin: fakeAdmin({
        claim_platform_lead_alert: [CLAIMED],
        settle_platform_lead_alert: { data: null, error: { code: "08006", message: "connection lost" } },
      }, []),
      transport: transport(async () => ({ data: { id: "m" }, error: null })),
      env: ENV,
      appOrigin: () => "https://hone.example",
    });
    expect(out).toEqual({ result: "settle_error" });
  });

  it("nothing to claim sends nothing", async () => {
    let sends = 0;
    const out = await deliverPlatformLeadAlert(ALERT, {
      admin: fakeAdmin({ claim_platform_lead_alert: [{ ...CLAIMED, result: "none" }] }, []),
      transport: transport(async () => {
        sends += 1;
        return { data: { id: "m" }, error: null };
      }),
      env: ENV,
      appOrigin: () => "https://hone.example",
    });
    expect(out).toEqual({ result: "none" });
    expect(sends).toBe(0);
  });

  it("never throws, whatever the database does", async () => {
    const out = await deliverPlatformLeadAlert(ALERT, {
      admin: fakeAdmin({ claim_platform_lead_alert: new Error("boom") }, []),
      transport: transport(async () => ({ data: { id: "m" }, error: null })),
      env: ENV,
      appOrigin: () => "https://hone.example",
    });
    expect(out).toEqual({ result: "threw" });
  });
});

describe("sweepPlatformLeadAlerts", () => {
  it("expires first, then stops at the first empty claim", async () => {
    const calls: Call[] = [];
    let claims = 0;
    const admin = {
      rpc: abortableRpc(async (fn: string, args: Record<string, unknown> = {}) => {
        if (fn === FREEZE) return { data: echoFreeze(args), error: null };
        calls.push({ fn, args });
        if (fn === "expire_platform_lead_alerts") return { data: 2, error: null };
        if (fn === "claim_platform_lead_alert") {
          claims += 1;
          return { data: [claims <= 2 ? { ...CLAIMED, claim_token: `t${claims}` } : { ...CLAIMED, result: "none" }], error: null };
        }
        return { data: "accepted", error: null };
      }),
    } as unknown as SupabaseClient;
    const summary = await sweepPlatformLeadAlerts({
      admin,
      transport: transport(async () => ({ data: { id: "m" }, error: null })),
      env: ENV,
      appOrigin: () => "https://hone.example",
    });
    expect(summary).toMatchObject({ ok: true, expired: 2, attempted: 2, accepted: 2 });
    expect(calls[0].fn).toBe("expire_platform_lead_alerts");
    expect(calls.filter((c) => c.fn === "claim_platform_lead_alert").every((c) => c.args.p_alert_id === null)).toBe(true);
    expect(ops.calls).toHaveLength(1);
    expect(JSON.stringify(ops.calls[0])).toContain("platform_lead_alerts_expired");
  });

  it("a lost settle FAILS the run and stops it (Codex P2 4243922093)", async () => {
    let claims = 0;
    const admin = {
      rpc: abortableRpc(async (fn: string, args: Record<string, unknown> = {}) => {
        if (fn === FREEZE) return { data: echoFreeze(args), error: null };
        if (fn === "expire_platform_lead_alerts") return { data: 0, error: null };
        if (fn === "claim_platform_lead_alert") {
          claims += 1;
          return { data: [{ ...CLAIMED, claim_token: `t${claims}` }], error: null };
        }
        return { data: null, error: { code: "08006", message: "connection lost" } };
      }),
    } as unknown as SupabaseClient;
    const summary = await sweepPlatformLeadAlerts({
      admin,
      transport: transport(async () => ({ data: { id: "m" }, error: null })),
      env: ENV,
      appOrigin: () => "https://hone.example",
    });
    expect(summary).toMatchObject({ ok: false, attempted: 1, accepted: 0, other: 0 });
    expect(claims).toBe(1);
  });

  it("is bounded per run", async () => {
    let claims = 0;
    const admin = {
      rpc: abortableRpc(async (fn: string, args: Record<string, unknown> = {}) => {
        if (fn === FREEZE) return { data: echoFreeze(args), error: null };
        if (fn === "expire_platform_lead_alerts") return { data: 0, error: null };
        if (fn === "claim_platform_lead_alert") {
          claims += 1;
          return { data: [{ ...CLAIMED, claim_token: `t${claims}` }], error: null };
        }
        return { data: "retry_scheduled", error: null };
      }),
    } as unknown as SupabaseClient;
    const summary = await sweepPlatformLeadAlerts({
      admin,
      transport: transport(async () => ({ data: { id: "m" }, error: null })),
      env: ENV,
      appOrigin: () => "https://hone.example",
      maxAlerts: 3,
    });
    expect(summary).toMatchObject({ attempted: 3, retryScheduled: 3 });
    expect(claims).toBe(3);
  });
});

describe("leadAlertConfigurationStatus", () => {
  it("masks the recipient, and names the blocker when there is one", () => {
    expect(
      leadAlertConfigurationStatus({ env: ENV, transport: transport(async () => ({})), appOrigin: () => "https://hone.example" }),
    ).toEqual({ state: "ready", maskedRecipient: "o•••@h•••.example" });
    expect(leadAlertConfigurationStatus({ env: ENV, transport: null, appOrigin: () => "x" })).toEqual({
      state: "blocked",
      code: "transport_not_configured",
    });
  });
});

// Codex P2 4243922093 and 4244064458: a database write that failed is never a
// successful run. EVERY database call the worker makes is failed in turn, and
// the sweep must answer ok:false. The source guard below keeps this table and
// the code in step, so a new call cannot reintroduce the per-branch gap.
describe("every worker database call: its failure fails the run", () => {
  const SWEEP_CALLS = [
    "expire_platform_lead_alerts",
    "claim_platform_lead_alert",
    "freeze_platform_lead_alert_message",
    "settle_platform_lead_alert",
    "record_platform_lead_alerts_unconfigured",
  ] as const;

  for (const failing of SWEEP_CALLS) {
    it(`${failing} failing -> ok:false`, async () => {
      const blocked = failing === "record_platform_lead_alerts_unconfigured";
      const admin = {
        rpc: abortableRpc(async (fn: string, args: Record<string, unknown> = {}) => {
          if (fn === failing) return { data: null, error: { code: "08006", message: "lost" } };
          if (fn === FREEZE) return { data: echoFreeze(args), error: null };
          if (fn === "expire_platform_lead_alerts") return { data: 0, error: null };
          if (fn === "claim_platform_lead_alert") return { data: [{ ...CLAIMED, claim_token: "t" }], error: null };
          if (fn === "settle_platform_lead_alert") return { data: "accepted", error: null };
          return { data: 1, error: null };
        }),
      } as unknown as SupabaseClient;
      const summary = await sweepPlatformLeadAlerts({
        admin,
        transport: transport(async () => ({ data: { id: "m" }, error: null })),
        // The blocker path runs only when configuration is missing.
        env: blocked ? { ADMIN_EMAILS: OPS } : ENV,
        appOrigin: () => "https://hone.example",
        maxAlerts: 1,
      });
      expect(summary.ok, failing).toBe(false);
    });
  }

  it("the single-alert path reports an unpersisted blocker", async () => {
    const out = await deliverPlatformLeadAlert(ALERT, {
      admin: fakeAdmin({ record_platform_lead_alerts_unconfigured: { data: null, error: { code: "08006", message: "lost" } } }, []),
      transport: transport(async () => ({ data: { id: "m" }, error: null })),
      env: { ADMIN_EMAILS: OPS },
      appOrigin: () => "https://hone.example",
    });
    expect(out).toEqual({ result: "blocked", code: "recipient_not_configured", recorded: false });
  });

  it("the table covers every rpc the worker makes (source guard)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("lib/platform-leads/alert-delivery.ts", "utf8");
    const called = [...src.matchAll(/rpc\(\s*admin,\s*"([a-z_]+)"/g)].map((m) => m[1]).sort();
    expect([...new Set(called)]).toEqual([...SWEEP_CALLS].sort());
  });
});

// Codex P2 4244387544: ONE KEY, ONE REQUEST. The first attempt of a
// generation freezes the message; every later attempt sends those bytes,
// whatever changed in between.
describe("the payload is frozen per generation", () => {
  type Sent = { payload: Record<string, unknown>; key: string | undefined };
  const recording = (sent: Sent[]): IdempotentEmailTransport => ({
    emails: {
      send: async (payload, options) => {
        sent.push({ payload: payload as unknown as Record<string, unknown>, key: options?.idempotencyKey });
        return { data: null, error: { name: "internal_server_error", message: "x", statusCode: 500 } } as never;
      },
    },
  });

  it("a retry after the origin, renderer input and lead fields change sends the first attempt's bytes under the same key", async () => {
    const calls: Call[] = [];
    const sent: Sent[] = [];
    await deliverPlatformLeadAlert(ALERT, {
      admin: fakeAdmin({ claim_platform_lead_alert: [CLAIMED], settle_platform_lead_alert: "retry_scheduled" }, calls),
      transport: recording(sent),
      env: ENV,
      appOrigin: () => "https://first.example",
    });
    const freeze = calls.find((c) => c.fn === FREEZE)!.args;
    expect(freeze).toMatchObject({ p_alert_id: ALERT, p_claim_token: "token-1", p_recipient_sha256: recipientDigest(OPS) });
    expect(Object.keys(freeze.p_message as object).sort()).toEqual(["from", "html", "subject", "text"]);
    // The first send is exactly what was frozen, to the configured recipient.
    expect(sent[0].payload).toEqual({ ...(freeze.p_message as object), to: OPS });

    // Attempt 2: the database returns the frozen message with the claim. The
    // origin and even the lead's fields differ now; nothing is re-rendered.
    const calls2: Call[] = [];
    await deliverPlatformLeadAlert(ALERT, {
      admin: fakeAdmin({
        claim_platform_lead_alert: [{
          ...CLAIMED, claim_token: "token-2", attempt: 2, lead_name: "Someone Else",
          frozen_message: freeze.p_message, frozen_recipient_sha256: freeze.p_recipient_sha256,
        }],
        settle_platform_lead_alert: "retry_scheduled",
      }, calls2),
      transport: recording(sent),
      env: ENV,
      appOrigin: () => "https://second.example",
    });
    expect(calls2.map((c) => c.fn)).not.toContain(FREEZE);
    expect(sent).toHaveLength(2);
    expect(JSON.stringify(sent[1].payload)).toBe(JSON.stringify(sent[0].payload));
    expect(sent[1].key).toBe(sent[0].key);
    expect(JSON.stringify(sent[1].payload)).not.toContain("second.example");
  });

  it("first writer wins: when the database already holds a message, that one is sent, not this render", async () => {
    const sent: Sent[] = [];
    const held = { from: "Hone <alerts@hone.example>", subject: "held", html: "<p>held</p>", text: "held" };
    await deliverPlatformLeadAlert(ALERT, {
      admin: fakeAdmin({
        claim_platform_lead_alert: [CLAIMED],
        [FREEZE]: [{ result: "existing", message: held, recipient_sha256: recipientDigest(OPS) }],
        settle_platform_lead_alert: "retry_scheduled",
      }, []),
      transport: recording(sent),
      env: ENV,
      appOrigin: () => "https://hone.example",
    });
    expect(sent.map((x) => x.payload)).toEqual([{ ...held, to: OPS }]);
  });

  it("a changed recipient is not sent: the alert fails as recipient_changed, for the operator's Retry", async () => {
    const calls: Call[] = [];
    const sent: Sent[] = [];
    const out = await deliverPlatformLeadAlert(ALERT, {
      admin: fakeAdmin({
        claim_platform_lead_alert: [{
          ...CLAIMED, attempt: 2,
          frozen_message: { from: "f", subject: "s", html: "h", text: "t" },
          frozen_recipient_sha256: recipientDigest("old@hone.example"),
        }],
        settle_platform_lead_alert: "failed",
      }, calls),
      transport: recording(sent),
      env: ENV,
      appOrigin: () => "https://hone.example",
    });
    expect(out).toEqual({ result: "failed" });
    expect(sent).toEqual([]);
    expect(calls.find((c) => c.fn === "settle_platform_lead_alert")?.args).toMatchObject({ p_outcome: "fail", p_error_code: "recipient_changed" });
  });

  it("a failed or stale freeze sends nothing", async () => {
    for (const [answer, expected] of [
      [{ data: null, error: { code: "08006", message: "lost" } }, "freeze_error"],
      [[{ result: "stale_claim", message: null, recipient_sha256: null }], "stale_claim"],
      [[{ result: "invalid_input", message: null, recipient_sha256: null }], "freeze_error"],
    ] as const) {
      const sent: Sent[] = [];
      const calls: Call[] = [];
      const out = await deliverPlatformLeadAlert(ALERT, {
        admin: fakeAdmin({ claim_platform_lead_alert: [CLAIMED], [FREEZE]: answer }, calls),
        transport: recording(sent),
        env: ENV,
        appOrigin: () => "https://hone.example",
      });
      expect(out).toEqual({ result: expected });
      expect(sent).toEqual([]);
      expect(calls.map((c) => c.fn)).not.toContain("settle_platform_lead_alert");
    }
  });
});

// Codex P2 4249961225 (SENTRY-AFTER-01): post-response work is handed to
// after() as a STARTED PROMISE, never a callback, and starts only after the
// action has returned.
describe("schedulePlatformLeadAlert", () => {
  beforeEach(() => {
    afterCtl.handed.length = 0;
    afterCtl.throws = false;
  });

  it("hands after() a promise, not a callback, and does not start the work synchronously", async () => {
    const started: string[] = [];
    const task = schedulePlatformLeadAlert(ALERT, async (id) => {
      started.push(id);
    });
    expect(afterCtl.handed).toHaveLength(1);
    expect(afterCtl.handed[0]).toBeInstanceOf(Promise);
    expect(typeof afterCtl.handed[0]).not.toBe("function");
    expect(started).toEqual([]);
    await task;
    expect(started).toEqual([ALERT]);
  });

  it("never rejects, even when delivery throws; outside a request scope it still runs", async () => {
    await expect(schedulePlatformLeadAlert(ALERT, async () => { throw new Error("boom"); })).resolves.toBeUndefined();
    afterCtl.throws = true;
    const ran: string[] = [];
    await schedulePlatformLeadAlert(ALERT, async (id) => { ran.push(id); });
    expect(ran).toEqual([ALERT]);
  });

  it("every call site schedules through it; none hands after() a callback (source guard)", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of ["app/actions/demo.ts", "app/actions/waitlist.ts", "app/admin/actions.ts"]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).toMatch(/schedulePlatformLeadAlert\(/);
      expect(src, f).not.toMatch(/\bafter\(/);
      expect(src, f).not.toMatch(/deliverPlatformLeadAlert/);
    }
  });
});
