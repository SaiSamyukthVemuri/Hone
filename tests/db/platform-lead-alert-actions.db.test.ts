import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, closePool } from "./helpers/harness";
import { E2E_SUPABASE_URL, E2E_SERVICE_ROLE_KEY } from "@/e2e/helpers/local-env";

// ===========================================================================
// LEAD-ALERT-01 (#826): the REAL public actions (/demo and early access)
// against the real migrated database, with only the request context mocked:
// the request headers, Next's `after()` (captured, then run by the test), and
// the rate limiter's answer. The alert email itself goes through the existing
// fake Resend transport (HONE_E2E_FAKE_RESEND), never a provider.
//
//   * a refused (rate-limited or invalid) submission saves nothing and queues
//     no email;
//   * an accepted one saves the lead and its alert and queues ONE send, after
//     the response;
//   * a duplicate early-access address saves nothing and queues nothing, and
//     still reads as success;
//   * a failed lead write reports failure and queues nothing;
//   * a failing alert never changes the answer, and the lead survives it;
//   * fields a client adds to the payload choose nothing.
// ===========================================================================

const ctx = vi.hoisted(() => ({
  afterQueue: [] as Array<() => unknown>,
  allowed: true,
  limiterCalls: 0,
}));

vi.mock("next/server", () => ({
  after: (fn: () => unknown) => {
    ctx.afterQueue.push(fn);
  },
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.7" }),
}));
vi.mock("@/lib/rate-limit/public", () => ({
  RATE_LIMIT_MESSAGE: "Too many requests right now. Please wait a moment and try again.",
  limitDemoRequestSubmit: async () => {
    ctx.limiterCalls += 1;
    return { allowed: ctx.allowed };
  },
  limitWaitlistSubmit: async () => {
    ctx.limiterCalls += 1;
    return { allowed: ctx.allowed };
  },
}));

if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === "undefined") {
  (globalThis as { WebSocket?: unknown }).WebSocket = class WebSocketStub {};
}

const DOMAIN = "lead-alert-action.test";
const OPS = "success+lead-ops@harness.local";
const REJECT = "reject+lead-ops@harness.local";
const ENV_KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "HONE_E2E_FAKE_RESEND",
  "HONE_E2E_FAKE_RESEND_MODE",
  "LEAD_ALERT_EMAIL",
  "ADMIN_EMAILS",
  "NEXT_PUBLIC_APP_ORIGIN",
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let submitDemoRequest: typeof import("@/app/actions/demo")["submitDemoRequest"];
let submitWaitlistEntry: typeof import("@/app/actions/waitlist")["submitWaitlistEntry"];

beforeAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = E2E_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = E2E_SERVICE_ROLE_KEY;
  process.env.HONE_E2E_FAKE_RESEND = "1";
  delete process.env.HONE_E2E_FAKE_RESEND_MODE;
  process.env.ADMIN_EMAILS = `${OPS},${REJECT}`;
  process.env.LEAD_ALERT_EMAIL = OPS;
  process.env.NEXT_PUBLIC_APP_ORIGIN = "https://console.lead-alert-action.test";
  ({ submitDemoRequest } = await import("@/app/actions/demo"));
  ({ submitWaitlistEntry } = await import("@/app/actions/waitlist"));
});

afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await closePool();
});

beforeEach(async () => {
  ctx.afterQueue.length = 0;
  ctx.allowed = true;
  ctx.limiterCalls = 0;
  process.env.LEAD_ALERT_EMAIL = OPS;
  process.env.NEXT_PUBLIC_SUPABASE_URL = E2E_SUPABASE_URL;
  await adminQuery("delete from public.platform_lead_alerts");
  await adminQuery("delete from public.demo_requests where email like $1", [`%@${DOMAIN}`]);
  await adminQuery("delete from public.waitlist where email like $1", [`%@${DOMAIN}`]);
});

const address = () => `lead-${randomUUID().slice(0, 8)}@${DOMAIN}`;

function demoPayload(email: string) {
  return {
    name: "Riley Prospect",
    email,
    practice_name: "Birch Studio",
    location: "Ottawa",
    practice_type: "both" as const,
    practitioner_count: "5+" as const,
    current_tool: "",
    notes: "We open in March.",
  };
}

async function leadsFor(email: string) {
  return (await adminQuery(
    "select d.id, d.status, a.id as alert_id, a.status as alert_status, a.provider_message_id, a.last_error_code from public.demo_requests d left join public.platform_lead_alerts a on a.demo_request_id = d.id where d.email = $1",
    [email],
  )).rows;
}

async function runAfter() {
  const queued = ctx.afterQueue.splice(0);
  for (const fn of queued) await fn();
  return queued.length;
}

describe("/demo: submitDemoRequest", () => {
  it("rate-limited: refused, nothing saved, no email queued", async () => {
    ctx.allowed = false;
    const email = address();
    const result = await submitDemoRequest(demoPayload(email));
    expect(result).toEqual({
      ok: false,
      error: "Too many requests right now. Please wait a moment and try again.",
    });
    expect(await leadsFor(email)).toEqual([]);
    expect(ctx.afterQueue).toHaveLength(0);
  });

  it("invalid: refused before the limiter, nothing saved, nothing queued", async () => {
    const result = await submitDemoRequest(demoPayload("not-an-address"));
    expect(result).toEqual({ ok: false, error: "Enter an email address we can reply to." });
    expect(ctx.limiterCalls).toBe(0);
    expect(ctx.afterQueue).toHaveLength(0);
  });

  it("accepted: the lead and its alert are saved before the answer; ONE email goes after it", async () => {
    const email = address();
    expect(await submitDemoRequest(demoPayload(email))).toEqual({ ok: true });
    const [row] = await leadsFor(email);
    expect(row).toMatchObject({ status: "new", alert_status: "pending" });
    expect(ctx.afterQueue).toHaveLength(1);
    expect(await runAfter()).toBe(1);
    const [sent] = await leadsFor(email);
    expect(sent).toMatchObject({ alert_status: "accepted", provider_message_id: "fake-resend-message-id" });
  });

  it("the same person again is a new lead with its own alert (the limiter bounds repeats)", async () => {
    const email = address();
    await submitDemoRequest(demoPayload(email));
    await submitDemoRequest(demoPayload(email));
    const rows = await leadsFor(email);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.alert_id)).size).toBe(2);
    expect(ctx.afterQueue).toHaveLength(2);
  });

  it("a failing alert never changes the answer, and the lead survives it", async () => {
    process.env.LEAD_ALERT_EMAIL = REJECT;
    const email = address();
    expect(await submitDemoRequest(demoPayload(email))).toEqual({ ok: true });
    await runAfter();
    const [row] = await leadsFor(email);
    expect(row).toMatchObject({ status: "new", alert_status: "failed", last_error_code: "provider_rejected" });
  });

  it("missing recipient configuration: the lead is saved and its alert waits, visibly", async () => {
    delete process.env.LEAD_ALERT_EMAIL;
    const email = address();
    expect(await submitDemoRequest(demoPayload(email))).toEqual({ ok: true });
    await runAfter();
    const [row] = await leadsFor(email);
    expect(row).toMatchObject({ alert_status: "pending", last_error_code: "recipient_not_configured" });
  });

  it("a failed lead write reports failure and queues nothing", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:9";
    const email = address();
    const result = await submitDemoRequest(demoPayload(email));
    expect(result.ok).toBe(false);
    expect(ctx.afterQueue).toHaveLength(0);
    process.env.NEXT_PUBLIC_SUPABASE_URL = E2E_SUPABASE_URL;
    expect(await leadsFor(email)).toEqual([]);
  });

  it("fields a client adds to the payload choose nothing: no recipient, no status", async () => {
    const email = address();
    const forged = {
      ...demoPayload(email),
      to: "attacker@evil.example",
      recipient: "attacker@evil.example",
      bcc: "attacker@evil.example",
      status: "contacted",
      alert_status: "accepted",
    };
    expect(await submitDemoRequest(forged as unknown as ReturnType<typeof demoPayload>)).toEqual({ ok: true });
    await runAfter();
    const [row] = await leadsFor(email);
    expect(row).toMatchObject({ status: "new", alert_status: "accepted" });
  });
});

describe("early access: submitWaitlistEntry", () => {
  async function earlyFor(email: string) {
    return (await adminQuery(
      "select w.id, a.status as alert_status from public.waitlist w left join public.platform_lead_alerts a on a.waitlist_id = w.id where w.email = $1",
      [email],
    )).rows;
  }

  it("a new address: saved with its alert, ONE email after the answer", async () => {
    const email = address();
    expect(await submitWaitlistEntry(`  ${email.toUpperCase()} `)).toEqual({ ok: true });
    expect(await earlyFor(email)).toEqual([expect.objectContaining({ alert_status: "pending" })]);
    expect(await runAfter()).toBe(1);
    expect(await earlyFor(email)).toEqual([expect.objectContaining({ alert_status: "accepted" })]);
  });

  it("the same address again: success, but nothing new saved and no email", async () => {
    const email = address();
    await submitWaitlistEntry(email);
    await runAfter();
    expect(await submitWaitlistEntry(email.toUpperCase())).toEqual({ ok: true });
    expect(ctx.afterQueue).toHaveLength(0);
    expect(await earlyFor(email)).toHaveLength(1);
    expect(Number((await adminQuery("select count(*) n from public.platform_lead_alerts")).rows[0].n)).toBe(1);
  });

  it("rate-limited: refused, nothing saved, nothing queued", async () => {
    ctx.allowed = false;
    const email = address();
    expect((await submitWaitlistEntry(email)).ok).toBe(false);
    expect(await earlyFor(email)).toEqual([]);
    expect(ctx.afterQueue).toHaveLength(0);
  });
});
