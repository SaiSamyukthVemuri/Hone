import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendBookingConfirmationSmsToClient } from "@/lib/sms/send-appointment";

// ===========================================================================
// WAIT S3 PART 2 — the three P2 repairs
//
//   P2-1  a persistently unroutable studio must not spam error logs
//   P2-2  a TRANSIENT read failure must not permanently lose a one-shot
//         confirmation
//   P2-3  stale global env must not read as runtime sender authority
// ===========================================================================

const STUDIO_ID = "11111111-1111-4111-8111-111111111111";
const SID = "MGstudioownidentity0000000000000000";
const ROOT = path.resolve(__dirname, "../../..");

const studio = {
  id: STUDIO_ID,
  name: "Willow Electrolysis",
  send_confirmation_sms: true,
  send_24h_sms_reminders: true,
  send_2h_sms_reminders: true,
} as const;

const client = {
  phone: "+14165551234",
  sms_consent_at: "2026-09-01T00:00:00.000Z",
  sms_opted_out_at: null,
} as const;

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.TWILIO_ACCOUNT_SID = "ACtest";
  process.env.TWILIO_AUTH_TOKEN = "tok";
  fetchSpy = vi.fn(async () =>
    new Response(JSON.stringify({ sid: "SMx", status: "queued" }), { status: 201 }),
  );
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Resolver answers are scripted per call, so retry behaviour is observable. */
function scriptedAdmin(script: Array<{ data: unknown; error?: unknown }>) {
  let i = 0;
  const resolveCalls: number[] = [];
  const rpc = vi.fn(async (name: string) => {
    if (name === "resolve_active_studio_sms_sender") {
      const step = script[Math.min(i, script.length - 1)]!;
      i += 1;
      resolveCalls.push(i);
      return { data: step.data, error: step.error ?? null };
    }
    if (name === "claim_sms_send") return { data: true, error: null };
    return { data: null, error: null };
  });
  return {
    admin: { rpc } as unknown as SupabaseClient,
    resolveCount: () => resolveCalls.length,
    rpc,
  };
}

function args(admin: SupabaseClient) {
  return {
    admin,
    appointmentId: "22222222-2222-4222-8222-222222222222",
    startsAt: new Date("2026-10-01T14:00:00.000Z"),
    timezone: "America/Toronto",
    studio,
    client,
    manageUrl: "https://hone.care/manage/tok",
    intakeUrl: null,
  };
}

// --- P2-2 ------------------------------------------------------------------

describe("P2-2 — a TRANSIENT read failure gets a real second look", () => {
  it("recovers when the resolver succeeds on a later attempt", async () => {
    // The scenario that was permanently losing a confirmation: a momentary
    // blip against a studio that IS correctly configured.
    const s = scriptedAdmin([
      { data: null, error: { message: "socket hang up" } },
      { data: [{ messaging_service_sid: SID }] },
    ]);
    const r = await sendBookingConfirmationSmsToClient(args(s.admin));
    expect(r.ok).toBe(true);
    expect(s.resolveCount()).toBe(2);
    const body = String((fetchSpy.mock.calls[0]![1] as RequestInit).body);
    expect(body).toContain(`MessagingServiceSid=${SID}`);
  });

  it("retries a bounded number of times, then refuses", async () => {
    const s = scriptedAdmin([{ data: null, error: { message: "down" } }]);
    const r = await sendBookingConfirmationSmsToClient(args(s.admin));
    expect(r).toEqual({
      ok: false,
      skipped: true,
      reason: "sms_sender_read_failed",
    });
    expect(s.resolveCount()).toBe(3); // bounded, not unbounded
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("retrying still consumes NO attempt — the claim is never reached", async () => {
    const s = scriptedAdmin([{ data: null, error: { message: "down" } }]);
    await sendBookingConfirmationSmsToClient(args(s.admin));
    const claims = s.rpc.mock.calls.filter((c) => c[0] === "claim_sms_send");
    expect(claims).toHaveLength(0);
  });

  it("does NOT retry a TERMINAL configuration refusal", async () => {
    // Asking the same question again would only be slower.
    for (const data of [
      [],
      [{ messaging_service_sid: SID }, { messaging_service_sid: "MGb" }],
    ]) {
      const s = scriptedAdmin([{ data }]);
      await sendBookingConfirmationSmsToClient(args(s.admin));
      expect(s.resolveCount()).toBe(1);
    }
  });

  it("keeps terminal and transient refusals DISTINGUISHABLE", async () => {
    const terminal = await sendBookingConfirmationSmsToClient(
      args(scriptedAdmin([{ data: [] }]).admin),
    );
    const transient = await sendBookingConfirmationSmsToClient(
      args(scriptedAdmin([{ data: null, error: { message: "x" } }]).admin),
    );
    expect(terminal).toEqual({
      ok: false,
      skipped: true,
      reason: "sms_sender_not_active_for_studio",
    });
    expect(transient).toEqual({
      ok: false,
      skipped: true,
      reason: "sms_sender_read_failed",
    });
    expect(terminal).not.toEqual(transient);
  });

  it("never claims retryability the caller cannot act on", async () => {
    // Confirmation is one-shot: `app/book/[slug]/actions.ts` sends inside
    // postCommit and the reminder cron covers only 24h/2h. So the result must
    // NOT carry a retryable flag that nothing would honour.
    const s = scriptedAdmin([{ data: null, error: { message: "down" } }]);
    const r = await sendBookingConfirmationSmsToClient(args(s.admin));
    expect(r).not.toHaveProperty("retryable");
  });

  it("fail-closed survives the retry: no sender ever means no send", async () => {
    for (const script of [
      [{ data: null, error: { message: "down" } }],
      [{ data: [] }],
      [{ data: "malformed" as unknown }],
    ]) {
      const s = scriptedAdmin(script);
      const r = await sendBookingConfirmationSmsToClient(args(s.admin));
      expect(r.ok).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  });
});

// --- P2-1 ------------------------------------------------------------------

describe("P2-1 — a persistently unroutable studio does not spam errors", () => {
  it("treats the dedupe unique violation as DEDUPED, not as a failure", async () => {
    const { recordOpsAlert } = await import("@/lib/ops/alerts");
    const logs: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((m) => {
      logs.push(String(m));
    });
    // P2-A moved the dedupe line to the INFO channel; capture both so this
    // test keeps asserting "reported, and not as a failure" rather than
    // accidentally asserting which channel carried it. The channel split
    // itself is proved in the P2-A suite below.
    vi.spyOn(console, "info").mockImplementation((m) => {
      logs.push(String(m));
    });
    vi.spyOn(console, "log").mockImplementation((m) => {
      logs.push(String(m));
    });

    vi.doMock("@/lib/supabase/admin-server", () => ({
      createAdminClient: () => ({
        from: () => ({
          insert: async () => ({ error: { code: "23505", message: "dupe" } }),
        }),
      }),
    }));
    vi.resetModules();
    const fresh = await import("@/lib/ops/alerts");

    const outcome = await fresh.recordOpsAlert({
      severity: "warning",
      event: "sms_sender_not_active_for_studio",
      message: "no usable sending identity",
      studioId: STUDIO_ID,
      route: "lib/sms/send-appointment",
      safeDetails: {},
    });

    expect(outcome).toEqual({ recorded: false, reason: "deduped" });
    // The whole point: a dedupe must not be reported as an alerting fault.
    expect(logs.join("\n")).not.toContain("ops_alert_insert_failed");
    expect(logs.join("\n")).toContain("ops_alert_deduped");
    spy.mockRestore();
    expect(typeof recordOpsAlert).toBe("function");
    vi.doUnmock("@/lib/supabase/admin-server");
    vi.resetModules();
  });

  it("a genuine insert failure is STILL reported as a failure", async () => {
    vi.doMock("@/lib/supabase/admin-server", () => ({
      createAdminClient: () => ({
        from: () => ({
          insert: async () => ({ error: { code: "42501", message: "denied" } }),
        }),
      }),
    }));
    vi.resetModules();
    const fresh = await import("@/lib/ops/alerts");
    const outcome = await fresh.recordOpsAlert({
      severity: "warning",
      event: "sms_sender_read_failed",
      message: "unreadable",
      studioId: STUDIO_ID,
      safeDetails: {},
    });
    expect(outcome).toEqual({ recorded: false, reason: "insert_failed" });
    vi.doUnmock("@/lib/supabase/admin-server");
    vi.resetModules();
  });

  it("the 0194 dedupe index is NOT weakened by this repair", () => {
    const sql = readFileSync(
      path.join(ROOT, "supabase/migrations/0194_studio_sms_sender_outbound_lookup.sql"),
      "utf8",
    );
    expect(sql).toContain("ops_alerts_sms_routing_open_uniq");
    expect(sql).toContain("where resolved_at is null");
    // No migration is added by this lane; the index is consumed, not changed.
  });

  it("introduces NO parallel alert vocabulary", async () => {
    const src = readFileSync(
      path.join(ROOT, "lib/sms/send-appointment.ts"),
      "utf8",
    );
    const code = src.replace(/\/\/.*$/gm, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
    // Exactly the three shipped routing events, and no invented fourth.
    for (const ev of [
      "sms_sender_not_active_for_studio",
      "sms_sender_ambiguous",
      "sms_sender_read_failed",
    ]) {
      expect(code).toContain(ev);
    }
    expect(code).toContain("recordOpsAlert");
  });
});

// --- P2-3 ------------------------------------------------------------------

describe("P2-3 — the deployment contract cannot be misread", () => {
  const doc = () =>
    readFileSync(path.join(ROOT, "docs/10_DEPLOYMENT_AND_ENV.md"), "utf8");
  const envExample = () =>
    readFileSync(path.join(ROOT, ".env.local.example"), "utf8");

  it("states the sender is per-studio DB routing", () => {
    expect(doc()).toMatch(/per-studio database routing/i);
    expect(doc()).toContain("resolve_active_studio_sms_sender");
  });

  it("names an ACTIVE studio sender as the prerequisite", () => {
    expect(doc()).toMatch(/ACTIVE `studio_sms_senders` row .* is a prerequisite/i);
  });

  it("labels the retained sender vars as TEST/CI fixtures, not runtime", () => {
    // Targets the ENV TABLE ROW for each variable specifically. A negative
    // control caught the first version of this test: asserting on the whole
    // document let it pass while the table still said "Optional", because the
    // narrative section above already carried the wording. The row is what an
    // operator scans, so the row is what must be unambiguous.
    const rows = doc()
      .split("\n")
      .filter((l) => /^\|\s*`TWILIO_(FROM_NUMBER|MESSAGING_SERVICE_SID)`/.test(l));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row, row).toMatch(/TEST\/CI fixture only/i);
      expect(row, row).toMatch(/NOT runtime/i);
      // The old contract said these were how you configure SMS.
      expect(row, row).not.toMatch(/^\|[^|]*\|\s*Optional\s*\|/);
    }
    expect(envExample()).toMatch(/TEST\/LOCAL\/CI FIXTURES ONLY/i);
    expect(envExample()).toMatch(/NOT read at runtime/i);
  });

  it("never implies configuring those vars makes production SMS ready", () => {
    expect(doc()).toMatch(/does \*\*not\*\* enable production SMS|never will/i);
    expect(envExample()).toMatch(/DOES NOT MAKE PRODUCTION SMS READY/i);
  });

  it("keeps the values tests and CI still require", () => {
    // Deleting them to make a runtime point would break tooling.
    expect(envExample()).toContain("TWILIO_FROM_NUMBER=");
    expect(envExample()).toContain("TWILIO_MESSAGING_SERVICE_SID=");
    expect(doc()).toContain("TWILIO_ACCOUNT_SID");
    expect(doc()).toContain("TWILIO_AUTH_TOKEN");
  });
});

// --- P2-A ------------------------------------------------------------------

describe("P2-A — an expected dedupe must not use the ERROR channel", () => {
  /** Captures each console channel separately so severity is observable. */
  function channels() {
    const err: string[] = [];
    const info: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m) => {
      err.push(String(m));
    });
    vi.spyOn(console, "info").mockImplementation((m) => {
      info.push(String(m));
    });
    return { err, info };
  }

  async function alertsWithInsertError(code: string) {
    vi.doMock("@/lib/supabase/admin-server", () => ({
      createAdminClient: () => ({
        from: () => ({
          insert: async () => ({ error: { code, message: "x" } }),
        }),
      }),
    }));
    vi.resetModules();
    return import("@/lib/ops/alerts");
  }

  afterEach(() => {
    vi.doUnmock("@/lib/supabase/admin-server");
    vi.resetModules();
  });

  it("emits the dedupe at INFO, never at ERROR", async () => {
    const c = channels();
    const alerts = await alertsWithInsertError("23505");
    const outcome = await alerts.recordOpsAlert({
      severity: "warning",
      event: "sms_sender_not_active_for_studio",
      message: "no usable sending identity",
      studioId: STUDIO_ID,
      safeDetails: {},
    });

    expect(outcome).toEqual({ recorded: false, reason: "deduped" });
    expect(c.info.join("\n")).toContain("ops_alert_deduped");
    // THE POINT: a persistently unroutable studio must not raise the observed
    // error rate on every cron pass.
    expect(c.err.join("\n")).not.toContain("ops_alert_deduped");
  });

  it("keeps a GENUINE insert failure on the ERROR channel", async () => {
    const c = channels();
    const alerts = await alertsWithInsertError("42501");
    const outcome = await alerts.recordOpsAlert({
      severity: "warning",
      event: "sms_sender_read_failed",
      message: "unreadable",
      studioId: STUDIO_ID,
      safeDetails: {},
    });

    expect(outcome).toEqual({ recorded: false, reason: "insert_failed" });
    expect(c.err.join("\n")).toContain("ops_alert_insert_failed");
    expect(c.info.join("\n")).not.toContain("ops_alert_insert_failed");
  });

  it("does not SUPPRESS the dedupe — it is still structured telemetry", async () => {
    const c = channels();
    const alerts = await alertsWithInsertError("23505");
    await alerts.recordOpsAlert({
      severity: "warning",
      event: "sms_sender_ambiguous",
      message: "two active senders",
      studioId: STUDIO_ID,
      safeDetails: {},
    });
    const line = c.info.find((l) => l.includes("ops_alert_deduped"));
    expect(line).toBeDefined();
    const parsed = JSON.parse(line!);
    expect(parsed.origin_event).toBe("sms_sender_ambiguous");
    expect(parsed.studio_id).toBe(STUDIO_ID);
    expect(parsed.timestamp).toBeTruthy();
  });

  it("leaves every OTHER structured line on the error channel", async () => {
    // The level parameter defaults to "error", so no existing call site moved.
    const src = readFileSync(path.join(ROOT, "lib/ops/alerts.ts"), "utf8");
    const code = src.replace(/\/\/.*$/gm, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
    expect(code).toContain('level: ConsoleLogLevel = "error"');
    // Exactly one call site opts into info.
    expect(code.match(/"info",/g) ?? []).toHaveLength(1);
  });
});

// --- P2-B ------------------------------------------------------------------

describe("P2-B — only ONE-SHOT sends pay for the transient retry", () => {
  it("confirmation still performs the bounded retries", async () => {
    const s = scriptedAdmin([{ data: null, error: { message: "down" } }]);
    await sendBookingConfirmationSmsToClient(args(s.admin));
    expect(s.resolveCount()).toBe(3);
  });

  it("reminder_24h looks ONCE and fails closed for this pass", async () => {
    const { send24hReminderSmsToClient } = await import(
      "@/lib/sms/send-appointment"
    );
    const s = scriptedAdmin([{ data: null, error: { message: "down" } }]);
    const r = await send24hReminderSmsToClient(args(s.admin));
    // No 3x sleep/RPC loop multiplied across a reminder sweep.
    expect(s.resolveCount()).toBe(1);
    expect(r).toEqual({
      ok: false,
      skipped: true,
      reason: "sms_sender_read_failed",
    });
  });

  it("reminder_2h looks ONCE too", async () => {
    const { send2hReminderSmsToClient } = await import(
      "@/lib/sms/send-appointment"
    );
    const s = scriptedAdmin([{ data: null, error: { message: "down" } }]);
    const r = await send2hReminderSmsToClient(args(s.admin));
    expect(s.resolveCount()).toBe(1);
    expect(r.ok).toBe(false);
  });

  it("a reminder sweep does not multiply the backoff per row", async () => {
    // 10 unroutable rows: with the old shared retry this was 30 RPCs and
    // ~2.4s of sleep on a cron runner. It must now be 10 RPCs and no sleep.
    const { send24hReminderSmsToClient } = await import(
      "@/lib/sms/send-appointment"
    );
    let rpcs = 0;
    const admin = {
      rpc: async (name: string) => {
        if (name === "resolve_active_studio_sms_sender") {
          rpcs += 1;
          return { data: null, error: { message: "down" } };
        }
        return { data: null, error: null };
      },
    } as unknown as SupabaseClient;

    const started = Date.now();
    for (let i = 0; i < 10; i += 1) {
      await send24hReminderSmsToClient(args(admin));
    }
    expect(rpcs).toBe(10);
    // Generous ceiling; the point is that no per-row backoff accumulated.
    expect(Date.now() - started).toBeLessThan(400);
  });

  it("EVERY kind still makes zero provider calls and zero claims", async () => {
    const mod = await import("@/lib/sms/send-appointment");
    const senders = [
      mod.sendBookingConfirmationSmsToClient,
      mod.send24hReminderSmsToClient,
      mod.send2hReminderSmsToClient,
    ];
    for (const fn of senders) {
      const s = scriptedAdmin([{ data: null, error: { message: "down" } }]);
      const r = await fn(args(s.admin));
      expect(r.ok).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(
        s.rpc.mock.calls.filter((c) => c[0] === "claim_sms_send"),
      ).toHaveLength(0);
    }
  });

  it("reminders still SEND normally when the sender resolves", async () => {
    const { send24hReminderSmsToClient } = await import(
      "@/lib/sms/send-appointment"
    );
    const s = scriptedAdmin([{ data: [{ messaging_service_sid: SID }] }]);
    const r = await send24hReminderSmsToClient(args(s.admin));
    expect(r.ok).toBe(true);
    expect(s.resolveCount()).toBe(1);
  });
});

// --- resolver attempt accounting -------------------------------------------

describe("resolve_attempts reports the MEASURED call count", () => {
  /**
   * Reads `resolve_attempts` off the structured refusal line, which is what an
   * operator actually sees. Asserting the telemetry rather than only the stub
   * call count is the point: the defect was a REPORTING one, and a test that
   * only counted RPCs would have stayed green through it.
   */
  async function refusalTelemetry(
    send: (a: ReturnType<typeof args>) => Promise<unknown>,
    script: Array<{ data: unknown; error?: unknown }>,
  ) {
    const lines: string[] = [];
    const err = vi.spyOn(console, "error").mockImplementation((m) => {
      lines.push(String(m));
    });
    const info = vi.spyOn(console, "info").mockImplementation((m) => {
      lines.push(String(m));
    });
    const s = scriptedAdmin(script);
    await send(args(s.admin));
    const parsed = lines
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    // The SYNCHRONOUS refusal line. The durable ops_alert is written
    // fire-and-forget, so it is not guaranteed to have been emitted yet; this
    // line always has been.
    const refusal = parsed.find((o) => o.event === "sms_routing_refused");
    err.mockRestore();
    info.mockRestore();
    return {
      resolverCalls: s.resolveCount(),
      reported: refusal?.resolveAttempts,
      reason: refusal?.reason,
    };
  }

  it("A — immediate no_active_sender: 1 call, reports 1", async () => {
    const r = await refusalTelemetry(sendBookingConfirmationSmsToClient, [
      { data: [] },
    ]);
    expect(r.resolverCalls).toBe(1);
    expect(r.reported).toBe(1);
    expect(r.reason).toBe("sms_sender_not_active_for_studio");
  });

  it("B — read_failed then no_active_sender: 2 calls, reports 2", async () => {
    // The exact case the derived logic got wrong: it reported 1.
    const r = await refusalTelemetry(sendBookingConfirmationSmsToClient, [
      { data: null, error: { message: "blip" } },
      { data: [] },
    ]);
    expect(r.resolverCalls).toBe(2);
    expect(r.reported).toBe(2);
    expect(r.reason).toBe("sms_sender_not_active_for_studio");
  });

  it("C — read_failed, read_failed, ambiguous: 3 calls, reports 3", async () => {
    const r = await refusalTelemetry(sendBookingConfirmationSmsToClient, [
      { data: null, error: { message: "blip" } },
      { data: null, error: { message: "blip" } },
      {
        data: [
          { messaging_service_sid: "MGa0000000000000000000000000000" },
          { messaging_service_sid: "MGb0000000000000000000000000000" },
        ],
      },
    ]);
    expect(r.resolverCalls).toBe(3);
    expect(r.reported).toBe(3);
    expect(r.reason).toBe("sms_sender_ambiguous");
  });

  it("D — persistent confirmation read_failed: hits the ceiling, reports it", async () => {
    const r = await refusalTelemetry(sendBookingConfirmationSmsToClient, [
      { data: null, error: { message: "down" } },
    ]);
    expect(r.resolverCalls).toBe(3);
    expect(r.reported).toBe(3);
    expect(r.reported).toBe(r.resolverCalls);
  });

  it("E — reminder_24h read_failed: 1 call, reports 1", async () => {
    const mod = await import("@/lib/sms/send-appointment");
    const r = await refusalTelemetry(mod.send24hReminderSmsToClient, [
      { data: null, error: { message: "down" } },
    ]);
    expect(r.resolverCalls).toBe(1);
    expect(r.reported).toBe(1);
  });

  it("F — reminder_2h read_failed: 1 call, reports 1", async () => {
    const mod = await import("@/lib/sms/send-appointment");
    const r = await refusalTelemetry(mod.send2hReminderSmsToClient, [
      { data: null, error: { message: "down" } },
    ]);
    expect(r.resolverCalls).toBe(1);
    expect(r.reported).toBe(1);
  });

  it("the reported count ALWAYS equals the calls actually made", async () => {
    const scripts: Array<Array<{ data: unknown; error?: unknown }>> = [
      [{ data: [] }],
      [{ data: null, error: { message: "x" } }, { data: [] }],
      [{ data: "malformed" as unknown }],
      [{ data: null, error: { message: "x" } }],
    ];
    for (const script of scripts) {
      const r = await refusalTelemetry(sendBookingConfirmationSmsToClient, script);
      expect(r.reported, JSON.stringify(script)).toBe(r.resolverCalls);
    }
  });

  it("is never inferred from the reason — transient and count are independent", async () => {
    // A transient-looking FINAL reason with one call, and a terminal final
    // reason with several, both report truthfully.
    const oneCallTransient = await refusalTelemetry(
      (await import("@/lib/sms/send-appointment")).send2hReminderSmsToClient,
      [{ data: null, error: { message: "x" } }],
    );
    expect(oneCallTransient.reason).toBe("sms_sender_read_failed");
    expect(oneCallTransient.reported).toBe(1);

    const manyCallsTerminal = await refusalTelemetry(
      sendBookingConfirmationSmsToClient,
      [{ data: null, error: { message: "x" } }, { data: [] }],
    );
    expect(manyCallsTerminal.reason).toBe("sms_sender_not_active_for_studio");
    expect(manyCallsTerminal.reported).toBe(2);
  });
});
