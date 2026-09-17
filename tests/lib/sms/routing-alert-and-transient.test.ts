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
